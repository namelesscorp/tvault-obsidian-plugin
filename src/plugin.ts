import { Notice, Plugin } from "obsidian";
import { spawn } from "child_process";
import { constants as fsConstants } from "fs";
import { access, chmod, copyFile, mkdir, rm } from "fs/promises";
import path from "path";
import {
  ContainerInfo,
  DEFAULT_SETTINGS,
  IntegrityType,
  OpInput,
  Operation,
  RunResult,
  RunSpec,
  TokenType,
  TVaultSettings,
  TVaultStateFile,
  VaultStatus,
  VIEW_TYPE_TVAULT,
  STATE_FILE,
  STAGE_DIR,
} from "./types";
import {
  errorMessage,
  extractJsonWithKey,
  extractTokenList,
  generateEntropyPassphrase,
  normalizeTokensToFlag,
  parseTokenList,
} from "./util";
import { buildArgs, cliBinaryName, downloadCli, extractCliError, verifyChecksum } from "./cli";
import { SessionKeyStore, readTokenFileList } from "./session-keys";
import { discardStage, listNoteEntries, stageNotes, unstageNotes } from "./staging";
import { VaultPaths } from "./paths";
import { ConfirmModal, SecretModal } from "./modals";
import { TVaultView } from "./view";
import { TVaultSettingTab } from "./settings";

export default class TVaultPlugin extends Plugin {
  settings: TVaultSettings = DEFAULT_SETTINGS;
  private running = false;
  private statusEl: HTMLElement | null = null;

  // Session-only keys held in memory (see SessionKeyStore); cleared on unload.
  private readonly sessionKeys = new SessionKeyStore(() => this.settings.rememberKeysForSession);
  // Vault / container / token / CLI path resolution.
  private readonly paths = new VaultPaths(this.app, this.manifest, () => this.settings);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.statusEl = this.addStatusBarItem();
    this.setStatus("TVault: ready");

    // Recover notes left in staging by an interrupted lock before anything else
    // touches the vault.
    await this.recoverStage();

    this.registerView(VIEW_TYPE_TVAULT, (leaf) => new TVaultView(leaf, this));
    this.addRibbonIcon("shield", "Open TVault panel", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-tvault-panel",
      name: "Open TVault panel",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "lock-vault",
      name: "Lock vault (encrypt and remove plaintext)",
      callback: () => void this.commandLock(false),
    });
    this.addCommand({
      id: "unlock-vault",
      name: "Unlock vault (restore plaintext)",
      callback: () => void this.commandUnlock(),
    });
    this.addCommand({
      id: "lock-and-close-vault",
      name: "Lock and close vault",
      callback: () => void this.commandLock(true),
    });

    this.addSettingTab(new TVaultSettingTab(this.app, this));
  }

  onunload(): void {
    this.forgetSessionKeys();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TVAULT);
  }

  // ---- session key cache (delegates to SessionKeyStore) ----------------------

  hasSessionKeys(containerPath: string): boolean {
    return this.sessionKeys.has(containerPath);
  }

  forgetSessionKeys(containerPath?: string): void {
    this.sessionKeys.forget(containerPath);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_TVAULT)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) {
        new Notice("TVault: unable to open side panel");
        return;
      }
      leaf = right;
      await leaf.setViewState({ type: VIEW_TYPE_TVAULT, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  isRunning(): boolean {
    return this.running;
  }

  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text);
  }

  // ---- CLI resolution --------------------------------------------------------

  // resolveCli - an explicit settings path always wins. Otherwise the platform
  // binary is fetched once from the pinned tvault-core release, checksum-verified,
  // cached under the plugin's bin/, and reused thereafter.
  private async resolveCli(): Promise<string> {
    const configured = this.settings.cliPath?.trim() ?? "";
    if (configured && configured.includes(path.sep)) {
      const resolved = this.paths.resolveConfiguredPath(configured);
      try {
        await access(resolved, fsConstants.X_OK);
      } catch {
        throw new Error(`tvault-core is not executable at ${resolved}`);
      }
      return resolved;
    }

    const name = cliBinaryName();
    const dest = this.paths.cliCachePath();
    if (await this.pathExists(dest)) {
      if (await verifyChecksum(dest, name)) {
        await chmod(dest, 0o755).catch(() => undefined);
        return dest;
      }
      // Tampered or stale cache — discard and re-download.
      await rm(dest, { force: true }).catch(() => undefined);
    }

    await downloadCli(name, dest);
    if (!(await verifyChecksum(dest, name))) {
      await rm(dest, { force: true }).catch(() => undefined);
      throw new Error("Downloaded tvault-core failed checksum verification");
    }
    await chmod(dest, 0o755);
    return dest;
  }

  private async containerExists(containerPath: string): Promise<boolean> {
    try {
      await access(containerPath, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async pathExists(target: string): Promise<boolean> {
    try {
      await access(target, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async recoverStage(): Promise<void> {
    let vaultPath: string;
    try {
      vaultPath = this.paths.getVaultPath();
    } catch {
      return; // not a desktop filesystem vault
    }
    if (!(await this.pathExists(path.join(vaultPath, STAGE_DIR)))) {
      return; // no leftover staging
    }
    try {
      await unstageNotes(vaultPath);
      new Notice("TVault: recovered notes from an interrupted lock");
    } catch (error) {
      const message = errorMessage(error);
      // Persistent notice (timeout 0): the user must resolve this before data is safe.
      new Notice(`TVault: could not fully recover staged notes — ${message}`, 0);
      console.error("TVault recoverStage failed", error);
    }
  }

  // ---- state file ------------------------------------------------------------

  private statePath(): string {
    return `${this.paths.configDirName()}/${STATE_FILE}`;
  }

  private async writeState(state: TVaultStateFile): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.statePath(), JSON.stringify(state, null, 2));
    } catch (error) {
      console.error("TVault: failed to write state", error);
    }
  }

  // ---- container inspection --------------------------------------------------

  async containerInfo(containerPath: string): Promise<ContainerInfo | null> {
    const stdout = await this.execCli([
      "container",
      "info",
      `-path=${containerPath}`,
      "info-writer",
      "-type=stdout",
      "-format=json",
      "log-writer",
      "-type=stdout",
      "-format=json",
    ]);
    const obj = extractJsonWithKey(stdout, "file_count");
    if (obj && typeof obj.file_count === "number") {
      const num = (value: unknown): number => (typeof value === "number" ? value : 0);
      return {
        name: String(obj.name ?? ""),
        version: num(obj.version),
        created_at: String(obj.created_at ?? ""),
        updated_at: String(obj.updated_at ?? ""),
        comment: String(obj.comment ?? ""),
        tags: Array.isArray(obj.tags) ? obj.tags.map((tag) => String(tag)) : [],
        token_type: String(obj.token_type ?? ""),
        integrity_provider_type: String(obj.integrity_provider_type ?? ""),
        compression_type: String(obj.compression_type ?? ""),
        shares: num(obj.shares),
        threshold: num(obj.threshold),
        file_count: obj.file_count,
        compressed_size: num(obj.compressed_size),
        uncompressed_size: num(obj.uncompressed_size),
        security_score: num(obj.security_score),
      };
    }
    return null;
  }

  // ---- status ----------------------------------------------------------------

  async computeStatus(): Promise<VaultStatus> {
    const vaultPath = this.paths.getVaultPath();
    const containerPath = this.paths.effectiveContainerPath(vaultPath);
    const containerExists = await this.containerExists(containerPath);

    let tokenType: TokenType = this.settings.tokenType;
    let integrityType: IntegrityType = this.settings.integrityEnabled ? "hmac" : "none";
    let info: ContainerInfo | null = null;

    // A leftover staging directory means an interrupted lock whose recovery has
    // not completed. Report "unknown" so the panel blocks operations that could
    // overwrite the staged plaintext (e.g. an unseal onto it).
    if (await this.pathExists(path.join(vaultPath, STAGE_DIR))) {
      return {
        state: "unknown",
        operation: "seal",
        containerExists,
        containerPath,
        noteCount: 0,
        tokenType,
        integrityType,
        info,
      };
    }

    if (containerExists) {
      info = await this.containerInfo(containerPath).catch(() => null);
      if (
        info &&
        (info.token_type === "share" || info.token_type === "master" || info.token_type === "none")
      ) {
        tokenType = info.token_type;
      }
      if (info) {
        integrityType = info.integrity_provider_type === "hmac" ? "hmac" : "none";
      }
    }

    const noteCount = (await listNoteEntries(vaultPath, this.paths.configDirName())).length;
    if (noteCount > 0) {
      return {
        state: "unlocked",
        operation: containerExists ? "reseal" : "seal",
        containerExists,
        containerPath,
        noteCount,
        tokenType,
        integrityType,
        info,
      };
    }
    if (containerExists) {
      return {
        state: "locked",
        operation: "unseal",
        containerExists,
        containerPath,
        noteCount,
        tokenType,
        integrityType,
        info,
      };
    }
    return {
      state: "empty",
      operation: "seal",
      containerExists,
      containerPath,
      noteCount,
      tokenType,
      integrityType,
      info,
    };
  }

  // ---- CLI execution ---------------------------------------------------------

  // run - execute one CLI operation. The `running` guard is held by the caller
  // (lock/unlock/command) across the whole higher-level operation, so run()
  // itself does not touch it.
  private async run(spec: RunSpec): Promise<RunResult> {
    const vaultPath = this.paths.getVaultPath();
    const containerPath = this.paths.resolveContainerPath(vaultPath);
    if (spec.operation === "seal") {
      await mkdir(path.dirname(containerPath), { recursive: true });
    } else {
      await access(containerPath, fsConstants.R_OK);
    }

    const cli = await this.resolveCli();
    const args = buildArgs(spec, vaultPath, containerPath);

    this.setStatus(`TVault: ${spec.operation} 0%`);
    try {
      const stdout = await this.spawnCli(cli, args, spec.folderPathOverride ?? vaultPath, spec);
      this.setStatus(`TVault: ${spec.operation} done`);
      return { tokens: extractTokenList(stdout), stdout };
    } catch (error) {
      this.setStatus("TVault: error");
      throw error;
    }
  }

  // withLock - run an async op under the single-operation guard, set atomically
  // (no await between the check and the set) so two concurrent callers can never
  // both proceed.
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running) {
      throw new Error("A TVault operation is already running");
    }
    this.running = true;
    try {
      return await fn();
    } finally {
      this.running = false;
    }
  }

  private spawnCli(cli: string, args: string[], cwd: string, spec: RunSpec): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cli, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let lineBuffer = "";

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        lineBuffer += text;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^PROGRESS\s+(\d{1,3})$/.exec(line.trim());
          if (match) {
            const percent = Number.parseInt(match[1], 10);
            this.setStatus(`TVault: ${spec.operation} ${percent}%`);
            spec.onProgress?.(percent);
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      // A hung CLI would otherwise leave the operation guard stuck forever.
      const timer = setTimeout(
        () => {
          child.kill();
          reject(new Error("tvault-core timed out"));
        },
        30 * 60 * 1000,
      );
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(extractCliError(stderr || stdout, code)));
      });
    });
  }

  // execCli - run a non-streaming CLI command (e.g. container info) and return
  // stdout, rejecting on a non-zero exit.
  private async execCli(args: string[]): Promise<string> {
    const cli = await this.resolveCli();
    return new Promise((resolve, reject) => {
      const child = spawn(cli, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("tvault-core timed out"));
      }, 60 * 1000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve(stdout) : reject(new Error(extractCliError(stderr || stdout, code)));
      });
    });
  }

  // ---- token I/O resolution --------------------------------------------------

  private buildTokenIO(
    operation: Operation,
    tokenType: TokenType,
    input: OpInput,
    vaultPath: string,
  ): { tokenIO: "flag" | "file"; tokensFlag: string; tokenFilePath: string } {
    const tokenFilePath =
      this.paths.resolveConfiguredPath(input.tokenFilePath) ||
      this.paths.resolveConfiguredPath(this.settings.tokenPath) ||
      this.paths.defaultTokenPath(vaultPath);

    if (tokenType === "none") {
      return { tokenIO: "flag", tokensFlag: "", tokenFilePath };
    }
    if (input.useTokenFile) {
      if (!this.paths.isSafeVaultSideLocation(vaultPath, tokenFilePath)) {
        throw new Error(
          "The token file must be outside the vault or inside its .obsidian config folder",
        );
      }
      return { tokenIO: "file", tokensFlag: "", tokenFilePath };
    }
    if (operation === "seal") {
      // Tokens are generated on seal; nothing to read.
      return { tokenIO: "flag", tokensFlag: "", tokenFilePath };
    }
    const normalized = normalizeTokensToFlag(input.tokensText);
    if (normalized.count === 0) {
      throw new Error("Paste at least one token to unlock or re-lock a share/master vault");
    }
    return { tokenIO: "flag", tokensFlag: normalized.flag, tokenFilePath };
  }

  // ---- lock / unlock ---------------------------------------------------------

  // lock - encrypt the vault's notes into the container, verify the container,
  // then remove the plaintext. Uses seal for a fresh container and reseal for an
  // existing one. Notes are never lost: they stay in staging until the container
  // is verified, and are restored if anything fails.
  async lock(
    input: OpInput,
  ): Promise<{ tokens: string[] | null; operation: Operation; tokenType: TokenType }> {
    return this.withLock(async () => {
      const vaultPath = this.paths.getVaultPath();
      const containerPath = this.paths.resolveContainerPath(vaultPath);

      // Never stage on top of a leftover stage from an interrupted lock.
      if (await this.pathExists(path.join(vaultPath, STAGE_DIR))) {
        throw new Error(
          `Staged notes from a previous lock are present in ${STAGE_DIR} — reload the plugin to recover them first`,
        );
      }

      const exists = await this.containerExists(containerPath);
      const operation: Operation = exists ? "reseal" : "seal";

      // The container's own header is authoritative for its token and integrity
      // types; a fresh seal takes them from the caller's choices.
      let tokenType = input.tokenType;
      let integrityType: IntegrityType = input.integrityEnabled ? "hmac" : "none";
      if (exists) {
        const info = await this.containerInfo(containerPath).catch(() => null);
        if (
          info &&
          (info.token_type === "share" ||
            info.token_type === "master" ||
            info.token_type === "none")
        ) {
          tokenType = info.token_type;
        }
        if (info) {
          integrityType = info.integrity_provider_type === "hmac" ? "hmac" : "none";
        }
      }

      // share/master: the container passphrase is a backdoor to the Shamir key,
      // so it is auto-generated with full entropy and never surfaced (the tokens,
      // not this passphrase, open the vault). The integrity passphrase encrypts
      // the tokens themselves and is required only when integrity is HMAC.
      // none: the container passphrase IS the only secret and is user-supplied.
      const isTokenMode = tokenType !== "none";
      const containerPassphrase = isTokenMode
        ? input.containerEntropy || generateEntropyPassphrase()
        : input.containerPassphrase;

      // A reseal needs the existing tokens/integrity passphrase. If the user did
      // not re-enter them, fall back to the keys held from this session.
      const remembered =
        isTokenMode && operation === "reseal" && !input.useTokenFile
          ? this.sessionKeys.recall(containerPath)
          : undefined;
      const effectiveTokensText =
        remembered && parseTokenList(input.tokensText).length === 0
          ? remembered.tokens.join("\n")
          : input.tokensText;
      const integrity = isTokenMode
        ? input.integrityPassphrase || remembered?.integrityPassphrase || ""
        : input.containerPassphrase;

      if (tokenType === "none" && !input.containerPassphrase) {
        throw new Error("Container passphrase is required");
      }
      if (isTokenMode && integrityType === "hmac" && !integrity) {
        throw new Error("Token (integrity) passphrase is required");
      }

      const { tokenIO, tokensFlag, tokenFilePath } = this.buildTokenIO(
        operation,
        tokenType,
        { ...input, tokensText: effectiveTokensText },
        vaultPath,
      );

      // The CLI's file writer does not create parent directories.
      if (tokenIO === "file") {
        await mkdir(path.dirname(tokenFilePath), { recursive: true });
      }

      const noteEntries = await listNoteEntries(vaultPath, this.paths.configDirName());
      if (noteEntries.length === 0) {
        throw new Error("Vault has no notes to lock");
      }

      // A reseal rewrites the token file in place; back it up so a mid-write
      // failure cannot destroy the user's only copy of the tokens.
      let tokenBackup = "";
      if (operation === "reseal" && tokenIO === "file" && (await this.pathExists(tokenFilePath))) {
        tokenBackup = `${tokenFilePath}.tvault-bak`;
        await copyFile(tokenFilePath, tokenBackup);
      }

      try {
        const { stageDir, fileCount } = await stageNotes(vaultPath, noteEntries);
        const result = await this.run({
          operation,
          tokenType,
          integrityType,
          containerPassphrase,
          integrityPassphrase: integrity,
          tokenIO,
          tokensFlag,
          tokenFilePath,
          shares: input.shares,
          threshold: input.threshold,
          folderPathOverride: stageDir,
          onProgress: input.onProgress,
        });

        // Verify the container actually captured every staged file before
        // deleting the only plaintext copy.
        const info = await this.containerInfo(containerPath).catch(() => null);
        if (!info || info.file_count !== fileCount) {
          throw new Error(
            `Container verification failed (expected ${fileCount} files, container reports ${info?.file_count ?? "unknown"}). Plaintext kept.`,
          );
        }

        await discardStage(vaultPath);
        await this.writeState({
          sealed: true,
          containerPath: this.settings.containerPath,
          tokenType,
          fileCount,
          updatedAt: info.updated_at,
        });
        if (tokenBackup) {
          await rm(tokenBackup, { force: true }).catch(() => undefined);
        }
        // Hold the keys for the rest of the session so the next lock/unlock does
        // not ask for them again.
        if (isTokenMode) {
          const held =
            operation === "seal"
              ? (result.tokens ?? [])
              : tokenIO === "file"
                ? await readTokenFileList(tokenFilePath)
                : parseTokenList(effectiveTokensText);
          this.sessionKeys.remember(containerPath, held, integrity);
        }
        return { tokens: result.tokens, operation, tokenType };
      } catch (error) {
        // Restore the token file if a reseal may have clobbered it.
        if (tokenBackup) {
          await copyFile(tokenBackup, tokenFilePath).catch(() => undefined);
          await rm(tokenBackup, { force: true }).catch(() => undefined);
        }
        // Restore plaintext so a failed lock never loses data.
        await unstageNotes(vaultPath).catch((restoreError) => {
          const message = errorMessage(restoreError);
          console.error("TVault: failed to restore staged notes", restoreError);
          new Notice(`TVault: ${message}`, 0);
        });
        throw error;
      }
    });
  }

  // unlock - restore the vault's notes from the container. The container is not
  // modified. Its token type is read from the header, so the caller need not
  // know it in advance.
  async unlock(input: OpInput): Promise<{ tokenType: TokenType }> {
    return this.withLock(async () => {
      const vaultPath = this.paths.getVaultPath();
      const containerPath = this.paths.resolveContainerPath(vaultPath);
      if (!(await this.containerExists(containerPath))) {
        throw new Error("No container to unlock — seal one first");
      }

      // Refuse to unseal onto staged plaintext, which would overwrite it.
      if (await this.pathExists(path.join(vaultPath, STAGE_DIR))) {
        throw new Error(
          `Staged notes from a previous lock are present in ${STAGE_DIR} — reload the plugin to recover them first`,
        );
      }

      const info = await this.containerInfo(containerPath).catch(() => null);
      let tokenType = input.tokenType;
      if (
        info &&
        (info.token_type === "share" || info.token_type === "master" || info.token_type === "none")
      ) {
        tokenType = info.token_type;
      }
      const integrityType: IntegrityType =
        info?.integrity_provider_type === "hmac" ? "hmac" : "none";

      // none opens with the container passphrase; share/master open with the
      // tokens plus, when the container uses HMAC, the integrity passphrase that
      // encrypts them.
      const isTokenMode = tokenType !== "none";

      // If the user did not re-enter the tokens/integrity passphrase, fall back
      // to the keys held from this session.
      const remembered =
        isTokenMode && !input.useTokenFile ? this.sessionKeys.recall(containerPath) : undefined;
      const effectiveTokensText =
        remembered && parseTokenList(input.tokensText).length === 0
          ? remembered.tokens.join("\n")
          : input.tokensText;
      const integrity = isTokenMode
        ? input.integrityPassphrase || remembered?.integrityPassphrase || ""
        : "";
      if (tokenType === "none" && !input.containerPassphrase) {
        throw new Error("Container passphrase is required");
      }
      if (isTokenMode && integrityType === "hmac" && !integrity) {
        throw new Error("Token (integrity) passphrase is required");
      }

      const { tokenIO, tokensFlag, tokenFilePath } = this.buildTokenIO(
        "unseal",
        tokenType,
        { ...input, tokensText: effectiveTokensText },
        vaultPath,
      );

      await this.run({
        operation: "unseal",
        tokenType,
        integrityType,
        containerPassphrase: input.containerPassphrase,
        integrityPassphrase: integrity,
        tokenIO,
        tokensFlag,
        tokenFilePath,
        shares: input.shares,
        threshold: input.threshold,
        onProgress: input.onProgress,
      });

      // Hold the keys for the rest of the session so a later re-lock/unlock does
      // not ask for them again.
      if (isTokenMode) {
        const held =
          tokenIO === "file"
            ? await readTokenFileList(tokenFilePath)
            : parseTokenList(effectiveTokensText);
        this.sessionKeys.remember(containerPath, held, integrity);
      }

      await this.writeState({
        sealed: false,
        containerPath: this.settings.containerPath,
        tokenType,
        fileCount: info?.file_count ?? 0,
        updatedAt: info?.updated_at ?? "",
      });
      return { tokenType };
    });
  }

  // ---- command-palette flows (single passphrase + token file from settings) --

  private requestSecret(title: string, detail: string): Promise<string | null> {
    return new Promise((resolve) => {
      new SecretModal(this.app, title, detail, resolve).open();
    });
  }

  private commandOpInput(secret: string): OpInput {
    return {
      tokenType: this.settings.tokenType,
      integrityEnabled: this.settings.integrityEnabled,
      containerPassphrase: secret,
      integrityPassphrase: secret,
      tokensText: "",
      useTokenFile: true,
      tokenFilePath: "",
      shares: this.settings.shares,
      threshold: this.settings.threshold,
    };
  }

  private async commandLock(closeAfter: boolean): Promise<void> {
    if (this.running) {
      new Notice("A TVault operation is already running");
      return;
    }
    if (this.settings.confirmBeforeLock) {
      const confirmed = await new Promise<boolean>((resolve) => {
        new ConfirmModal(
          this.app,
          closeAfter ? "Lock and close vault?" : "Lock vault?",
          "The vault will be encrypted into the container and the plaintext removed after the container is verified. .obsidian is preserved.",
          closeAfter ? "Lock and close" : "Lock",
          resolve,
        ).open();
      });
      if (!confirmed) {
        return;
      }
    }
    const secret = await this.requestSecret(
      "Lock TVault",
      "Enter the passphrase. Share/master vaults read tokens from the file path in settings.",
    );
    if (secret === null) {
      return;
    }
    try {
      const result = await this.lock(this.commandOpInput(secret));
      if (result.tokens && result.tokens.length > 0) {
        new Notice(`TVault locked. ${result.tokens.length} token(s) written to the token file.`);
      } else {
        new Notice("TVault: vault locked");
      }
      if (closeAfter) {
        window.setTimeout(() => window.close(), 250);
      }
    } catch (error) {
      const message = errorMessage(error);
      new Notice(`TVault: ${message}`, 10000);
      console.error("TVault lock failed", error);
    }
  }

  private async commandUnlock(): Promise<void> {
    if (this.running) {
      new Notice("A TVault operation is already running");
      return;
    }
    const secret = await this.requestSecret(
      "Unlock TVault",
      "Enter the passphrase. Share/master vaults read tokens from the file path in settings.",
    );
    if (secret === null) {
      return;
    }
    try {
      await this.unlock(this.commandOpInput(secret));
      new Notice("TVault: vault unlocked");
    } catch (error) {
      const message = errorMessage(error);
      new Notice(`TVault: ${message}`, 10000);
      console.error("TVault unlock failed", error);
    }
  }
}

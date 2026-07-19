import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { writeFile } from "fs/promises";
import path from "path";
import type TVaultPlugin from "./plugin";
import { IntegrityType, OpInput, TokenType, VaultStatus, VIEW_TYPE_TVAULT } from "./types";
import { errorMessage, formatBytes, parseTokenList } from "./util";
import { browseForExistingFile, getElectronDialog, getElectronShell } from "./dialogs";
import { ConfirmModal, EntropyModal } from "./modals";

// TVaultView - the side panel. It shows the lock/unlock state and drives a
// single primary action; passphrases and pasted tokens are never persisted.
export class TVaultView extends ItemView {
  private readonly plugin: TVaultPlugin;

  private status: VaultStatus | null = null;
  private statusError: string | null = null;
  private tokenType: TokenType;
  private integrityEnabled: boolean;
  private containerPass = "";
  private integrityPass = "";
  private shares: number;
  private threshold: number;
  // One entry per token-input field (share/master unlock & reseal). Seeded lazily
  // from the threshold; the user can add/remove fields.
  private tokenInputs: string[] = [];
  private useTokenFile = false;
  private tokenFilePath = "";
  // When session keys are held, the token inputs are hidden until the user opts
  // to enter different keys.
  private useDifferentKeys = false;
  private busy = false;
  private statusLine = "";
  private generatedTokens: string[] | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TVaultPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.tokenType = plugin.settings.tokenType;
    this.integrityEnabled = plugin.settings.integrityEnabled;
    this.shares = plugin.settings.shares;
    this.threshold = plugin.settings.threshold;
    this.tokenFilePath = plugin.settings.tokenPath;
  }

  getViewType(): string {
    return VIEW_TYPE_TVAULT;
  }

  getDisplayText(): string {
    return "TrustVault";
  }

  getIcon(): string {
    return "shield";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.containerPass = "";
    this.integrityPass = "";
    this.tokenInputs = [];
    this.contentEl.empty();
  }

  private async refresh(): Promise<void> {
    // Default back to using held keys whenever the state is recomputed.
    this.useDifferentKeys = false;
    try {
      this.status = await this.plugin.computeStatus();
      this.statusError = null;
      // Keep the selector in sync with an existing container's token type.
      if (this.status.containerExists) {
        this.tokenType = this.status.tokenType;
      }
    } catch (error) {
      this.status = null;
      this.statusError = errorMessage(error);
    }
    this.render();
  }

  private setStatusLine(text: string): void {
    this.statusLine = text;
    const el = this.contentEl.querySelector(".tvault-status");
    if (el) {
      el.textContent = text;
    }
  }

  // The effective token type: for a fresh seal the user chooses; otherwise the
  // container's own type (surfaced via status) governs.
  private effectiveTokenType(): TokenType {
    if (this.status && this.status.containerExists) {
      return this.status.tokenType;
    }
    return this.tokenType;
  }

  // The effective integrity type: an existing container's own type governs; a
  // fresh seal follows the panel toggle.
  private effectiveIntegrityType(): IntegrityType {
    if (this.status && this.status.containerExists) {
      return this.status.integrityType;
    }
    return this.integrityEnabled ? "hmac" : "none";
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("tvault-panel");
    root.createEl("h3", { text: "TrustVault" });

    if (this.statusError) {
      root.createEl("p", { cls: "tvault-danger", text: this.statusError });
      root.createEl("p", {
        cls: "tvault-hint",
        text: "Set the container path in settings, then reopen this panel.",
      });
      this.renderStatusLine(root);
      return;
    }
    if (!this.status) {
      root.createEl("p", { text: "Loading…" });
      return;
    }

    this.renderBanner(root);
    this.renderContainerRow(root);
    this.renderContainerInfo(root);

    // Interrupted lock: notes are stranded in staging. Block normal actions and
    // offer recovery before anything can overwrite them.
    if (this.status.state === "unknown") {
      root.createEl("p", {
        cls: "tvault-danger",
        text:
          "An interrupted lock left notes in .tvault-stage. Recover them before " +
          "locking or unlocking.",
      });
      const recover = root.createEl("button", {
        text: this.busy ? "Working…" : "Recover staged notes",
        cls: "tvault-run mod-cta",
      });
      recover.disabled = this.busy;
      recover.addEventListener("click", () => void this.onRecover());
      this.renderStatusLine(root);
      return;
    }

    if (this.status.state === "empty") {
      root.createEl("p", {
        cls: "tvault-hint",
        text: "This vault has no notes and no container yet. Add notes, then lock.",
      });
    }

    const operation = this.status.operation;
    const tokenType = this.effectiveTokenType();
    const locking = this.status.state === "unlocked";
    const unlocking = this.status.state === "locked";

    // Token type is only user-selectable for a first-ever seal.
    if (operation === "seal") {
      const field = root.createDiv({ cls: "tvault-field" });
      field.createEl("label", { text: "Token type" });
      const select = field.createEl("select");
      (
        [
          ["share", "Share (Shamir)"],
          ["master", "Master"],
          ["none", "Passphrase only"],
        ] as [TokenType, string][]
      ).forEach(([value, label]) => {
        const opt = select.createEl("option", { text: label });
        opt.value = value;
        if (value === this.tokenType) {
          opt.selected = true;
        }
      });
      select.addEventListener("change", () => {
        this.tokenType = select.value as TokenType;
        this.render();
      });
    }

    const integrityType = this.effectiveIntegrityType();

    // Keys held from this session let a re-lock/unlock skip re-entering tokens
    // and the integrity passphrase.
    const keysHeld =
      tokenType !== "none" &&
      this.status.containerExists &&
      this.plugin.hasSessionKeys(this.status.containerPath);
    const usingHeld = keysHeld && !this.useDifferentKeys;

    // Container passphrase: only for none, where it is the sole secret. For
    // share/master the container key is auto-generated with full entropy.
    if (tokenType === "none") {
      this.passwordField(
        root,
        "Container passphrase",
        this.containerPass,
        (v) => (this.containerPass = v),
      );
    } else {
      // Integrity provider toggle — choosable only when creating the container.
      if (operation === "seal") {
        const toggle = root.createDiv({ cls: "tvault-field tvault-inline" });
        const checkbox = toggle.createEl("input", { type: "checkbox" });
        checkbox.checked = this.integrityEnabled;
        toggle.createEl("label", { text: "Protect tokens with an integrity passphrase (HMAC)" });
        checkbox.addEventListener("change", () => {
          this.integrityEnabled = checkbox.checked;
          this.render();
        });
      }

      if (integrityType === "hmac" && !usingHeld) {
        this.passwordField(
          root,
          "Integrity passphrase",
          this.integrityPass,
          (v) => (this.integrityPass = v),
          "Encrypts and verifies the tokens — required to unlock. Remember it.",
        );
      } else if (operation === "seal") {
        root.createEl("small", {
          cls: "tvault-hint",
          text: "Integrity off: the tokens alone unlock the vault (no passphrase). Keep them safe.",
        });
      }

      if (operation === "seal") {
        root.createEl("small", {
          cls: "tvault-hint",
          text: this.plugin.settings.collectEntropyByDrawing
            ? "The container key is gathered from your drawing + system entropy; the tokens are the only way in."
            : "The container key is generated with 256-bit entropy; the tokens are the only way in.",
        });
      }
    }

    // Shares / threshold only matter for a fresh share seal.
    if (tokenType === "share" && operation === "seal") {
      const grid = root.createDiv({ cls: "tvault-grid" });
      this.numberField(grid, "Shares", this.shares, (v) => (this.shares = v));
      this.numberField(grid, "Threshold", this.threshold, (v) => (this.threshold = v));
    }

    // Token source for share / master when opening an existing container.
    if (tokenType !== "none" && (unlocking || (locking && this.status.containerExists))) {
      if (usingHeld) {
        this.renderHeldKeys(root);
      } else {
        const toggle = root.createDiv({ cls: "tvault-field tvault-inline" });
        const checkbox = toggle.createEl("input", { type: "checkbox" });
        checkbox.checked = this.useTokenFile;
        toggle.createEl("label", { text: "Read tokens from a file instead of pasting" });
        checkbox.addEventListener("change", () => {
          this.useTokenFile = checkbox.checked;
          this.render();
        });

        if (this.useTokenFile) {
          this.browseFileField(
            root,
            "Token file path",
            this.tokenFilePath,
            (v) => (this.tokenFilePath = v),
            "~/TrustVault/my-vault.keys.json",
          );
        } else {
          this.renderTokenInputs(root);
        }

        // Offer to fall back to the held keys instead of the fields just shown.
        if (keysHeld) {
          const back = root.createEl("button", {
            text: "Use held keys instead",
            cls: "tvault-linklike",
          });
          back.addEventListener("click", () => {
            this.useDifferentKeys = false;
            this.render();
          });
        }
      }
    }

    // Primary action.
    const label =
      this.status.state === "unlocked"
        ? this.status.containerExists
          ? "Lock vault (re-encrypt)"
          : "Lock vault (encrypt)"
        : this.status.state === "locked"
          ? "Unlock vault"
          : "Add notes to lock";
    const btn = root.createEl("button", {
      text: this.busy ? "Working…" : label,
      cls: "tvault-run mod-cta",
    });
    btn.disabled = this.busy || this.status.state === "empty";
    btn.addEventListener("click", () => void this.onPrimary());

    const refreshBtn = root.createEl("button", { text: "Refresh state", cls: "tvault-refresh" });
    refreshBtn.disabled = this.busy;
    refreshBtn.addEventListener("click", () => void this.refresh());

    this.renderStatusLine(root);
    this.renderTokensOutput(root);
  }

  private renderBanner(root: HTMLElement): void {
    if (!this.status) {
      return;
    }
    const banner = root.createDiv({ cls: `tvault-banner tvault-banner-${this.status.state}` });
    const text =
      this.status.state === "locked"
        ? "Locked — vault is encrypted"
        : this.status.state === "unlocked"
          ? `Unlocked — ${this.status.noteCount} item(s) in the vault`
          : this.status.state === "unknown"
            ? "Interrupted lock — recovery needed"
            : "Empty vault";
    banner.createSpan({ text });
  }

  // Shows which container the panel acts on and lets the user point at another
  // one — important when the vault is locked and you want to choose the .tvlt to
  // unlock.
  private renderContainerRow(root: HTMLElement): void {
    if (!this.status) {
      return;
    }
    const field = root.createDiv({ cls: "tvault-field" });
    field.createEl("label", { text: "Container" });
    const row = field.createDiv({ cls: "tvault-browse-row" });
    const input = row.createEl("input", { type: "text", attr: { readonly: "true" } });
    input.value = this.status.containerPath;
    input.title = this.status.containerPath;
    const open = row.createEl("button", { text: "Open folder" });
    open.addEventListener("click", () => void this.onOpenContainerFolder());
  }

  // A collapsible read-only panel with everything `container info` reports about
  // the existing container.
  private renderContainerInfo(root: HTMLElement): void {
    const info = this.status?.info;
    if (!info) {
      return;
    }
    const details = root.createEl("details", { cls: "tvault-info" });
    details.createEl("summary", { text: "Container details" });

    const row = (label: string, value: string, valueCls?: string) => {
      if (!value) {
        return;
      }
      const line = details.createDiv({ cls: "tvault-info-row" });
      line.createSpan({ cls: "tvault-info-label", text: label });
      line.createSpan({ cls: `tvault-info-value${valueCls ? ` ${valueCls}` : ""}`, text: value });
    };

    const tokenLabel =
      info.token_type === "share"
        ? `Share (${info.threshold} of ${info.shares})`
        : info.token_type || "—";
    const scorePct = Math.round(info.security_score * 100);

    row("Name", info.name);
    row("Created", info.created_at);
    row("Last re-lock", info.updated_at);
    row("Files", String(info.file_count));
    if (info.compressed_size || info.uncompressed_size) {
      const size = formatBytes(info.compressed_size);
      const original = info.uncompressed_size
        ? ` (original ${formatBytes(info.uncompressed_size)})`
        : "";
      row("Encrypted size", `${size}${original}`);
    }
    row("Security score", `${scorePct}%`, scorePct < 50 ? "tvault-danger" : undefined);
    row("Token", tokenLabel);
    row("Integrity", info.integrity_provider_type === "hmac" ? "HMAC" : "None");
    row("Compression", info.compression_type || "—");
    row("Comment", info.comment);
    row("Tags", info.tags.join(", "));
    row("Version", info.version ? String(info.version) : "");
  }

  // Open the container's folder in the OS file manager. Uses the async openPath
  // (showItemInFolder can hang Finder/Explorer) and falls back to the nearest
  // existing ancestor when the container dir has not been created yet.
  private async onOpenContainerFolder(): Promise<void> {
    const shell = getElectronShell();
    if (!shell || !this.status) {
      new Notice("Opening folders is not available here");
      return;
    }
    let folder = path.dirname(this.status.containerPath);
    while (folder !== path.dirname(folder) && !(await this.plugin.pathExists(folder))) {
      folder = path.dirname(folder);
    }
    try {
      const error = await shell.openPath(folder);
      if (error) {
        new Notice(`Cannot open folder: ${error}`);
      }
    } catch (error) {
      new Notice(`Cannot open folder: ${errorMessage(error)}`);
    }
  }

  private renderStatusLine(root: HTMLElement): void {
    root.createDiv({ cls: "tvault-status", text: this.statusLine });
  }

  // Seed the token-input fields once, sized from the threshold for a share vault
  // (one field per share you expect to enter) or a single field for master.
  private seedTokenInputs(): void {
    if (this.tokenInputs.length > 0) {
      return;
    }
    const count = this.effectiveTokenType() === "share" ? Math.max(1, this.threshold || 1) : 1;
    this.tokenInputs = Array.from({ length: count }, () => "");
  }

  // One input per token/share instead of a single textarea, so each Shamir share
  // is entered (and pasted) on its own. Pasting a multi-token blob into any field
  // auto-distributes it across fields.
  private renderTokenInputs(root: HTMLElement): void {
    this.seedTokenInputs();
    const isShare = this.effectiveTokenType() === "share";
    const word = isShare ? "share" : "token";
    const field = root.createDiv({ cls: "tvault-field" });
    field.createEl("label", { text: isShare ? "Token shares (one per field)" : "Token" });

    this.tokenInputs.forEach((value, index) => {
      const row = field.createDiv({ cls: "tvault-token-row" });
      row.createSpan({ cls: "tvault-token-idx", text: String(index + 1) });
      const input = row.createEl("input", {
        type: "text",
        cls: "tvault-token-input",
        attr: { autocomplete: "off", placeholder: `${isShare ? "Share" : "Token"} ${index + 1}` },
      });
      input.value = value;
      input.addEventListener("input", () => {
        // Smart paste: a value carrying several tokens is spread across fields.
        const expanded = parseTokenList(input.value);
        if (expanded.length > 1) {
          this.tokenInputs.splice(index, 1, ...expanded);
          this.render();
          return;
        }
        this.tokenInputs[index] = input.value;
      });
      if (this.tokenInputs.length > 1) {
        const remove = row.createEl("button", {
          text: "×",
          cls: "tvault-token-remove",
          attr: { "aria-label": `Remove ${word} ${index + 1}` },
        });
        remove.addEventListener("click", () => {
          this.tokenInputs.splice(index, 1);
          this.render();
        });
      }
    });

    const add = field.createEl("button", { text: `+ Add ${word}`, cls: "tvault-token-add" });
    add.addEventListener("click", () => {
      this.tokenInputs.push("");
      this.render();
    });
  }

  // Shown instead of the token inputs when keys are held for the session: a
  // note plus the escape hatches to enter different keys or forget the held ones.
  private renderHeldKeys(root: HTMLElement): void {
    const field = root.createDiv({ cls: "tvault-field" });
    field.createDiv({
      cls: "tvault-held-note",
      text: "🔑 Keys are held for this session — lock/unlock without re-entering them. They are kept in memory only and cleared when Obsidian closes.",
    });
    const row = field.createDiv({ cls: "tvault-browse-row" });
    const diff = row.createEl("button", { text: "Use different keys" });
    diff.addEventListener("click", () => {
      this.useDifferentKeys = true;
      this.render();
    });
    const forget = row.createEl("button", { text: "Forget keys", cls: "mod-warning" });
    forget.addEventListener("click", () => {
      if (this.status) {
        this.plugin.forgetSessionKeys(this.status.containerPath);
      }
      this.useDifferentKeys = false;
      this.render();
    });
  }

  private renderTokensOutput(root: HTMLElement): void {
    if (!this.generatedTokens || this.generatedTokens.length === 0) {
      return;
    }
    const tokens = this.generatedTokens;
    const isShare = this.effectiveTokenType() === "share";
    const word = isShare ? "Share" : "Token";
    const out = root.createDiv({ cls: "tvault-output" });
    out.createEl("label", {
      text: `Generated tokens (${tokens.length}) — save these now`,
    });

    // Each token on its own row with its own Copy button, so Shamir shares can be
    // handed out individually instead of copied as one blob.
    tokens.forEach((token, index) => {
      const row = out.createDiv({ cls: "tvault-token-row" });
      row.createSpan({ cls: "tvault-token-idx", text: String(index + 1) });
      const input = row.createEl("input", {
        type: "text",
        cls: "tvault-token-input",
        attr: { readonly: "true", "aria-label": `${word} ${index + 1}` },
      });
      input.value = token;
      const copy = row.createEl("button", { text: "Copy", cls: "tvault-token-copy" });
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(token);
        new Notice(`${word} ${index + 1} copied`);
      });
    });

    const actions = out.createDiv({ cls: "tvault-browse-row" });
    const copyAll = actions.createEl("button", { text: "Copy all" });
    copyAll.addEventListener("click", () => {
      void navigator.clipboard.writeText(tokens.join("\n"));
      new Notice("All tokens copied to clipboard");
    });
    const save = actions.createEl("button", { text: "Save to file…", cls: "mod-cta" });
    save.addEventListener("click", () => void this.onSaveTokens());

    out.createEl("p", {
      cls: "tvault-danger",
      text: "These tokens are shown once and are not stored by the plugin.",
    });
  }

  // Write the freshly generated tokens to a user-chosen file, in the same
  // {"token_list":[...]} JSON the CLI writes and the "read from file" path reads.
  private async onSaveTokens(): Promise<void> {
    const tokens = this.generatedTokens;
    if (!tokens || tokens.length === 0) {
      return;
    }
    const dialog = getElectronDialog();
    if (!dialog) {
      new Notice("Saving to a file is not available here; use Copy instead");
      return;
    }
    const baseName = this.status
      ? path.basename(this.status.containerPath).replace(/\.[^.]+$/, "")
      : "tvault";
    const defaultDir = this.status ? path.dirname(this.status.containerPath) : "";
    const defaultPath = defaultDir
      ? path.join(defaultDir, `${baseName}.keys.json`)
      : `${baseName}.keys.json`;

    let target: string | null = null;
    try {
      const result = await dialog.showSaveDialog({
        title: "Save TrustVault tokens",
        defaultPath,
        filters: [{ name: "TrustVault tokens", extensions: ["json"] }],
      });
      target = result && !result.canceled && result.filePath ? result.filePath : null;
    } catch {
      new Notice("Could not open the save dialog");
      return;
    }
    if (!target) {
      return; // cancelled
    }
    try {
      const content = `${JSON.stringify({ token_list: tokens }, null, 2)}\n`;
      await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
      new Notice(`Tokens saved to ${target}`);
    } catch (error) {
      new Notice(`Could not save tokens: ${errorMessage(error)}`);
    }
  }

  private opInput(): OpInput {
    return {
      tokenType: this.effectiveTokenType(),
      integrityEnabled: this.integrityEnabled,
      containerPassphrase: this.containerPass,
      integrityPassphrase: this.integrityPass,
      // Flatten every field (each may itself hold a pasted JSON/multi-token blob)
      // into one token per line; buildTokenIO re-parses it into the CLI flag.
      tokensText: this.useTokenFile
        ? ""
        : this.tokenInputs.flatMap((v) => parseTokenList(v)).join("\n"),
      useTokenFile: this.useTokenFile,
      tokenFilePath: this.tokenFilePath,
      shares: this.shares,
      threshold: this.threshold,
      onProgress: (percent) =>
        this.setStatusLine(`${this.status?.operation ?? "run"}: ${percent}%`),
    };
  }

  private async onRecover(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.setStatusLine("recovering staged notes…");
    this.render();
    try {
      await this.plugin.recoverStage();
      this.statusLine = "";
    } catch (error) {
      this.statusLine = `Error: ${errorMessage(error)}`;
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  private async onPrimary(): Promise<void> {
    if (!this.status || this.status.state === "empty" || this.status.state === "unknown") {
      return;
    }
    if (this.plugin.isRunning()) {
      new Notice("A TrustVault operation is already running");
      return;
    }

    if (this.status.state === "unlocked") {
      if (this.plugin.settings.confirmBeforeLock) {
        const confirmed = await new Promise<boolean>((resolve) => {
          new ConfirmModal(
            this.app,
            "Lock vault?",
            "The vault will be encrypted into the container and the plaintext removed after the container is verified. The Obsidian config folder is preserved.",
            "Lock",
            resolve,
          ).open();
        });
        if (!confirmed) {
          return;
        }
      }
      await this.runAction("lock");
    } else if (this.status.state === "locked") {
      await this.runAction("unlock");
    }
  }

  private async runAction(action: "lock" | "unlock"): Promise<void> {
    // A fresh share/master seal derives the container key; optionally gather
    // extra entropy from the user drawing before we start.
    let containerEntropy: string | undefined;
    if (
      action === "lock" &&
      this.status &&
      this.status.state === "unlocked" &&
      !this.status.containerExists &&
      this.effectiveTokenType() !== "none" &&
      this.plugin.settings.collectEntropyByDrawing
    ) {
      const gathered = await new Promise<string | null>((resolve) => {
        new EntropyModal(this.app, resolve).open();
      });
      if (gathered === null) {
        return; // cancelled
      }
      containerEntropy = gathered;
    }

    this.busy = true;
    this.generatedTokens = null;
    this.setStatusLine(`${action}: starting…`);
    this.render();
    try {
      if (action === "lock") {
        const result = await this.plugin.lock({ ...this.opInput(), containerEntropy });
        // Tokens are only newly minted on a first-ever seal; a reseal re-emits
        // the same shares, so don't re-surface them.
        this.generatedTokens = result.operation === "seal" ? result.tokens : null;
        this.statusLine = "Locked";
        new Notice("TrustVault: vault locked");
      } else {
        await this.plugin.unlock(this.opInput());
        this.statusLine = "Unlocked";
        this.tokenInputs = [];
        new Notice("TrustVault: vault unlocked");
      }
    } catch (error) {
      const message = errorMessage(error);
      this.statusLine = `Error: ${message}`;
      new Notice(`TrustVault: ${message}`, 10000);
      console.error("TrustVault panel action failed", error);
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  private passwordField(
    parent: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void,
    hint?: string,
  ): void {
    const field = parent.createDiv({ cls: "tvault-field" });
    field.createEl("label", { text: label });
    const input = field.createEl("input", { type: "password", attr: { autocomplete: "off" } });
    input.value = value;
    input.addEventListener("input", () => onChange(input.value));
    if (hint) {
      field.createEl("small", { text: hint, cls: "tvault-hint" });
    }
  }

  // An editable path input paired with a Browse button that opens the native
  // file picker — used for pointing at an existing token file.
  private browseFileField(
    parent: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
  ): void {
    const field = parent.createDiv({ cls: "tvault-field" });
    field.createEl("label", { text: label });
    const row = field.createDiv({ cls: "tvault-browse-row" });
    const input = row.createEl("input", { type: "text", attr: { placeholder } });
    input.value = value;
    input.addEventListener("input", () => onChange(input.value));
    const browse = row.createEl("button", { text: "Browse" });
    browse.addEventListener("click", () => {
      void browseForExistingFile("Choose token file", input.value, ["json"]).then((chosen) => {
        if (chosen) {
          input.value = chosen;
          onChange(chosen);
        }
      });
    });
  }

  private numberField(
    parent: HTMLElement,
    label: string,
    value: number,
    onChange: (value: number) => void,
  ): void {
    const field = parent.createDiv({ cls: "tvault-field" });
    field.createEl("label", { text: label });
    const input = field.createEl("input", { type: "number" });
    input.value = String(value);
    input.addEventListener("input", () => {
      const parsed = Number.parseInt(input.value, 10);
      if (!Number.isNaN(parsed)) {
        onChange(parsed);
      }
    });
  }
}

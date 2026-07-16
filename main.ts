import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";
import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import { constants as fsConstants } from "fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "fs/promises";
import path from "path";

// Injected at build time from cli.json / cli-checksums.json (see esbuild.config.mjs).
declare const TVAULT_CLI_REPO: string;
declare const TVAULT_CLI_VERSION: string;
declare const TVAULT_CLI_CHECKSUMS: Record<string, string>;

type TokenType = "share" | "master" | "none";
type IntegrityType = "hmac" | "none";
type Operation = "seal" | "unseal" | "reseal";
type VaultState = "locked" | "unlocked" | "empty" | "unknown";

const VIEW_TYPE_TVAULT = "tvault-panel";
// State file lives inside the Obsidian config dir so it survives the plaintext
// cleanup that a lock performs on the rest of the vault.
const STATE_FILE = "tvault-state.json";
// Notes are moved here during a lock so only they (never .obsidian) are packed
// into the container. It is removed once the container is verified.
const STAGE_DIR = ".tvault-stage";
const CLOSING_MARKER = ".tvault-closing";

interface TVaultSettings {
  cliPath: string;
  containerPath: string;
  tokenPath: string;
  tokenType: TokenType;
  shares: number;
  threshold: number;
  confirmBeforeLock: boolean;
  integrityEnabled: boolean;
  collectEntropyByDrawing: boolean;
}

const DEFAULT_SETTINGS: TVaultSettings = {
  cliPath: "",
  containerPath: "",
  tokenPath: "",
  tokenType: "share",
  shares: 5,
  threshold: 3,
  confirmBeforeLock: true,
  integrityEnabled: true,
  collectEntropyByDrawing: true,
};

// Persisted lock/unlock state. The live vault contents are the source of truth;
// this record carries hints (token type, last container) across sessions.
interface TVaultStateFile {
  sealed: boolean;
  containerPath: string;
  tokenType: TokenType;
  fileCount: number;
  updatedAt: string;
}

interface ContainerInfo {
  file_count: number;
  updated_at: string;
  token_type: string;
  integrity_provider_type: string;
}

interface VaultStatus {
  state: VaultState;
  operation: Operation;
  containerExists: boolean;
  containerPath: string;
  noteCount: number;
  tokenType: TokenType;
  integrityType: IntegrityType;
}

// A single CLI invocation. tokenIO decides how tokens flow: a pasted flag with
// stdout capture, or a file for both reading and writing. folderPathOverride
// lets a lock pack the staging directory instead of the whole vault.
interface RunSpec {
  operation: Operation;
  tokenType: TokenType;
  integrityType: IntegrityType;
  containerPassphrase: string;
  integrityPassphrase: string;
  tokenIO: "flag" | "file";
  tokensFlag: string;
  tokenFilePath: string;
  shares: number;
  threshold: number;
  folderPathOverride?: string;
  onProgress?: (percent: number) => void;
}

interface RunResult {
  tokens: string[] | null;
  stdout: string;
}

// Values collected from the panel (or synthesized for a command) and handed to
// lock()/unlock().
interface OpInput {
  tokenType: TokenType;
  integrityEnabled: boolean; // for a fresh seal; existing containers keep their own
  containerPassphrase: string;
  integrityPassphrase: string;
  containerEntropy?: string; // pre-derived high-entropy container passphrase (drawing)
  tokensText: string;
  useTokenFile: boolean;
  tokenFilePath: string;
  shares: number;
  threshold: number;
  onProgress?: (percent: number) => void;
}

// extractJsonWithKey - pull the JSON object that contains `key` out of stdout,
// which is interleaved with "PROGRESS <n>" lines and possibly log JSON. It
// brace-matches from the object opening so surrounding output is ignored.
function extractJsonWithKey(stdout: string, key: string): Record<string, unknown> | null {
  const marker = stdout.indexOf(`"${key}"`);
  if (marker === -1) {
    return null;
  }
  const start = stdout.lastIndexOf("{", marker);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let end = -1;
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    return null;
  }
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractTokenList(stdout: string): string[] | null {
  const obj = extractJsonWithKey(stdout, "token_list");
  if (obj && Array.isArray(obj.token_list)) {
    return obj.token_list.map((entry) => String(entry));
  }
  return null;
}

// generateEntropyPassphrase - a 256-bit random container passphrase for
// share/master vaults. In those modes the master key is derived from this
// passphrase and then split into tokens, so a weak human passphrase would be a
// brute-forceable backdoor around the Shamir scheme. It is never needed again
// (the tokens reconstruct the key), so it is generated fresh and discarded.
function generateEntropyPassphrase(): string {
  return randomBytes(32).toString("base64");
}

// getElectronDialog - reach the Electron file dialog from the Obsidian renderer.
// Uses window.require so esbuild does not try to resolve the modules at build
// time. Returns null on platforms where it is unavailable.
function getElectronDialog(): {
  showSaveDialog: (opts: unknown) => Promise<{ canceled: boolean; filePath?: string }>;
} | null {
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  if (typeof req !== "function") {
    return null;
  }
  for (const mod of ["@electron/remote", "electron"]) {
    try {
      const m = req(mod) as { dialog?: unknown; remote?: { dialog?: unknown } };
      const dialog = m?.dialog ?? m?.remote?.dialog;
      if (dialog) {
        return dialog as ReturnType<typeof getElectronDialog>;
      }
    } catch {
      // try the next module
    }
  }
  return null;
}

// getElectronShell - the Electron shell module (renderer-safe) for revealing a
// file/folder in the OS file manager. Returns null where unavailable.
function getElectronShell(): {
  showItemInFolder: (fullPath: string) => void;
  openPath: (p: string) => Promise<string>;
} | null {
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  if (typeof req !== "function") {
    return null;
  }
  try {
    const electron = req("electron") as { shell?: ReturnType<typeof getElectronShell> };
    return electron?.shell ?? null;
  } catch {
    return null;
  }
}

// pickExistingFile - fallback picker (Electron adds `.path` to the File object).
function pickExistingFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) {
      input.accept = accept;
    }
    input.addEventListener("change", () => {
      const file = input.files?.[0] as (File & { path?: string }) | undefined;
      resolve(file?.path ?? null);
    });
    input.click();
  });
}

// browseForContainer - let the user choose where the .tvlt container lives, via
// the native save dialog when available, otherwise picking an existing file.
async function browseForContainer(defaultPath: string): Promise<string | null> {
  const dialog = getElectronDialog();
  if (dialog) {
    try {
      const result = await dialog.showSaveDialog({
        title: "Choose TVault container location",
        defaultPath: defaultPath || undefined,
        filters: [{ name: "TVault container", extensions: ["tvlt"] }],
      });
      return result && !result.canceled && result.filePath ? result.filePath : null;
    } catch {
      // fall through to the input fallback
    }
  }
  return pickExistingFile(".tvlt");
}

// normalizeTokensToFlag - turn whatever the user pasted (pretty JSON from a
// previous seal, or a plain list separated by new lines / commas / pipes) into
// the canonical {"token_list":[...]} flag the CLI reader expects.
function normalizeTokensToFlag(input: string): { flag: string; count: number } {
  const trimmed = input.trim();
  let list: string[] = [];
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { token_list?: unknown };
      if (Array.isArray(parsed.token_list)) {
        list = parsed.token_list.map((entry) => String(entry).trim());
      }
    } catch {
      // fall through to delimiter splitting
    }
  }
  if (list.length === 0) {
    list = trimmed
      .split(/[\r\n|,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return { flag: JSON.stringify({ token_list: list }), count: list.length };
}

class SecretModal extends Modal {
  private value = "";
  private readonly titleText: string;
  private readonly detail: string;
  private readonly resolveValue: (value: string | null) => void;
  private settled = false;

  constructor(
    app: App,
    title: string,
    detail: string,
    resolveValue: (value: string | null) => void,
  ) {
    super(app);
    this.titleText = title;
    this.detail = detail;
    this.resolveValue = resolveValue;
  }

  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.detail });
    const input = this.contentEl.createEl("input", {
      type: "password",
      cls: "tvault-secret-input",
      attr: { autocomplete: "current-password", placeholder: "Passphrase" },
    });
    input.addEventListener("input", () => {
      this.value = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    });

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const submit = buttons.createEl("button", { text: "Continue", cls: "mod-cta" });
    submit.addEventListener("click", () => this.submit());
    input.focus();
  }

  private submit(): void {
    if (!this.value) {
      new Notice("Passphrase is required");
      return;
    }
    this.settled = true;
    this.resolveValue(this.value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.value = "";
    if (!this.settled) {
      this.resolveValue(null);
    }
  }
}

class ConfirmModal extends Modal {
  private readonly titleText: string;
  private readonly body: string;
  private readonly confirmText: string;
  private readonly resolveValue: (confirmed: boolean) => void;
  private settled = false;

  constructor(
    app: App,
    titleText: string,
    body: string,
    confirmText: string,
    resolveValue: (confirmed: boolean) => void,
  ) {
    super(app);
    this.titleText = titleText;
    this.body = body;
    this.confirmText = confirmText;
    this.resolveValue = resolveValue;
  }

  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.body, cls: "tvault-danger" });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const confirm = buttons.createEl("button", {
      text: this.confirmText,
      cls: "mod-warning",
    });
    confirm.addEventListener("click", () => {
      this.settled = true;
      this.resolveValue(true);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.resolveValue(false);
    }
  }
}

// EntropyModal - gather user entropy by drawing in a box. The collected pointer
// samples (position, movement, timing) are hashed together with the system
// CSPRNG, so the resulting 256-bit passphrase is never weaker than
// crypto.randomBytes alone — the drawing only adds entropy, it cannot subtract.
class EntropyModal extends Modal {
  private readonly resolveValue: (passphrase: string | null) => void;
  private readonly samples: number[] = [];
  private readonly target = 400; // pointer moves (5 numbers each) before the bar fills
  private settled = false;
  private bar: HTMLElement | null = null;

  constructor(app: App, resolveValue: (passphrase: string | null) => void) {
    super(app);
    this.resolveValue = resolveValue;
  }

  onOpen(): void {
    this.titleEl.setText("Gather entropy");
    this.contentEl.createEl("p", {
      text: "Draw with the pointer inside the box until the bar is full. This mixes your randomness into the vault key.",
    });

    const canvas = this.contentEl.createEl("canvas", { cls: "tvault-entropy-canvas" });
    canvas.width = 480;
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const track = this.contentEl.createDiv({ cls: "tvault-entropy-track" });
    this.bar = track.createDiv({ cls: "tvault-entropy-bar" });

    let last = 0;
    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      // performance.now() is monotonic and adds timing jitter as entropy.
      this.samples.push(x, y, event.movementX, event.movementY, performance.now());
      if (ctx) {
        const hue = (this.samples.length * 7) % 360;
        ctx.fillStyle = `hsl(${hue}, 80%, 60%)`;
        ctx.beginPath();
        ctx.arc(
          (x / rect.width) * canvas.width,
          (y / rect.height) * canvas.height,
          2,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      const now = performance.now();
      if (now - last > 40) {
        last = now;
        this.updateBar();
      }
      if (this.samples.length >= this.target * 5) {
        this.finish();
      }
    };
    canvas.addEventListener("pointermove", onMove);

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  private updateBar(): void {
    if (this.bar) {
      const pct = Math.min(100, Math.round((this.samples.length / (this.target * 5)) * 100));
      this.bar.style.width = `${pct}%`;
    }
  }

  private finish(): void {
    // Serialize samples to bytes, then hash with fresh CSPRNG output for a
    // 256-bit key that depends on both sources.
    const buf = Buffer.from(Float64Array.from(this.samples).buffer);
    const digest = createHash("sha256").update(buf).update(randomBytes(32)).digest();
    this.settled = true;
    this.resolveValue(digest.toString("base64"));
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.resolveValue(null);
    }
  }
}

export default class TVaultPlugin extends Plugin {
  settings: TVaultSettings = DEFAULT_SETTINGS;
  private running = false;
  private statusEl: HTMLElement | null = null;

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
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TVAULT);
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

  // ---- path & CLI resolution -------------------------------------------------

  private getVaultPath(): string {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    if (!adapter.getBasePath) {
      throw new Error("TVault requires Obsidian desktop with a local filesystem vault");
    }
    return path.resolve(adapter.getBasePath());
  }

  private configDirName(): string {
    return (this.app.vault as { configDir?: string }).configDir ?? ".obsidian";
  }

  private resolveConfiguredPath(value: string): string {
    if (!value.trim()) {
      return "";
    }
    return path.resolve(value.replace(/^~(?=$|\/|\\)/, process.env.HOME ?? "~"));
  }

  private isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private getPluginDir(): string {
    const vaultBase = this.getVaultPath();
    const dir = (this.manifest as { dir?: string }).dir;
    if (dir) {
      return path.resolve(vaultBase, dir);
    }
    return path.join(vaultBase, this.configDirName(), "plugins", this.manifest.id);
  }

  // The tvault-core binary name for the current platform, e.g.
  // tvault-core-darwin-arm64 or tvault-core-windows-amd64.exe.
  private cliBinaryName(): string {
    const goos = process.platform === "win32" ? "windows" : process.platform;
    const goarch = process.arch === "x64" ? "amd64" : process.arch;
    const ext = process.platform === "win32" ? ".exe" : "";
    return `tvault-core-${goos}-${goarch}${ext}`;
  }

  private cliCachePath(): string {
    return path.join(this.getPluginDir(), "bin", this.cliBinaryName());
  }

  // verifyChecksum - true if the file matches its pinned SHA-256. If no checksum
  // is pinned (a local dev build), verification is skipped.
  private async verifyChecksum(file: string, name: string): Promise<boolean> {
    const expected = TVAULT_CLI_CHECKSUMS[name];
    if (!expected) {
      return true;
    }
    const actual = createHash("sha256").update(await readFile(file)).digest("hex");
    return actual === expected;
  }

  // resolveCli - an explicit settings path always wins. Otherwise the platform
  // binary is fetched once from the pinned tvault-core release, checksum-verified,
  // cached under the plugin's bin/, and reused thereafter.
  private async resolveCli(): Promise<string> {
    const configured = this.settings.cliPath?.trim() ?? "";
    if (configured && configured.includes(path.sep)) {
      const resolved = this.resolveConfiguredPath(configured);
      try {
        await access(resolved, fsConstants.X_OK);
      } catch {
        throw new Error(`tvault-core is not executable at ${resolved}`);
      }
      return resolved;
    }

    const name = this.cliBinaryName();
    const dest = this.cliCachePath();
    if (await this.pathExists(dest)) {
      if (await this.verifyChecksum(dest, name)) {
        await chmod(dest, 0o755).catch(() => undefined);
        return dest;
      }
      // Tampered or stale cache — discard and re-download.
      await rm(dest, { force: true }).catch(() => undefined);
    }

    await this.downloadCli(name, dest);
    if (!(await this.verifyChecksum(dest, name))) {
      await rm(dest, { force: true }).catch(() => undefined);
      throw new Error("Downloaded tvault-core failed checksum verification");
    }
    await chmod(dest, 0o755);
    return dest;
  }

  // downloadCli - fetch the platform binary from the pinned tvault-core release.
  private async downloadCli(name: string, dest: string): Promise<void> {
    if (!TVAULT_CLI_VERSION) {
      throw new Error("No tvault-core release is pinned; set the executable path in settings");
    }
    const url = `https://github.com/${TVAULT_CLI_REPO}/releases/download/${TVAULT_CLI_VERSION}/${name}`;
    const notice = new Notice(`TVault: downloading tvault-core (${name})…`, 0);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not download tvault-core: ${message}`);
    } finally {
      notice.hide();
    }
  }

  // A container/token file is safe if it is fully outside the vault, OR inside
  // the vault's config dir (.obsidian) — which is preserved on lock and never
  // staged. It must NOT sit in the note area, where it would be sealed into
  // itself and then deleted.
  private isSafeVaultSideLocation(vaultPath: string, target: string): boolean {
    const configDir = path.join(vaultPath, this.configDirName());
    if (this.isInside(configDir, target)) {
      return true;
    }
    return !this.isInside(vaultPath, target);
  }

  // Default self-contained locations under .obsidian so the plugin works with no
  // configuration and the vault stays portable (everything travels together).
  private defaultContainerPath(vaultPath: string): string {
    return path.join(vaultPath, this.configDirName(), "tvault", `${path.basename(vaultPath)}.tvlt`);
  }

  private defaultTokenPath(vaultPath: string): string {
    return path.join(vaultPath, this.configDirName(), "tvault", `${path.basename(vaultPath)}.keys.json`);
  }

  private effectiveContainerPath(vaultPath: string): string {
    return this.resolveConfiguredPath(this.settings.containerPath) || this.defaultContainerPath(vaultPath);
  }

  private resolveContainerPath(vaultPath: string): string {
    const containerPath = this.effectiveContainerPath(vaultPath);
    if (!this.isSafeVaultSideLocation(vaultPath, containerPath)) {
      throw new Error(
        "The container must be outside the vault or inside its .obsidian config folder",
      );
    }
    return containerPath;
  }

  private async containerExists(containerPath: string): Promise<boolean> {
    try {
      await access(containerPath, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  // ---- staging (exclude .obsidian from the container) ------------------------

  private async listNoteEntries(vaultPath: string): Promise<string[]> {
    const skip = new Set([this.configDirName(), STAGE_DIR, CLOSING_MARKER]);
    const entries = await readdir(vaultPath, { withFileTypes: true });
    return entries.filter((entry) => !skip.has(entry.name)).map((entry) => entry.name);
  }

  // countFilesRecursive - count regular files and symlinks under dir, matching
  // the CLI's WalkFolder (which counts files + symlinks, does not follow
  // symlinked dirs, and does not skip hidden entries). Implemented as a manual
  // walk so it does not depend on readdir's { recursive } option, which is
  // unavailable in older Electron/Node builds.
  private async countFilesRecursive(dir: string): Promise<number> {
    let count = 0;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await this.countFilesRecursive(path.join(dir, entry.name));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        count++;
      }
    }
    return count;
  }

  // stageNotes - move every note (top-level entry that is not .obsidian) into the
  // staging directory so a seal/reseal packs only user data.
  private async stageNotes(
    vaultPath: string,
    entries: string[],
  ): Promise<{ stageDir: string; fileCount: number }> {
    const stageDir = path.join(vaultPath, STAGE_DIR);
    await mkdir(stageDir); // fails if a leftover stage exists; recoverStage clears it on load
    for (const name of entries) {
      await rename(path.join(vaultPath, name), path.join(stageDir, name));
    }
    const fileCount = await this.countFilesRecursive(stageDir);
    return { stageDir, fileCount };
  }

  // unstageNotes - move staged notes back to the vault root. It never overwrites
  // an existing root entry (a name conflict is reported, not clobbered) and
  // continues past individual failures so it restores as much as possible; the
  // staging dir is only removed once every entry is back.
  private async unstageNotes(vaultPath: string): Promise<void> {
    const stageDir = path.join(vaultPath, STAGE_DIR);
    const names = await readdir(stageDir);
    const failed: string[] = [];
    for (const name of names) {
      const target = path.join(vaultPath, name);
      if (await this.pathExists(target)) {
        failed.push(name); // would overwrite a live note — leave it staged
        continue;
      }
      try {
        await rename(path.join(stageDir, name), target);
      } catch (error) {
        console.error(`TVault: failed to restore ${name}`, error);
        failed.push(name);
      }
    }
    if (failed.length > 0) {
      throw new Error(`These notes remain in ${STAGE_DIR} (name conflicts): ${failed.join(", ")}`);
    }
    await rm(stageDir, { recursive: true, force: true });
  }

  private async discardStage(vaultPath: string): Promise<void> {
    await rm(path.join(vaultPath, STAGE_DIR), { recursive: true, force: true });
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
      vaultPath = this.getVaultPath();
    } catch {
      return; // not a desktop filesystem vault
    }
    if (!(await this.pathExists(path.join(vaultPath, STAGE_DIR)))) {
      return; // no leftover staging
    }
    try {
      await this.unstageNotes(vaultPath);
      new Notice("TVault: recovered notes from an interrupted lock");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Persistent notice (timeout 0): the user must resolve this before data is safe.
      new Notice(`TVault: could not fully recover staged notes — ${message}`, 0);
      console.error("TVault recoverStage failed", error);
    }
  }

  // ---- state file ------------------------------------------------------------

  private statePath(): string {
    return `${this.configDirName()}/${STATE_FILE}`;
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
      return {
        file_count: obj.file_count,
        updated_at: String(obj.updated_at ?? ""),
        token_type: String(obj.token_type ?? ""),
        integrity_provider_type: String(obj.integrity_provider_type ?? ""),
      };
    }
    return null;
  }

  // ---- status ----------------------------------------------------------------

  async computeStatus(): Promise<VaultStatus> {
    const vaultPath = this.getVaultPath();
    const containerPath = this.effectiveContainerPath(vaultPath);
    const containerExists = await this.containerExists(containerPath);

    let tokenType: TokenType = this.settings.tokenType;
    let integrityType: IntegrityType = this.settings.integrityEnabled ? "hmac" : "none";

    // A leftover staging directory means an interrupted lock whose recovery has
    // not completed. Report "unknown" so the panel blocks operations that could
    // overwrite the staged plaintext (e.g. an unseal onto it).
    if (await this.pathExists(path.join(vaultPath, STAGE_DIR))) {
      return { state: "unknown", operation: "seal", containerExists, containerPath, noteCount: 0, tokenType, integrityType };
    }

    if (containerExists) {
      const info = await this.containerInfo(containerPath).catch(() => null);
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

    const noteCount = (await this.listNoteEntries(vaultPath)).length;
    if (noteCount > 0) {
      return {
        state: "unlocked",
        operation: containerExists ? "reseal" : "seal",
        containerExists,
        containerPath,
        noteCount,
        tokenType,
        integrityType,
      };
    }
    if (containerExists) {
      return { state: "locked", operation: "unseal", containerExists, containerPath, noteCount, tokenType, integrityType };
    }
    return { state: "empty", operation: "seal", containerExists, containerPath, noteCount, tokenType, integrityType };
  }

  // ---- CLI execution ---------------------------------------------------------

  private buildArgs(spec: RunSpec, vaultPath: string, containerPath: string): string[] {
    const args: string[] = [spec.operation, "container"];
    const folderPath = spec.folderPathOverride ?? vaultPath;

    if (spec.operation === "seal") {
      args.push(
        `-name=${path.basename(vaultPath)}`,
        `-new-path=${containerPath}`,
        `-folder-path=${folderPath}`,
        `-passphrase=${spec.containerPassphrase}`,
      );
    } else {
      args.push(`-current-path=${containerPath}`, `-folder-path=${folderPath}`);
      if (spec.operation === "reseal") {
        args.push(`-new-path=${containerPath}`);
      }
      if (spec.tokenType === "none") {
        args.push(`-passphrase=${spec.containerPassphrase}`);
      }
    }

    if (spec.tokenType === "none") {
      if (spec.operation === "seal") {
        args.push(
          "token",
          "-type=none",
          "integrity-provider",
          "-type=none",
          "shamir",
          "-is-enabled=false",
        );
      } else {
        // A none container is decrypted with the container passphrase, but the
        // CLI still validates a token-reader; pass a harmless placeholder.
        args.push("token-reader", "-type=flag", "-format=json", "-flag=-");
        if (spec.operation === "reseal") {
          args.push("token-writer", "-type=stdout", "-format=json");
        }
      }
    } else if (spec.operation === "seal") {
      args.push("compression", "-type=zip", "token", `-type=${spec.tokenType}`);
      if (spec.tokenIO === "file") {
        args.push("token-writer", "-type=file", "-format=json", `-path=${spec.tokenFilePath}`);
      } else {
        args.push("token-writer", "-type=stdout", "-format=json");
      }
      if (spec.integrityType === "hmac") {
        args.push("integrity-provider", "-type=hmac", `-new-passphrase=${spec.integrityPassphrase}`);
      } else {
        args.push("integrity-provider", "-type=none");
      }
      args.push(
        "shamir",
        `-is-enabled=${spec.tokenType === "share"}`,
        `-shares=${spec.shares}`,
        `-threshold=${spec.threshold}`,
      );
    } else {
      if (spec.tokenIO === "file") {
        args.push("token-reader", "-type=file", "-format=json", `-path=${spec.tokenFilePath}`);
      } else {
        args.push("token-reader", "-type=flag", "-format=json", `-flag=${spec.tokensFlag}`);
      }
      // Only an HMAC container needs the integrity passphrase to open its tokens.
      if (spec.integrityType === "hmac") {
        args.push("integrity-provider", `-current-passphrase=${spec.integrityPassphrase}`);
      }
      if (spec.operation === "reseal") {
        if (spec.tokenIO === "file") {
          args.push("token-writer", "-type=file", "-format=json", `-path=${spec.tokenFilePath}`);
        } else {
          args.push("token-writer", "-type=stdout", "-format=json");
        }
      }
    }

    args.push("log-writer", "-type=stdout", "-format=json");
    return args;
  }

  // run - execute one CLI operation. The `running` guard is held by the caller
  // (lock/unlock/command) across the whole higher-level operation, so run()
  // itself does not touch it.
  private async run(spec: RunSpec): Promise<RunResult> {
    const vaultPath = this.getVaultPath();
    const containerPath = this.resolveContainerPath(vaultPath);
    if (spec.operation === "seal") {
      await mkdir(path.dirname(containerPath), { recursive: true });
    } else {
      await access(containerPath, fsConstants.R_OK);
    }

    const cli = await this.resolveCli();
    const args = this.buildArgs(spec, vaultPath, containerPath);

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
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("tvault-core timed out"));
      }, 30 * 60 * 1000);
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
        reject(new Error(this.extractCliError(stderr || stdout, code)));
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
        code === 0 ? resolve(stdout) : reject(new Error(this.extractCliError(stderr || stdout, code)));
      });
    });
  }

  private extractCliError(output: string, code: number | null): string {
    try {
      const obj = extractJsonWithKey(output, "message");
      if (obj && typeof obj.message === "string") {
        return obj.message;
      }
    } catch {
      // fall through to line scraping
    }
    const clean = output
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith("PROGRESS "))
      .slice(-4)
      .join(" ");
    return clean || `tvault-core exited with code ${code ?? "unknown"}`;
  }

  // ---- token I/O resolution --------------------------------------------------

  private buildTokenIO(
    operation: Operation,
    tokenType: TokenType,
    input: OpInput,
    vaultPath: string,
  ): { tokenIO: "flag" | "file"; tokensFlag: string; tokenFilePath: string } {
    const tokenFilePath =
      this.resolveConfiguredPath(input.tokenFilePath) ||
      this.resolveConfiguredPath(this.settings.tokenPath) ||
      this.defaultTokenPath(vaultPath);

    if (tokenType === "none") {
      return { tokenIO: "flag", tokensFlag: "", tokenFilePath };
    }
    if (input.useTokenFile) {
      if (!this.isSafeVaultSideLocation(vaultPath, tokenFilePath)) {
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
  async lock(input: OpInput): Promise<{ tokens: string[] | null; operation: Operation; tokenType: TokenType }> {
    return this.withLock(async () => {
      const vaultPath = this.getVaultPath();
      const containerPath = this.resolveContainerPath(vaultPath);

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
        if (info && (info.token_type === "share" || info.token_type === "master" || info.token_type === "none")) {
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
      const integrity = isTokenMode ? input.integrityPassphrase : input.containerPassphrase;

      if (tokenType === "none" && !input.containerPassphrase) {
        throw new Error("Container passphrase is required");
      }
      if (isTokenMode && integrityType === "hmac" && !integrity) {
        throw new Error("Token (integrity) passphrase is required");
      }

      const { tokenIO, tokensFlag, tokenFilePath } = this.buildTokenIO(operation, tokenType, input, vaultPath);

      // The CLI's file writer does not create parent directories.
      if (tokenIO === "file") {
        await mkdir(path.dirname(tokenFilePath), { recursive: true });
      }

      const noteEntries = await this.listNoteEntries(vaultPath);
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
        const { stageDir, fileCount } = await this.stageNotes(vaultPath, noteEntries);
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

        await this.discardStage(vaultPath);
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
        return { tokens: result.tokens, operation, tokenType };
      } catch (error) {
        // Restore the token file if a reseal may have clobbered it.
        if (tokenBackup) {
          await copyFile(tokenBackup, tokenFilePath).catch(() => undefined);
          await rm(tokenBackup, { force: true }).catch(() => undefined);
        }
        // Restore plaintext so a failed lock never loses data.
        await this.unstageNotes(vaultPath).catch((restoreError) => {
          const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
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
      const vaultPath = this.getVaultPath();
      const containerPath = this.resolveContainerPath(vaultPath);
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
      if (info && (info.token_type === "share" || info.token_type === "master" || info.token_type === "none")) {
        tokenType = info.token_type;
      }
      const integrityType: IntegrityType = info?.integrity_provider_type === "hmac" ? "hmac" : "none";

      // none opens with the container passphrase; share/master open with the
      // tokens plus, when the container uses HMAC, the integrity passphrase that
      // encrypts them.
      const isTokenMode = tokenType !== "none";
      const integrity = isTokenMode ? input.integrityPassphrase : "";
      if (tokenType === "none" && !input.containerPassphrase) {
        throw new Error("Container passphrase is required");
      }
      if (isTokenMode && integrityType === "hmac" && !integrity) {
        throw new Error("Token (integrity) passphrase is required");
      }

      const { tokenIO, tokensFlag, tokenFilePath } = this.buildTokenIO("unseal", tokenType, input, vaultPath);

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
          "Notes will be encrypted into the container and the plaintext removed after the container is verified. .obsidian is preserved.",
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
      const message = error instanceof Error ? error.message : String(error);
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
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`TVault: ${message}`, 10000);
      console.error("TVault unlock failed", error);
    }
  }
}

// TVaultView - the side panel. It shows the lock/unlock state and drives a
// single primary action; passphrases and pasted tokens are never persisted.
class TVaultView extends ItemView {
  private readonly plugin: TVaultPlugin;

  private status: VaultStatus | null = null;
  private statusError: string | null = null;
  private tokenType: TokenType;
  private integrityEnabled: boolean;
  private containerPass = "";
  private integrityPass = "";
  private shares: number;
  private threshold: number;
  private tokensText = "";
  private useTokenFile = false;
  private tokenFilePath = "";
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
    return "TVault";
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
    this.tokensText = "";
    this.contentEl.empty();
  }

  private async refresh(): Promise<void> {
    try {
      this.status = await this.plugin.computeStatus();
      this.statusError = null;
      // Keep the selector in sync with an existing container's token type.
      if (this.status.containerExists) {
        this.tokenType = this.status.tokenType;
      }
    } catch (error) {
      this.status = null;
      this.statusError = error instanceof Error ? error.message : String(error);
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
    root.createEl("h3", { text: "TVault" });

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
    if (locking && !this.status.containerExists) {
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

    // Container passphrase: only for none, where it is the sole secret. For
    // share/master the container key is auto-generated with full entropy.
    if (tokenType === "none") {
      this.passwordField(root, "Container passphrase", this.containerPass, (v) => (this.containerPass = v));
    } else {
      // Integrity provider toggle — choosable only when creating the container.
      if (locking && !this.status.containerExists) {
        const toggle = root.createDiv({ cls: "tvault-field tvault-inline" });
        const checkbox = toggle.createEl("input", { type: "checkbox" });
        checkbox.checked = this.integrityEnabled;
        toggle.createEl("label", { text: "Protect tokens with an integrity passphrase (HMAC)" });
        checkbox.addEventListener("change", () => {
          this.integrityEnabled = checkbox.checked;
          this.render();
        });
      }

      if (integrityType === "hmac") {
        this.passwordField(
          root,
          "Integrity passphrase",
          this.integrityPass,
          (v) => (this.integrityPass = v),
          "Encrypts and verifies the tokens — required to unlock. Remember it.",
        );
      } else if (locking && !this.status.containerExists) {
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
      const toggle = root.createDiv({ cls: "tvault-field tvault-inline" });
      const checkbox = toggle.createEl("input", { type: "checkbox" });
      checkbox.checked = this.useTokenFile;
      toggle.createEl("label", { text: "Read tokens from a file instead of pasting" });
      checkbox.addEventListener("change", () => {
        this.useTokenFile = checkbox.checked;
        this.render();
      });

      if (this.useTokenFile) {
        this.textField(
          root,
          "Token file path",
          this.tokenFilePath,
          (v) => (this.tokenFilePath = v),
          "~/TVault/my-vault.keys.json",
        );
      } else {
        const field = root.createDiv({ cls: "tvault-field" });
        field.createEl("label", { text: "Tokens (one per line)" });
        const area = field.createEl("textarea", {
          cls: "tvault-tokens",
          attr: { rows: "6", placeholder: "Paste your token shares here" },
        });
        area.value = this.tokensText;
        area.addEventListener("input", () => {
          this.tokensText = area.value;
        });
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
        ? "Locked — notes are encrypted"
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
      new Notice(`Cannot open folder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderStatusLine(root: HTMLElement): void {
    root.createDiv({ cls: "tvault-status", text: this.statusLine });
  }

  private renderTokensOutput(root: HTMLElement): void {
    if (!this.generatedTokens || this.generatedTokens.length === 0) {
      return;
    }
    const out = root.createDiv({ cls: "tvault-output" });
    out.createEl("label", {
      text: `Generated tokens (${this.generatedTokens.length}) — save these now`,
    });
    const area = out.createEl("textarea", {
      cls: "tvault-tokens",
      attr: { rows: "6", readonly: "true" },
    });
    area.value = this.generatedTokens.join("\n");
    const copyBtn = out.createEl("button", { text: "Copy tokens" });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.generatedTokens?.join("\n") ?? "");
      new Notice("Tokens copied to clipboard");
    });
    out.createEl("p", {
      cls: "tvault-danger",
      text: "These tokens are shown once and are not stored by the plugin.",
    });
  }

  private opInput(): OpInput {
    return {
      tokenType: this.effectiveTokenType(),
      integrityEnabled: this.integrityEnabled,
      containerPassphrase: this.containerPass,
      integrityPassphrase: this.integrityPass,
      tokensText: this.tokensText,
      useTokenFile: this.useTokenFile,
      tokenFilePath: this.tokenFilePath,
      shares: this.shares,
      threshold: this.threshold,
      onProgress: (percent) => this.setStatusLine(`${this.status?.operation ?? "run"}: ${percent}%`),
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
      this.statusLine = `Error: ${error instanceof Error ? error.message : String(error)}`;
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
      new Notice("A TVault operation is already running");
      return;
    }

    if (this.status.state === "unlocked") {
      if (this.plugin.settings.confirmBeforeLock) {
        const confirmed = await new Promise<boolean>((resolve) => {
          new ConfirmModal(
            this.app,
            "Lock vault?",
            "Notes will be encrypted into the container and the plaintext removed after the container is verified. .obsidian is preserved.",
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
        new Notice("TVault: vault locked");
      } else {
        await this.plugin.unlock(this.opInput());
        this.statusLine = "Unlocked";
        this.tokensText = "";
        new Notice("TVault: vault unlocked");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusLine = `Error: ${message}`;
      new Notice(`TVault: ${message}`, 10000);
      console.error("TVault panel action failed", error);
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

  private textField(
    parent: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder?: string,
  ): void {
    const field = parent.createDiv({ cls: "tvault-field" });
    field.createEl("label", { text: label });
    const input = field.createEl("input", {
      type: "text",
      attr: placeholder ? { placeholder } : {},
    });
    input.value = value;
    input.addEventListener("input", () => onChange(input.value));
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

class TVaultSettingTab extends PluginSettingTab {
  private readonly plugin: TVaultPlugin;

  constructor(app: App, plugin: TVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "TVault" });
    containerEl.createEl("p", {
      text:
        "Locking encrypts the vault's notes into the container and removes the " +
        "plaintext (the .obsidian config is always preserved). Leave the paths " +
        "empty to keep the container and token file self-contained under " +
        ".obsidian/tvault/, or set paths outside the vault.",
    });

    new Setting(containerEl)
      .setName("tvault-core executable")
      .setDesc(
        "Leave empty to download the tvault-core binary for your platform on " +
          "first use (verified by checksum, then cached). Set an absolute path " +
          "to use your own build instead.",
      )
      .addText((text) =>
        text
          .setPlaceholder("(auto-download) or /usr/local/bin/tvault-core")
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (value) => {
            this.plugin.settings.cliPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("Encrypted container")
      .setDesc(
        "Empty → .obsidian/tvault/<vault>.tvlt (self-contained). Or an absolute " +
          "path outside the vault. It must never sit in the note area.",
      )
      .addText((text) =>
        text
          .setPlaceholder("(default) .obsidian/tvault/<vault>.tvlt")
          .setValue(this.plugin.settings.containerPath)
          .onChange(async (value) => {
            this.plugin.settings.containerPath = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Browse")
          .onClick(async () => {
            const chosen = await browseForContainer(this.plugin.settings.containerPath);
            if (chosen) {
              this.plugin.settings.containerPath = chosen;
              await this.plugin.saveSettings();
              this.display();
            }
          }),
      );
    const tokenSetting = new Setting(containerEl)
      .setName("Token file")
      .setDesc(
        "Empty → .obsidian/tvault/<vault>.keys.json. Used by the command palette " +
          "and the panel's token-file option; not used with token type none.",
      )
      .addText((text) =>
        text
          .setPlaceholder("(default) .obsidian/tvault/<vault>.keys.json")
          .setValue(this.plugin.settings.tokenPath)
          .onChange(async (value) => {
            this.plugin.settings.tokenPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    tokenSetting.descEl.createEl("p", {
      cls: "tvault-danger",
      text:
        "Security: the tokens are encrypted with the integrity passphrase, so a " +
        "leaked token file still needs that passphrase to be useful — use a " +
        "strong one. The container's own key is auto-generated with full entropy, " +
        "so there is no weak passphrase backdoor around the tokens.",
    });
    new Setting(containerEl)
      .setName("Default token type")
      .setDesc("Used for the first seal of a new container. Existing containers keep their own type.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("share", "Share (Shamir)")
          .addOption("master", "Master")
          .addOption("none", "Passphrase only")
          .setValue(this.plugin.settings.tokenType)
          .onChange(async (value) => {
            this.plugin.settings.tokenType = value as TokenType;
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    if (this.plugin.settings.tokenType === "share") {
      new Setting(containerEl).setName("Shares").addText((text) =>
        text.setValue(String(this.plugin.settings.shares)).onChange(async (value) => {
          this.plugin.settings.shares = Math.max(2, Number.parseInt(value, 10) || 5);
          await this.plugin.saveSettings();
        }),
      );
      new Setting(containerEl).setName("Threshold").addText((text) =>
        text.setValue(String(this.plugin.settings.threshold)).onChange(async (value) => {
          this.plugin.settings.threshold = Math.max(2, Number.parseInt(value, 10) || 3);
          await this.plugin.saveSettings();
        }),
      );
    }
    new Setting(containerEl)
      .setName("Token integrity protection (HMAC)")
      .setDesc(
        "For new share/master containers: encrypt the tokens with an integrity " +
          "passphrase (recommended). Off means the tokens alone unlock the vault, " +
          "with no passphrase. Existing containers keep their own setting.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.integrityEnabled).onChange(async (value) => {
          this.plugin.settings.integrityEnabled = value;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Gather entropy by drawing")
      .setDesc(
        "When creating a share/master container, mix randomness from a drawing " +
          "gesture into the auto-generated container key (combined with system " +
          "entropy, never weaker).",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.collectEntropyByDrawing).onChange(async (value) => {
          this.plugin.settings.collectEntropyByDrawing = value;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Confirm before locking")
      .setDesc("Ask for confirmation before a lock removes plaintext.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.confirmBeforeLock).onChange(async (value) => {
          this.plugin.settings.confirmBeforeLock = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}

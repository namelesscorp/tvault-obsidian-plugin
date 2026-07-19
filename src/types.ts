// Shared types, constants, and defaults for the TrustVault plugin.

export type TokenType = "share" | "master" | "none";
export type IntegrityType = "hmac" | "none";
export type Operation = "seal" | "unseal" | "reseal";
export type VaultState = "locked" | "unlocked" | "empty" | "unknown";

export const VIEW_TYPE_TVAULT = "tvault-panel";
// State file lives inside the Obsidian config dir so it survives the plaintext
// cleanup that a lock performs on the rest of the vault.
export const STATE_FILE = "tvault-state.json";
// Notes are moved here during a lock so only they (never .obsidian) are packed
// into the container. It is removed once the container is verified.
export const STAGE_DIR = ".tvault-stage";
export const CLOSING_MARKER = ".tvault-closing";

export interface TVaultSettings {
  cliPath: string;
  containerPath: string;
  tokenPath: string;
  tokenType: TokenType;
  shares: number;
  threshold: number;
  confirmBeforeLock: boolean;
  integrityEnabled: boolean;
  collectEntropyByDrawing: boolean;
  rememberKeysForSession: boolean;
}

export const DEFAULT_SETTINGS: TVaultSettings = {
  cliPath: "",
  containerPath: "",
  tokenPath: "",
  tokenType: "share",
  shares: 5,
  threshold: 3,
  confirmBeforeLock: true,
  integrityEnabled: true,
  collectEntropyByDrawing: true,
  rememberKeysForSession: true,
};

// Persisted lock/unlock state. The live vault contents are the source of truth;
// this record carries hints (token type, last container) across sessions.
export interface TVaultStateFile {
  sealed: boolean;
  containerPath: string;
  tokenType: TokenType;
  fileCount: number;
  updatedAt: string;
}

// Everything `tvault-core container info` reports. Older cores may omit some
// fields; the parser fills them with harmless defaults.
export interface ContainerInfo {
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
  comment: string;
  tags: string[];
  token_type: string;
  integrity_provider_type: string;
  compression_type: string;
  shares: number;
  threshold: number;
  file_count: number;
  compressed_size: number;
  uncompressed_size: number;
  security_score: number; // 0.0–1.0
}

export interface VaultStatus {
  state: VaultState;
  operation: Operation;
  containerExists: boolean;
  containerPath: string;
  noteCount: number;
  tokenType: TokenType;
  integrityType: IntegrityType;
  // Full container metadata for the details panel (null until a container exists).
  info: ContainerInfo | null;
}

// A single CLI invocation. tokenIO decides how tokens flow: a pasted flag with
// stdout capture, or a file for both reading and writing. folderPathOverride
// lets a lock pack the staging directory instead of the whole vault.
export interface RunSpec {
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

export interface RunResult {
  tokens: string[] | null;
  stdout: string;
}

// Values collected from the panel (or synthesized for a command) and handed to
// lock()/unlock().
export interface OpInput {
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

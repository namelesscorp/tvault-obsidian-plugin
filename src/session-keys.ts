import { readFile } from "fs/promises";
import { parseTokenList } from "./util";

export interface HeldKeys {
  tokens: string[];
  integrityPassphrase: string;
}

// SessionKeyStore - in-memory keys (token list + integrity passphrase) keyed by
// absolute container path. Never persisted; the plugin clears it on unload, so
// keys survive only while Obsidian stays open. The `enabled` gate reflects the
// "Hold keys for the session" setting, read at call time.
export class SessionKeyStore {
  private readonly keys = new Map<string, HeldKeys>();

  constructor(private readonly enabled: () => boolean) {}

  has(containerPath: string): boolean {
    return this.enabled() && this.keys.has(containerPath);
  }

  // Clear the whole cache, or just one container's entry.
  forget(containerPath?: string): void {
    if (containerPath) {
      this.keys.delete(containerPath);
    } else {
      this.keys.clear();
    }
  }

  remember(containerPath: string, tokens: string[], integrityPassphrase: string): void {
    if (!this.enabled() || tokens.length === 0) {
      return;
    }
    this.keys.set(containerPath, { tokens: [...tokens], integrityPassphrase });
  }

  recall(containerPath: string): HeldKeys | undefined {
    return this.enabled() ? this.keys.get(containerPath) : undefined;
  }
}

// readTokenFileList - a token file's token_list (best-effort) so keys entered
// via a file can also be held for the session.
export async function readTokenFileList(tokenFilePath: string): Promise<string[]> {
  try {
    return parseTokenList(await readFile(tokenFilePath, "utf8"));
  } catch {
    return [];
  }
}

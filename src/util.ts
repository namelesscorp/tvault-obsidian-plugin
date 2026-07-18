import { randomBytes } from "crypto";

// extractJsonWithKey - pull the JSON object that contains `key` out of stdout,
// which is interleaved with "PROGRESS <n>" lines and possibly log JSON. It
// brace-matches from the object opening so surrounding output is ignored.
export function extractJsonWithKey(stdout: string, key: string): Record<string, unknown> | null {
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

export function extractTokenList(stdout: string): string[] | null {
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
export function generateEntropyPassphrase(): string {
  return randomBytes(32).toString("base64");
}

// parseTokenList - turn whatever the user pasted (pretty JSON from a previous
// seal, or a plain list separated by new lines / commas / pipes) into a clean
// array of individual tokens. Tokens themselves are single-line base64 with no
// commas/pipes/newlines, so the delimiter split never severs one.
export function parseTokenList(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { token_list?: unknown };
      if (Array.isArray(parsed.token_list)) {
        return parsed.token_list
          .map((entry) => String(entry).trim())
          .filter((entry) => entry.length > 0);
      }
    } catch {
      // fall through to delimiter splitting
    }
  }
  return trimmed
    .split(/[\r\n|,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// normalizeTokensToFlag - the canonical {"token_list":[...]} flag the CLI reader
// expects, built from whatever the user pasted.
export function normalizeTokensToFlag(input: string): { flag: string; count: number } {
  const list = parseTokenList(input);
  return { flag: JSON.stringify({ token_list: list }), count: list.length };
}

// errorMessage - the human-readable message from an unknown thrown value.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// formatBytes - a compact human-readable size (e.g. 1536 -> "1.5 KB").
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

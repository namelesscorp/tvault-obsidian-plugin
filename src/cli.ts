import { Notice, requestUrl } from "obsidian";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { RunSpec } from "./types";
import { errorMessage, extractJsonWithKey } from "./util";

// Injected at build time from cli.json / cli-checksums.json (see esbuild.config.mjs).
declare const TVAULT_CLI_REPO: string;
declare const TVAULT_CLI_VERSION: string;
declare const TVAULT_CLI_CHECKSUMS: Record<string, string>;

// The tvault-core binary name for the current platform, e.g.
// tvault-core-darwin-arm64 or tvault-core-windows-amd64.exe.
export function cliBinaryName(): string {
  const goos = process.platform === "win32" ? "windows" : process.platform;
  const goarch = process.arch === "x64" ? "amd64" : process.arch;
  const ext = process.platform === "win32" ? ".exe" : "";
  return `tvault-core-${goos}-${goarch}${ext}`;
}

// verifyChecksum - true if the file matches its pinned SHA-256. If no checksum
// is pinned (a local dev build), verification is skipped.
export async function verifyChecksum(file: string, name: string): Promise<boolean> {
  const expected = TVAULT_CLI_CHECKSUMS[name];
  if (!expected) {
    return true;
  }
  const actual = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  return actual === expected;
}

// downloadCli - fetch the platform binary from the pinned tvault-core release.
export async function downloadCli(name: string, dest: string): Promise<void> {
  if (!TVAULT_CLI_VERSION) {
    throw new Error("No tvault-core release is pinned; set the executable path in settings");
  }
  const url = `https://github.com/${TVAULT_CLI_REPO}/releases/download/${TVAULT_CLI_VERSION}/${name}`;
  const notice = new Notice(`TVault: downloading tvault-core (${name})…`, 0);
  try {
    // Use Obsidian's requestUrl (routed through the main process) rather than
    // fetch(): the renderer's origin (app://obsidian.md) makes a cross-origin
    // fetch to GitHub's redirected asset host fail CORS with "Failed to fetch".
    // requestUrl bypasses CORS and follows the release-download redirect.
    const response = await requestUrl({ url, throw: false });
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const bytes = Buffer.from(response.arrayBuffer);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  } catch (error) {
    throw new Error(`Could not download tvault-core: ${errorMessage(error)}`);
  } finally {
    notice.hide();
  }
}

// buildArgs - assemble the tvault-core argument vector for one operation. Pure:
// it depends only on the spec and the two paths, so it is trivially testable.
export function buildArgs(spec: RunSpec, vaultPath: string, containerPath: string): string[] {
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

// extractCliError - the best human-readable error from CLI output: the JSON
// `message` if present, otherwise the last few non-progress lines.
export function extractCliError(output: string, code: number | null): string {
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

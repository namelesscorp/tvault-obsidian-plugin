import type { App, PluginManifest } from "obsidian";
import { homedir } from "os";
import path from "path";
import { cliBinaryName } from "./cli";
import type { TVaultSettings } from "./types";

// VaultPaths - resolves the vault root and the container / token / CLI locations,
// and enforces that user-chosen files sit outside the note area. Settings are
// read through a getter so a later settings reload is always reflected.
export class VaultPaths {
  constructor(
    private readonly app: App,
    private readonly manifest: PluginManifest,
    private readonly getSettings: () => TVaultSettings,
  ) {}

  getVaultPath(): string {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    if (!adapter.getBasePath) {
      throw new Error("TVault requires Obsidian desktop with a local filesystem vault");
    }
    return path.resolve(adapter.getBasePath());
  }

  // The user's config folder is usually `.obsidian` but can be renamed.
  configDirName(): string {
    return this.app.vault.configDir;
  }

  resolveConfiguredPath(value: string): string {
    if (!value.trim()) {
      return "";
    }
    return path.resolve(value.replace(/^~(?=$|\/|\\)/, homedir()));
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

  cliCachePath(): string {
    return path.join(this.getPluginDir(), "bin", cliBinaryName());
  }

  // A container/token file is safe if it is fully outside the vault, OR inside
  // the vault's config dir (.obsidian) — which is preserved on lock and never
  // staged. It must NOT sit in the note area, where it would be sealed into
  // itself and then deleted.
  isSafeVaultSideLocation(vaultPath: string, target: string): boolean {
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

  defaultTokenPath(vaultPath: string): string {
    return path.join(
      vaultPath,
      this.configDirName(),
      "tvault",
      `${path.basename(vaultPath)}.keys.json`,
    );
  }

  effectiveContainerPath(vaultPath: string): string {
    return (
      this.resolveConfiguredPath(this.getSettings().containerPath) ||
      this.defaultContainerPath(vaultPath)
    );
  }

  resolveContainerPath(vaultPath: string): string {
    const containerPath = this.effectiveContainerPath(vaultPath);
    if (!this.isSafeVaultSideLocation(vaultPath, containerPath)) {
      throw new Error("The container must be outside the vault or inside its config folder");
    }
    return containerPath;
  }
}

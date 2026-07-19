import { App, PluginSettingTab, Setting } from "obsidian";
import type TVaultPlugin from "./plugin";
import { TokenType } from "./types";
import { browseForContainer, browseForExistingFile } from "./dialogs";

export class TVaultSettingTab extends PluginSettingTab {
  private readonly plugin: TVaultPlugin;

  constructor(app: App, plugin: TVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const cfg = this.app.vault.configDir; // usually ".obsidian", but user-configurable
    containerEl.createEl("p", {
      text:
        "Locking encrypts the vault into the container and removes the " +
        `plaintext (the ${cfg} config is always preserved). Leave the paths ` +
        "empty to keep the container and token file self-contained under " +
        `${cfg}/tvault/, or set paths outside the vault.`,
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
        `Empty → ${cfg}/tvault/<vault>.tvlt (self-contained). Or an absolute ` +
          "path outside the vault. It must never sit in the note area.",
      )
      .addText((text) =>
        text
          .setPlaceholder(`(default) ${cfg}/tvault/<vault>.tvlt`)
          .setValue(this.plugin.settings.containerPath)
          .onChange(async (value) => {
            this.plugin.settings.containerPath = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Browse").onClick(async () => {
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
        `Empty → ${cfg}/tvault/<vault>.keys.json. Used by the command palette ` +
          "and the panel's token-file option; not used with token type none.",
      )
      .addText((text) =>
        text
          .setPlaceholder(`(default) ${cfg}/tvault/<vault>.keys.json`)
          .setValue(this.plugin.settings.tokenPath)
          .onChange(async (value) => {
            this.plugin.settings.tokenPath = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Browse").onClick(async () => {
          const chosen = await browseForExistingFile(
            "Choose token file",
            this.plugin.settings.tokenPath,
            ["json"],
          );
          if (chosen) {
            this.plugin.settings.tokenPath = chosen;
            await this.plugin.saveSettings();
            this.display();
          }
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
      .setDesc(
        "Used for the first seal of a new container. Existing containers keep their own type.",
      )
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
    new Setting(containerEl)
      .setName("Hold keys for the session")
      .setDesc(
        "After you unlock or lock a share/master vault, keep its tokens (and " +
          "integrity passphrase) in memory so the next lock/unlock does not ask " +
          "again. Keys are never written to disk and are cleared when Obsidian " +
          "closes. Turn off to always re-enter them.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.rememberKeysForSession).onChange(async (value) => {
          this.plugin.settings.rememberKeysForSession = value;
          if (!value) {
            this.plugin.forgetSessionKeys();
          }
          await this.plugin.saveSettings();
        }),
      );
  }
}

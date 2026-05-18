import { App, PluginSettingTab, Setting } from "obsidian";
import type IssueBoardPlugin from "./main";
import { DEFAULT_TEMPLATE } from "./store/boardFile";

/**
 * Global plugin settings. Per-board state (drafts, statuses, issue folder,
 * etc.) lives inside each board's markdown file, not here.
 */
export interface IssueBoardSettings {
	/** Template used when a new board is created. Each board owns a copy. */
	defaultTemplate: string;
	/** Font size for the board view, in pixels. Unset means inherit. */
	fontSize?: number;
	/** Internal flag so the legacy migration runs at most once. */
	_migrated?: boolean;
}

export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

export const DEFAULT_SETTINGS: IssueBoardSettings = {
	defaultTemplate: DEFAULT_TEMPLATE,
	fontSize: DEFAULT_FONT_SIZE,
};

export class IssueBoardSettingTab extends PluginSettingTab {
	plugin: IssueBoardPlugin;

	constructor(app: App, plugin: IssueBoardPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			text:
				"Per-board settings (issue folder, ID prefix, statuses, drafts) are stored inside each board file's frontmatter. Edit the board file directly to change them.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Default template")
			.setDesc(
				"Markdown body used as the starting template for new boards. {{id}}, {{title}}, and {{body}} are replaced when issues are created."
			)
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.defaultTemplate)
					.onChange(async (value) => {
						this.plugin.settings.defaultTemplate = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 10;
				text.inputEl.classList.add("issue-board-template-input");
			});

		new Setting(containerEl)
			.setName("Font size")
			.setDesc(
				`Font size in pixels for the board view (${MIN_FONT_SIZE}–${MAX_FONT_SIZE}). Default is ${DEFAULT_FONT_SIZE}.`
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = String(MIN_FONT_SIZE);
				text.inputEl.max = String(MAX_FONT_SIZE);
				text.inputEl.step = "1";
				text.setValue(
					typeof this.plugin.settings.fontSize === "number"
						? String(this.plugin.settings.fontSize)
						: String(DEFAULT_FONT_SIZE)
				);
				text.onChange(async (value) => {
					const trimmed = value.trim();
					if (trimmed === "") {
						this.plugin.settings.fontSize = DEFAULT_FONT_SIZE;
					} else {
						const n = parseInt(trimmed, 10);
						if (!Number.isFinite(n)) return;
						const clamped = Math.min(
							MAX_FONT_SIZE,
							Math.max(MIN_FONT_SIZE, n)
						);
						this.plugin.settings.fontSize = clamped;
					}
					await this.plugin.saveSettings();
					this.plugin.applyFontSize();
				});
			});
	}
}

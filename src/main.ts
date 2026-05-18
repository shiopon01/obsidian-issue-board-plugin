import {
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
	ViewState,
	WorkspaceLeaf,
	normalizePath,
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	IssueBoardSettingTab,
	IssueBoardSettings,
} from "./settings";
import { BOARD_MARKER, ISSUE_BOARD_VIEW_TYPE } from "./types";
import { IssueBoardView } from "./ui/boardView";
import {
	buildDefaultBoardConfig,
	serializeBoardFile,
} from "./store/boardFile";

interface LegacyData extends IssueBoardSettings {
	issueFolder?: string;
	idPrefix?: string;
	nextIdNumber?: number;
	statuses?: unknown;
	defaultStatus?: string;
	template?: string;
	drafts?: unknown;
	listView?: unknown;
}

const FONT_SIZE_CSS_PROP = "--issue-board-font-size";

export default class IssueBoardPlugin extends Plugin {
	settings!: IssueBoardSettings;
	private fontPropApplied = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyFontSize();

		this.registerView(
			ISSUE_BOARD_VIEW_TYPE,
			(leaf) => new IssueBoardView(leaf, this)
		);

		this.addCommand({
			id: "create-new-board",
			name: "Create new board",
			callback: () => void this.createBoardInteractive(this.app.vault.getRoot()),
		});

		this.addSettingTab(new IssueBoardSettingTab(this.app, this));

		this.installLeafPatch();

		this.app.workspace.onLayoutReady(() => {
			void this.maybeMigrateLegacy();
			this.scanLeavesForBoardFiles();
		});

		// Folder right-click menu.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					this.addCreateBoardMenuItem(menu, file);
				}
			})
		);

		// Right-click on empty space inside the file explorer.
		this.registerDomEvent(document, "contextmenu", (evt) => {
			const target = evt.target as HTMLElement | null;
			if (!target) return;
			const explorer = target.closest(
				'.workspace-leaf-content[data-type="file-explorer"]'
			);
			if (!explorer) return;
			// Let item-specific clicks fall through to the file-menu event above.
			if (target.closest(".nav-file, .nav-folder-title")) return;
			evt.preventDefault();
			const menu = new Menu();
			this.addCreateBoardMenuItem(menu, this.app.vault.getRoot());
			menu.showAtMouseEvent(evt);
		});

		// Switch markdown files that are actually board files into the board view.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!file) return;
				void this.maybeSwitchToBoardView(file);
			})
		);

		// Keep open board stores in sync with vault changes.
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile) this.fanoutChange(file);
			})
		);
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile) this.fanoutChange(file);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				this.fanoutDelete(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile) this.fanoutRename(file, oldPath);
			})
		);
	}

	onunload(): void {
		// Leaves are kept across plugin reloads.
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<LegacyData> | null;
		const fontSize =
			typeof raw?.fontSize === "number" && Number.isFinite(raw.fontSize)
				? raw.fontSize
				: DEFAULT_SETTINGS.fontSize;
		this.settings = {
			defaultTemplate:
				typeof raw?.defaultTemplate === "string"
					? raw.defaultTemplate
					: DEFAULT_SETTINGS.defaultTemplate,
			fontSize,
			_migrated: raw?._migrated === true,
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Pushes the current font-size setting into a CSS custom property on
	 * <body>. styles.css reads it on `.issue-board-root`, so the value
	 * applies to every open board without re-rendering. The prop is cleared
	 * on unload via this.register.
	 */
	applyFontSize(): void {
		const size = this.settings.fontSize;
		const value =
			typeof size === "number" && Number.isFinite(size) && size > 0
				? `${size}px`
				: "";
		document.body.setCssProps({ [FONT_SIZE_CSS_PROP]: value });
		if (!this.fontPropApplied) {
			this.fontPropApplied = true;
			this.register(() => {
				document.body.setCssProps({ [FONT_SIZE_CSS_PROP]: "" });
			});
		}
	}

	private addCreateBoardMenuItem(menu: Menu, folder: TFolder) {
		menu.addItem((item) =>
			item
				.setTitle("Create new issue board")
				.setIcon("kanban-square")
				.onClick(() => void this.createBoardInteractive(folder))
		);
	}

	private async createBoardInteractive(folder: TFolder): Promise<void> {
		const parent = folder.path;
		const baseName = "Issue Board";
		let candidate = parent
			? `${parent}/${baseName}.md`
			: `${baseName}.md`;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(normalizePath(candidate))) {
			candidate = parent
				? `${parent}/${baseName} ${n}.md`
				: `${baseName} ${n}.md`;
			n += 1;
		}
		const path = normalizePath(candidate);
		const config = buildDefaultBoardConfig(path, this.settings.defaultTemplate);
		const content = serializeBoardFile(config, []);
		try {
			const file = await this.app.vault.create(path, content);
			// Open directly in the board view to avoid a brief markdown flash.
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.setViewState({
				type: ISSUE_BOARD_VIEW_TYPE,
				state: { file: file.path },
				active: true,
			});
		} catch (e) {
			new Notice(`Failed to create board: ${(e as Error).message}`);
		}
	}

	/**
	 * Patches WorkspaceLeaf.setViewState so that any attempt to open a board
	 * file as plain Markdown is rewritten to open the Issue Board view
	 * directly. This avoids the brief Markdown flash that would otherwise
	 * occur (and the occasional failure for the fallback file-open hook to
	 * fire in time). The patch is reverted automatically when the plugin
	 * unloads via this.register.
	 */
	private installLeafPatch() {
		const app = this.app;
		const proto = WorkspaceLeaf.prototype as unknown as {
			setViewState: (state: ViewState, eState?: unknown) => Promise<void>;
		};
		const original = proto.setViewState;
		proto.setViewState = function (this: WorkspaceLeaf, state, eState) {
			if (
				app.workspace.layoutReady &&
				state?.type === "markdown" &&
				typeof state.state === "object" &&
				state.state !== null
			) {
				const inner = state.state as { file?: unknown };
				const filePath =
					typeof inner.file === "string" ? inner.file : undefined;
				if (filePath) {
					const file = app.vault.getAbstractFileByPath(filePath);
					if (file instanceof TFile && file.extension === "md") {
						const cache = app.metadataCache.getFileCache(file);
						const fm = cache?.frontmatter as
							| Record<string, unknown>
							| undefined;
						if (fm && fm[BOARD_MARKER] === true) {
							state = { ...state, type: ISSUE_BOARD_VIEW_TYPE };
						}
					}
				}
			}
			return original.call(this, state, eState);
		};
		this.register(() => {
			proto.setViewState = original;
		});
	}

	private async maybeSwitchToBoardView(file: TFile): Promise<void> {
		if (file.extension !== "md") return;
		// Find a leaf currently showing this file in markdown mode.
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		const target = leaves.find(
			(leaf) =>
				leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path
		);
		if (!target) return;
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter as Record<string, unknown> | undefined;
		if (!fm || fm[BOARD_MARKER] !== true) return;
		await target.setViewState({
			type: ISSUE_BOARD_VIEW_TYPE,
			state: { file: file.path },
			active: true,
		});
	}

	private scanLeavesForBoardFiles() {
		// Convert any markdown leaves currently showing a board file when the
		// plugin first loads (e.g. after enabling at startup).
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			const file = view.file;
			if (!file || file.extension !== "md") continue;
			void this.maybeSwitchToBoardView(file);
		}
	}

	private forEachBoard(fn: (view: IssueBoardView) => void) {
		for (const leaf of this.app.workspace.getLeavesOfType(ISSUE_BOARD_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof IssueBoardView) fn(view);
		}
	}

	private fanoutChange(file: TFile) {
		this.forEachBoard((view) => {
			void view.store?.handleFileChange(file);
		});
	}

	private fanoutDelete(path: string) {
		this.forEachBoard((view) => view.store?.handleFileDelete(path));
	}

	private fanoutRename(file: TFile, oldPath: string) {
		this.forEachBoard((view) => view.store?.handleFileRename(file, oldPath));
	}

	private async maybeMigrateLegacy(): Promise<void> {
		const raw = (await this.loadData()) as LegacyData | null;
		if (!raw) return;
		if (raw._migrated) return;
		const looksLegacy =
			"drafts" in raw || "issueFolder" in raw || "idPrefix" in raw;
		if (!looksLegacy) return;

		// Build a board from the legacy state and write it to the vault root.
		const baseName = "Issue Board (migrated)";
		let candidate = `${baseName}.md`;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(normalizePath(candidate))) {
			candidate = `${baseName} ${n}.md`;
			n += 1;
		}
		const path = normalizePath(candidate);
		const config = buildDefaultBoardConfig(path, raw.template ?? this.settings.defaultTemplate);
		// Override defaults with what the user had configured before.
		if (typeof raw.issueFolder === "string") config.issueFolder = raw.issueFolder;
		if (typeof raw.idPrefix === "string") config.idPrefix = raw.idPrefix;
		if (typeof raw.nextIdNumber === "number") config.nextIdNumber = raw.nextIdNumber;
		if (Array.isArray(raw.statuses) && raw.statuses.length > 0) {
			config.statuses = raw.statuses as typeof config.statuses;
		}
		if (typeof raw.defaultStatus === "string") config.defaultStatus = raw.defaultStatus;
		if (typeof raw.template === "string") config.template = raw.template;
		if (raw.listView && typeof raw.listView === "object") {
			config.listView = { ...config.listView, ...(raw.listView as typeof config.listView) };
		}
		const drafts = Array.isArray(raw.drafts) ? (raw.drafts as never) : [];

		const content = serializeBoardFile(config, drafts);
		try {
			await this.app.vault.create(path, content);
			new Notice(`Migrated previous Issue Board data to ${path}`);
		} catch (e) {
			new Notice(`Migration failed: ${(e as Error).message}`);
			return;
		}
		this.settings._migrated = true;
		await this.saveSettings();
	}
}


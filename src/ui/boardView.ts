import {
	Menu,
	Notice,
	TextFileView,
	TFile,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import type IssueBoardPlugin from "../main";
import {
	BoardConfig,
	BoardFilter,
	DEFAULT_FIELDS,
	DEFAULT_FILTER,
	DEFAULT_HIDDEN_FIELDS,
	DEFAULT_PRIORITY,
	DraftIssue,
	Field,
	GroupBy,
	ISSUE_BOARD_VIEW_TYPE,
	Issue,
	IssueKind,
	Priority,
	SortBy,
	SortDirection,
	StatusDef,
	ViewMode,
} from "../types";
import { CreateIssueModal, EditIssueModal } from "./issueModal";
import { StatusModal } from "./statusModal";
import { ViewPopover } from "./viewPopover";
import { countChecklist } from "../utils/checklist";
import { IssueStore } from "../store/issueStore";
import {
	DEFAULT_TEMPLATE,
	parseBoardFile,
	serializeBoardFile,
} from "../store/boardFile";
import { joinTitleAndBody, splitTitleAndBody } from "../utils/titleBody";

interface DragState {
	issue: Issue;
	sourceEl: HTMLElement;
}

// GFM-style task list line: optional leading whitespace, dash, space, `[ ]`
// or `[x]`/`[X]`, optional space, then the line's text.
const CHECKBOX_LINE_RE = /^(\s*)- \[( |x|X)\] ?(.*)$/;
// Same shape but split so we can rewrite just the marker character.
const CHECKBOX_TOGGLE_RE = /^(\s*- \[)( |x|X)(\].*)$/;

export class IssueBoardView extends TextFileView {
	private plugin: IssueBoardPlugin;
	private mode: ViewMode = "kanban";
	private filter: BoardFilter = { ...DEFAULT_FILTER };
	private bodyEl!: HTMLElement;
	private headerEl!: HTMLElement;
	private storeChangeRef: { unsubscribe: () => void } | null = null;
	private drag: DragState | null = null;

	private config: BoardConfig = {
		issueFolder: "Issues",
		idPrefix: "TASK",
		nextIdNumber: 1,
		statuses: [],
		defaultStatus: "todo",
		template: DEFAULT_TEMPLATE,
		listView: {
			groupBy: "none",
			sortBy: "manual",
			sortDirection: "asc",
			fields: [...DEFAULT_FIELDS],
			hiddenFields: [...DEFAULT_HIDDEN_FIELDS],
			collapsedGroups: [],
		},
	};
	private drafts: DraftIssue[] = [];
	store: IssueStore | null = null;
	private viewPopover: ViewPopover | null = null;
	private headerDrag: {
		field: Field;
		indicator: HTMLElement;
		insertionField: Field | null;
	} | null = null;
	private editingDraftId: string | null = null;
	private editingValue = "";
	private cardClickTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: IssueBoardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return ISSUE_BOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Issue board";
	}

	getIcon(): string {
		return "kanban-square";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (!container) return;
		container.empty();
		container.addClass("issue-board-root");

		this.headerEl = container.createDiv({ cls: "issue-board-header" });
		this.bodyEl = container.createDiv({ cls: "issue-board-body" });

		// If the file data has already been loaded (setViewData ran before
		// onOpen), render now that the DOM is ready.
		if (this.store?.isLoaded()) this.render();
	}

	async onClose(): Promise<void> {
		this.viewPopover?.close();
		this.viewPopover = null;
		this.unbindStore();
	}

	/**
	 * Called by Obsidian when this view should load a file. We parse the
	 * board file into config + drafts, (re)build the store, and render.
	 */
	setViewData(data: string, _clear: boolean): void {
		this.data = data;
		try {
			const parsed = parseBoardFile(data);
			this.config = parsed.config;
			this.drafts = parsed.drafts;
		} catch (e) {
			new Notice(`Failed to parse board file: ${(e as Error).message}`);
			return;
		}
		this.rebuildStore();
		void this.initialLoad();
	}

	getViewData(): string {
		return serializeBoardFile(this.config, this.drafts);
	}

	clear(): void {
		this.unbindStore();
		this.drafts = [];
		this.bodyEl?.empty();
		this.headerEl?.empty();
	}

	private rebuildStore() {
		this.unbindStore();
		this.store = new IssueStore(this.app, {
			config: this.config,
			drafts: this.drafts,
			save: () => this.requestSave(),
		});
		const ref = this.store.on("change", () => this.render());
		this.storeChangeRef = {
			unsubscribe: () => this.store?.offref(ref),
		};
	}

	private unbindStore() {
		this.storeChangeRef?.unsubscribe();
		this.storeChangeRef = null;
		this.store = null;
	}

	private async initialLoad() {
		if (!this.store) return;
		if (!this.store.isLoaded()) {
			await this.store.load();
		}
		this.render();
	}

	private surface(): { config: BoardConfig; store: IssueStore } {
		if (!this.store) throw new Error("Board store is not initialized.");
		return { config: this.config, store: this.store };
	}

	private render() {
		if (!this.headerEl || !this.bodyEl || !this.store) return;
		this.renderHeader();
		this.renderBody();
	}

	private renderHeader() {
		this.headerEl.empty();

		const left = this.headerEl.createDiv({ cls: "issue-board-header-left" });
		const right = this.headerEl.createDiv({ cls: "issue-board-header-right" });

		const modes: Array<{ id: ViewMode; label: string; icon: string }> = [
			{ id: "kanban", label: "Kanban", icon: "kanban-square" },
			{ id: "list", label: "List", icon: "list" },
		];
		const modeGroup = left.createDiv({ cls: "issue-board-mode-group" });
		for (const m of modes) {
			const btn = modeGroup.createEl("button", {
				cls: "issue-board-mode-button" + (this.mode === m.id ? " is-active" : ""),
				attr: { "aria-label": m.label, "aria-pressed": String(this.mode === m.id) },
			});
			setIcon(btn, m.icon);
			btn.createSpan({ text: m.label });
			btn.addEventListener("click", () => {
				this.mode = m.id;
				this.render();
			});
		}

		const search = left.createEl("input", {
			cls: "issue-board-search",
			attr: { type: "search", placeholder: "Search title or ID" },
		});
		search.value = this.filter.query;
		search.addEventListener("input", () => {
			this.filter.query = search.value;
			this.renderBody();
		});

		const statusFilter = left.createDiv({ cls: "issue-board-status-filter" });
		statusFilter.createSpan({ text: "Status:", cls: "issue-board-filter-label" });
		const allChip = statusFilter.createEl("button", {
			cls:
				"issue-board-chip" +
				(this.filter.statuses.length === 0 ? " is-active" : ""),
			text: "All",
		});
		allChip.addEventListener("click", () => {
			this.filter.statuses = [];
			this.render();
		});
		for (const s of this.config.statuses) {
			const active = this.filter.statuses.includes(s.id);
			const chip = statusFilter.createEl("button", {
				cls: "issue-board-chip" + (active ? " is-active" : ""),
				text: s.name,
			});
			chip.addEventListener("click", () => {
				if (active) {
					this.filter.statuses = this.filter.statuses.filter((id) => id !== s.id);
				} else {
					this.filter.statuses = [...this.filter.statuses, s.id];
				}
				this.render();
			});
		}

		const kindFilter = left.createDiv({ cls: "issue-board-status-filter" });
		kindFilter.createSpan({ text: "Type:", cls: "issue-board-filter-label" });
		const kinds: Array<{ id: IssueKind; label: string }> = [
			{ id: "file", label: "File" },
			{ id: "draft", label: "Draft" },
		];
		for (const k of kinds) {
			const active = this.filter.kinds.includes(k.id);
			const chip = kindFilter.createEl("button", {
				cls: "issue-board-chip" + (active ? " is-active" : ""),
				text: k.label,
			});
			chip.addEventListener("click", () => {
				if (active && this.filter.kinds.length > 1) {
					this.filter.kinds = this.filter.kinds.filter((id) => id !== k.id);
				} else if (!active) {
					this.filter.kinds = [...this.filter.kinds, k.id];
				}
				this.render();
			});
		}

		const viewBtn = right.createEl("button", {
			cls: "issue-board-view-button",
			attr: { "aria-label": "View options" },
		});
		setIcon(viewBtn, "settings-2");
		viewBtn.createSpan({ text: "View" });
		viewBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.openViewPopover(viewBtn);
		});
	}

	private renderBody() {
		this.bodyEl.empty();
		const issues = this.getFilteredIssues();

		if (issues.length === 0) {
			this.bodyEl.createDiv({
				cls: "issue-board-empty",
				text:
					"No issues match the current filter. Use the + button on a column or row to create one.",
			});
			return;
		}

		if (this.mode === "list") {
			this.renderList(issues);
		} else {
			this.renderKanban(issues);
		}
	}

	private getFilteredIssues(): Issue[] {
		const q = this.filter.query.trim().toLowerCase();
		return this.store!
			.getAll()
			.filter((issue) => {
				if (!this.filter.kinds.includes(issue.kind)) return false;
				if (this.filter.statuses.length > 0 && !this.filter.statuses.includes(issue.status)) {
					return false;
				}
				if (q) {
					const haystack = `${issue.id} ${issue.title}`.toLowerCase();
					if (!haystack.includes(q)) return false;
				}
				return true;
			})
			.sort((a, b) => {
				if (a.order !== b.order) return a.order - b.order;
				return a.createdAt - b.createdAt;
			});
	}

	private renderList(issues: Issue[]) {
		const lv = this.config.listView;
		const sorted = sortIssues(issues, lv.sortBy, lv.sortDirection, this.config.statuses);
		const groups = groupIssues(sorted, lv.groupBy, this.config.statuses);
		const dndEnabled = lv.sortBy === "manual";
		const allFields = lv.fields.length > 0 ? lv.fields : DEFAULT_FIELDS;
		const hidden = new Set(lv.hiddenFields);
		const visibleFields = allFields.filter((f) => !hidden.has(f));
		const gridTemplate = buildGridTemplate(visibleFields);

		const container = this.bodyEl.createDiv({ cls: "issue-board-list-container" });

		// Single column header at the top, aligned to the same grid template.
		this.renderListHeader(container, visibleFields, gridTemplate);

		for (const group of groups) {
			if (group.items.length === 0 && lv.groupBy === "none") continue;
			const isCollapsed =
				lv.groupBy !== "none" && lv.collapsedGroups.includes(group.key);
			if (lv.groupBy !== "none") {
				this.renderGroupHeader(container, group, isCollapsed);
			}
			if (isCollapsed) continue;

			const list = container.createDiv({
				cls: "issue-board-list" + (dndEnabled ? "" : " is-static"),
			});
			for (const issue of group.items) {
				const row = list.createDiv({ cls: "issue-board-row" });
				row.style.gridTemplateColumns = gridTemplate;
				if (dndEnabled) {
					const handle = row.createSpan({ cls: "issue-board-drag-handle" });
					setIcon(handle, "grip-vertical");
				} else {
					row.createSpan({ cls: "issue-board-drag-handle is-hidden" });
				}
				for (const field of visibleFields) {
					this.renderRowCell(row, issue, field);
				}
				row.addEventListener("click", () => this.openIssue(issue));
				row.addEventListener("contextmenu", (evt) => this.showContextMenu(evt, issue));
				if (dndEnabled) this.makeDraggable(row, issue);
			}
			if (dndEnabled) {
				this.makeListDropZone(list, { groupBy: lv.groupBy, groupKey: group.key });
			}

			// "+ Add item" footer per group, spanning full width.
			const addRow = list.createDiv({ cls: "issue-board-add-row" });
			const addIcon = addRow.createSpan({ cls: "issue-board-add-row-icon" });
			setIcon(addIcon, "plus");
			addRow.createSpan({
				cls: "issue-board-add-row-text",
				text: "Add item",
			});
			addRow.addEventListener("click", () => {
				const prefill = this.prefillForGroup(lv.groupBy, group.key);
				new CreateIssueModal(this.app, this.surface(), {
					...prefill,
					asDraft: prefill?.asDraft ?? true,
				}).open();
			});
		}
	}

	private renderListHeader(
		container: HTMLElement,
		visibleFields: Field[],
		gridTemplate: string
	) {
		const lv = this.config.listView;
		const header = container.createDiv({ cls: "issue-board-list-header" });
		header.style.gridTemplateColumns = gridTemplate;
		// Empty cell aligning with the drag handle column.
		header.createSpan({ cls: "issue-board-list-header-spacer" });
		header.addEventListener("dragover", (evt) =>
			this.handleHeaderDragOver(header, evt)
		);
		header.addEventListener("drop", (evt) => this.handleHeaderDrop(evt));
		for (const field of visibleFields) {
			const cell = header.createDiv({
				cls: `issue-board-list-header-cell issue-board-cell-${field}`,
			});
			cell.dataset.fieldId = field;
			this.makeHeaderCellDraggable(cell, field);
			cell.createSpan({ text: FIELD_LABELS[field] });
			const sortKey = FIELD_SORT_KEY[field];
			if (sortKey) {
				cell.addClass("is-sortable");
				if (lv.sortBy === sortKey) {
					cell.addClass("is-sorted");
					const arrow = cell.createSpan({ cls: "issue-board-sort-arrow" });
					setIcon(arrow, lv.sortDirection === "asc" ? "arrow-up" : "arrow-down");
				}
				cell.addEventListener("click", () => {
					// Cycle: not-this-key → asc → desc → manual → ...
					if (lv.sortBy !== sortKey) {
						lv.sortBy = sortKey;
						lv.sortDirection = "asc";
					} else if (lv.sortDirection === "asc") {
						lv.sortDirection = "desc";
					} else {
						lv.sortBy = "manual";
						lv.sortDirection = "asc";
					}
					this.requestSave();
					this.render();
				});
			}
		}
	}

	private renderGroupHeader(
		container: HTMLElement,
		group: IssueGroup,
		isCollapsed: boolean
	) {
		const lv = this.config.listView;
		const header = container.createDiv({
			cls:
				"issue-board-list-group-header" +
				(isCollapsed ? " is-collapsed" : ""),
		});
		const chevron = header.createSpan({ cls: "issue-board-group-chevron" });
		setIcon(chevron, isCollapsed ? "chevron-right" : "chevron-down");
		header.createSpan({
			cls: "issue-board-list-group-title",
			text: group.label,
		});
		header.createSpan({
			cls: "issue-board-list-group-count",
			text: String(group.items.length),
		});
		header.addEventListener("click", () => {
			const next = isCollapsed
				? lv.collapsedGroups.filter((k) => k !== group.key)
				: [...lv.collapsedGroups, group.key];
			lv.collapsedGroups = next;
			this.requestSave();
			this.render();
		});
	}

	private renderRowCell(row: HTMLElement, issue: Issue, field: Field) {
		const cell = row.createDiv({
			cls: `issue-board-cell issue-board-cell-${field}`,
		});
		switch (field) {
			case "id":
				cell.addClass("issue-board-id");
				this.appendIssueIdEl(cell, issue);
				break;
			case "title":
				cell.setText(issue.title);
				cell.addClass("issue-board-title");
				break;
			case "status":
				this.appendStatusBadge(cell, issue.status);
				break;
			case "priority":
				appendPriorityBadge(cell, issue.priority);
				break;
			case "due":
				if (issue.due) {
					cell.setText(issue.due);
					cell.addClass("issue-board-due");
					const cls = dueDateClass(issue.due);
					if (cls) cell.addClass(cls);
				}
				break;
			case "created":
				cell.setText(formatDate(issue.createdAt));
				cell.addClass("issue-board-due");
				break;
			case "updated":
				cell.setText(formatDate(issue.updatedAt));
				cell.addClass("issue-board-due");
				break;
			case "checklist":
				this.appendChecklistBadge(cell, issue.body);
				break;
		}
	}

	private prefillForGroup(
		groupBy: GroupBy,
		groupKey: string
	): { status?: string; asDraft?: boolean } | undefined {
		if (groupBy === "status") return { status: groupKey };
		if (groupBy === "kind") return { asDraft: groupKey === "draft" };
		return undefined;
	}

	private renderKanban(issues: Issue[]) {
		const lv = this.config.listView;
		// Apply current sort within each column.
		const sorted = sortIssues(
			issues,
			lv.sortBy,
			lv.sortDirection,
			this.config.statuses
		);
		const board = this.bodyEl.createDiv({ cls: "issue-board-kanban" });
		const statuses: StatusDef[] = [...this.config.statuses];
		// Ensure unknown statuses still get a column.
		for (const issue of sorted) {
			if (!statuses.some((s) => s.id === issue.status)) {
				statuses.push({ id: issue.status, name: issue.status });
			}
		}
		for (const status of statuses) {
			const col = board.createDiv({ cls: "issue-board-column" });
			const head = col.createDiv({ cls: "issue-board-column-head" });
			const headLeft = head.createDiv({ cls: "issue-board-column-head-left" });
			const titleSpan = headLeft.createSpan({
				cls: "issue-board-column-title",
				text: status.name,
			});
			if (status.color) {
				titleSpan.style.setProperty("--issue-board-status-color", status.color);
				titleSpan.addClass("has-color");
			}
			const columnIssues = sorted.filter((i) => i.status === status.id);
			headLeft.createSpan({
				cls: "issue-board-column-count",
				text: String(columnIssues.length),
			});
			const headRight = head.createDiv({ cls: "issue-board-column-head-right" });
			const moreBtn = headRight.createEl("button", {
				cls: "issue-board-column-more",
				attr: { "aria-label": `Status options for ${status.name}` },
			});
			setIcon(moreBtn, "more-horizontal");
			moreBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.openStatusMenu(evt, status);
			});
			const addBtn = headRight.createEl("button", {
				cls: "issue-board-column-add",
				attr: { "aria-label": `Add issue to ${status.name}` },
			});
			setIcon(addBtn, "plus");
			addBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				new CreateIssueModal(this.app, this.surface(), {
					status: status.id,
				}).open();
			});
			const body = col.createDiv({ cls: "issue-board-column-body" });
			for (const issue of columnIssues) {
				if (
					issue.kind === "draft" &&
					this.editingDraftId === issue.id
				) {
					const card = body.createDiv({
						cls: "issue-board-card is-editing",
					});
					this.renderDraftEditor(card);
					continue;
				}
				const card = body.createDiv({ cls: "issue-board-card" });
				this.appendIssueIdEl(
					card.createDiv({ cls: "issue-board-card-id" }),
					issue
				);
				card.createDiv({ cls: "issue-board-card-title", text: issue.title });
				if (issue.kind === "draft" && issue.body.trim() !== "") {
					this.renderDraftCardBody(card, issue);
				}
				const meta = card.createDiv({ cls: "issue-board-card-meta" });
				this.appendChecklistBadge(meta, issue.body);
				appendPriorityBadge(meta, issue.priority);
				if (issue.due) {
					const cls = dueDateClass(issue.due);
					const dueEl = meta.createSpan({
						cls: "issue-board-card-due" + (cls ? ` ${cls}` : ""),
					});
					const icon = dueEl.createSpan({ cls: "issue-board-card-due-icon" });
					setIcon(icon, "calendar");
					dueEl.createSpan({ text: issue.due });
				}
				if (issue.kind === "draft") {
					card.addEventListener("click", () =>
						this.handleDraftCardClick(issue)
					);
					card.addEventListener("dblclick", () => {
						if (this.cardClickTimer !== null) {
							window.clearTimeout(this.cardClickTimer);
							this.cardClickTimer = null;
						}
						this.startInlineEdit(issue);
					});
				} else {
					card.addEventListener("click", () => this.openIssue(issue));
				}
				card.addEventListener("contextmenu", (evt) =>
					this.showContextMenu(evt, issue)
				);
				this.makeDraggable(card, issue);
			}
			if (columnIssues.length === 0) {
				body.createDiv({
					cls: "issue-board-column-empty",
					text: "No issues",
				});
			}
			this.makeColumnDropZone(body, status.id);
		}

		// Trailing "+ Add status" affordance, similar to kanban-style boards.
		const addStatusBtn = board.createDiv({ cls: "issue-board-add-status" });
		const addIcon = addStatusBtn.createSpan({ cls: "issue-board-add-status-icon" });
		setIcon(addIcon, "plus");
		addStatusBtn.createSpan({ text: "Add status" });
		addStatusBtn.addEventListener("click", () => this.openStatusEditor(null));
	}

	private appendStatusBadge(parent: HTMLElement, statusId: string) {
		const def = this.config.statuses.find((s) => s.id === statusId);
		const badge = parent.createSpan({
			cls: "issue-board-status-badge",
			text: def?.name ?? statusId,
		});
		if (def?.color) {
			badge.style.setProperty("--issue-board-status-color", def.color);
		}
	}

	private appendIssueIdEl(el: HTMLElement, issue: Issue) {
		if (issue.kind === "draft") {
			el.setText("Draft");
			el.addClass("is-draft");
		} else {
			el.setText(issue.id);
		}
	}

	private appendChecklistBadge(parent: HTMLElement, body: string) {
		const { total, done } = countChecklist(body);
		if (total === 0) return;
		const complete = done === total;
		const badge = parent.createSpan({
			cls:
				"issue-board-checklist-badge" +
				(complete ? " is-complete" : ""),
		});
		const icon = badge.createSpan({ cls: "issue-board-checklist-icon" });
		setIcon(icon, complete ? "check-circle-2" : "list-checks");
		badge.createSpan({
			cls: "issue-board-checklist-count",
			text: `${done}/${total}`,
		});
	}

	private renderDraftCardBody(card: HTMLElement, issue: DraftIssue) {
		const bodyEl = card.createDiv({ cls: "issue-board-card-body" });
		const lines = issue.body.split("\n");
		lines.forEach((line, idx) => {
			const lineEl = bodyEl.createDiv({
				cls: "issue-board-card-body-line",
			});
			const match = CHECKBOX_LINE_RE.exec(line);
			if (match) {
				const indent = match[1] ?? "";
				const mark = match[2] ?? " ";
				const text = match[3] ?? "";
				lineEl.addClass("has-checkbox");
				if (indent.length > 0) {
					lineEl.setCssStyles({
						paddingLeft: `${indent.length * 6}px`,
					});
				}
				const checkbox = lineEl.createEl("input", {
					cls: "issue-board-card-checkbox",
					attr: { type: "checkbox" },
				});
				checkbox.checked = mark.toLowerCase() === "x";
				if (checkbox.checked) lineEl.addClass("is-checked");
				checkbox.addEventListener("click", (evt) => {
					evt.stopPropagation();
					void this.toggleDraftCheckbox(issue, idx);
				});
				checkbox.addEventListener("dblclick", (evt) =>
					evt.stopPropagation()
				);
				checkbox.addEventListener("mousedown", (evt) =>
					evt.stopPropagation()
				);
				checkbox.addEventListener("dragstart", (evt) =>
					evt.preventDefault()
				);
				lineEl.createSpan({
					cls: "issue-board-card-checkbox-text",
					text,
				});
			} else if (line === "") {
				lineEl.addClass("is-blank");
			} else {
				lineEl.setText(line);
			}
		});
	}

	private async toggleDraftCheckbox(issue: DraftIssue, lineIdx: number) {
		const lines = issue.body.split("\n");
		const line = lines[lineIdx];
		if (line === undefined) return;
		const m = CHECKBOX_TOGGLE_RE.exec(line);
		if (!m) return;
		const head = m[1] ?? "";
		const mark = m[2] ?? " ";
		const tail = m[3] ?? "";
		const newMark = mark.toLowerCase() === "x" ? " " : "x";
		lines[lineIdx] = `${head}${newMark}${tail}`;
		try {
			await this.store!.updateDraft(issue.id, {
				body: lines.join("\n"),
			});
		} catch (e) {
			new Notice(`Failed to toggle checkbox: ${(e as Error).message}`);
		}
	}

	private renderDraftEditor(card: HTMLElement) {
		const textarea = card.createEl("textarea", {
			cls: "issue-board-card-editor",
		});
		textarea.value = this.editingValue;
		textarea.rows = Math.max(3, this.editingValue.split("\n").length + 1);
		textarea.addEventListener("input", () => {
			this.editingValue = textarea.value;
			textarea.rows = Math.max(3, textarea.value.split("\n").length + 1);
		});
		textarea.addEventListener("keydown", (evt) => {
			if (evt.key === "Escape") {
				evt.preventDefault();
				this.cancelInlineEdit();
			} else if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey)) {
				evt.preventDefault();
				void this.commitInlineEdit();
			}
		});
		textarea.addEventListener("blur", () => void this.commitInlineEdit());
		textarea.addEventListener("click", (evt) => evt.stopPropagation());
		textarea.addEventListener("dblclick", (evt) => evt.stopPropagation());
		window.setTimeout(() => {
			textarea.focus();
			const len = textarea.value.length;
			textarea.setSelectionRange(len, len);
		}, 0);
	}

	private handleDraftCardClick(issue: Issue) {
		// Defer the modal-open so a follow-up dblclick can cancel it and
		// enter inline edit instead.
		if (this.cardClickTimer !== null) return;
		this.cardClickTimer = window.setTimeout(() => {
			this.cardClickTimer = null;
			this.openIssue(issue);
		}, 250);
	}

	private startInlineEdit(issue: DraftIssue) {
		this.editingDraftId = issue.id;
		this.editingValue = joinTitleAndBody(issue.title, issue.body);
		this.render();
	}

	private async commitInlineEdit() {
		const id = this.editingDraftId;
		if (id === null) return;
		const value = this.editingValue;
		this.editingDraftId = null;
		this.editingValue = "";
		const split = splitTitleAndBody(value);
		const title = split.title.trim();
		if (title === "") {
			// Drafts must keep a title; bail out without saving and let the
			// re-render restore the original card.
			this.render();
			return;
		}
		try {
			await this.store!.updateDraft(id, { title, body: split.body });
		} catch (e) {
			new Notice(`Failed to update draft: ${(e as Error).message}`);
			this.render();
		}
	}

	private cancelInlineEdit() {
		this.editingDraftId = null;
		this.editingValue = "";
		this.render();
	}

	private openIssue(issue: Issue) {
		if (issue.kind === "file") {
			const file = this.app.vault.getAbstractFileByPath(issue.path);
			if (file instanceof TFile) {
				// Always open in a new tab so the board view itself is
				// preserved.
				void this.app.workspace.getLeaf("tab").openFile(file);
				return;
			}
		}
		new EditIssueModal(this.app, this.surface(), issue).open();
	}

	private showContextMenu(evt: MouseEvent, issue: Issue) {
		evt.preventDefault();
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("Edit")
				.setIcon("pencil")
				.onClick(() => new EditIssueModal(this.app, this.surface(), issue).open())
		);

		for (const s of this.config.statuses) {
			if (s.id === issue.status) continue;
			menu.addItem((i) =>
				i
					.setTitle(`Move to ${s.name}`)
					.setIcon("chevrons-right")
					.onClick(async () => {
						try {
							if (issue.kind === "draft") {
								await this.store!.updateDraft(issue.id, { status: s.id });
							} else {
								await this.store!.updateFileIssue(issue.path, {
									status: s.id,
								});
							}
						} catch (e) {
							new Notice(`Failed to move issue: ${(e as Error).message}`);
						}
					})
			);
		}

		if (issue.kind === "draft") {
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle("Convert to file issue")
					.setIcon("file-plus")
					.onClick(async () => {
						try {
							const created = await this.store!.promoteDraft(issue.id);
							if (created) {
								new Notice(`${created.id} converted to file issue.`);
							}
						} catch (e) {
							new Notice(`Failed to convert: ${(e as Error).message}`);
						}
					})
			);
		}

		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Delete")
				.setIcon("trash")
				.onClick(async () => {
					try {
						if (issue.kind === "draft") {
							await this.store!.deleteDraft(issue.id);
						} else {
							await this.store!.deleteFileIssue(issue.path);
						}
					} catch (e) {
						new Notice(`Failed to delete: ${(e as Error).message}`);
					}
				})
		);

		menu.showAtMouseEvent(evt);
	}

	// --- Header column DnD --------------------------------------------------

	private makeHeaderCellDraggable(cell: HTMLElement, field: Field) {
		cell.setAttribute("draggable", "true");
		cell.addEventListener("dragstart", (evt) => {
			// Don't trigger the sort-cycle click after dragging.
			evt.stopPropagation();
			const headerEl = cell.parentElement;
			if (!headerEl) return;
			const headerRect = headerEl.getBoundingClientRect();
			const indicator = document.body.createDiv({
				cls: "issue-board-header-drop-indicator",
			});
			indicator.setCssStyles({
				position: "fixed",
				top: `${headerRect.top}px`,
				height: `${headerRect.height}px`,
				left: `${headerRect.left}px`,
				width: "3px",
			});
			this.headerDrag = { field, indicator, insertionField: null };
			if (evt.dataTransfer) {
				evt.dataTransfer.effectAllowed = "move";
				evt.dataTransfer.setData("text/plain", field);
			}
			window.setTimeout(() => cell.addClass("is-dragging"), 0);
		});
		cell.addEventListener("dragend", () => {
			cell.removeClass("is-dragging");
			if (this.headerDrag) {
				this.headerDrag.indicator.remove();
				this.headerDrag = null;
			}
		});
		// Suppress click after a drag to avoid toggling sort accidentally.
		cell.addEventListener("click", (evt) => {
			if (this.headerDrag) {
				evt.stopPropagation();
				evt.preventDefault();
			}
		}, true);
	}

	private handleHeaderDragOver(header: HTMLElement, evt: DragEvent) {
		if (!this.headerDrag) return;
		evt.preventDefault();
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
		const draggedField = this.headerDrag.field;
		const cells = Array.from(
			header.querySelectorAll<HTMLElement>("[data-field-id]")
		).filter((el) => el.dataset.fieldId !== draggedField);

		let insertionField: Field | null = null;
		let lineX = 0;
		for (const c of cells) {
			const rect = c.getBoundingClientRect();
			if (evt.clientX < rect.left + rect.width / 2) {
				insertionField = (c.dataset.fieldId as Field) ?? null;
				lineX = rect.left;
				break;
			}
		}
		if (insertionField === null) {
			if (cells.length > 0) {
				const last = cells[cells.length - 1];
				if (last) lineX = last.getBoundingClientRect().right;
			} else {
				lineX = header.getBoundingClientRect().left;
			}
		}
		this.headerDrag.insertionField = insertionField;
		this.headerDrag.indicator.setCssStyles({
			left: `${Math.round(lineX) - 1}px`,
		});
	}

	private handleHeaderDrop(evt: DragEvent) {
		if (!this.headerDrag) return;
		evt.preventDefault();
		const moved = this.headerDrag.field;
		const before = this.headerDrag.insertionField;
		this.headerDrag.indicator.remove();
		this.headerDrag = null;

		const lv = this.config.listView;
		let next = lv.fields.filter((f) => f !== moved);
		if (before === null) {
			next.push(moved);
		} else {
			const idx = next.indexOf(before);
			if (idx >= 0) next.splice(idx, 0, moved);
			else next.push(moved);
		}
		if (arraysEqual(next, lv.fields)) return;
		lv.fields = next;
		this.requestSave();
		this.render();
	}

	// --- Status management --------------------------------------------------

	private openStatusMenu(evt: MouseEvent, status: StatusDef) {
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("Edit status")
				.setIcon("pencil")
				.onClick(() => this.openStatusEditor(status))
		);
		menu.addItem((i) =>
			i
				.setTitle("Delete status")
				.setIcon("trash")
				.onClick(() => this.openStatusEditor(status, { focusDelete: true }))
		);
		menu.showAtMouseEvent(evt);
	}

	private openStatusEditor(
		existing: StatusDef | null,
		_opts?: { focusDelete?: boolean }
	) {
		new StatusModal(this.app, existing, {
			onSave: (next, prevId) => this.commitStatusSave(next, prevId),
			onDelete: existing ? (id) => this.commitStatusDelete(id) : undefined,
		}).open();
	}

	private commitStatusSave(next: StatusDef, prevId: string | null) {
		const statuses = [...this.config.statuses];
		if (prevId) {
			const idx = statuses.findIndex((s) => s.id === prevId);
			if (idx >= 0) statuses[idx] = next;
		} else {
			let id = next.id;
			if (statuses.some((s) => s.id === id)) {
				let i = 2;
				while (statuses.some((s) => s.id === `${next.id}-${i}`)) i += 1;
				id = `${next.id}-${i}`;
			}
			statuses.push({ ...next, id });
		}
		this.config.statuses = statuses;
		this.requestSave();
		this.render();
	}

	private commitStatusDelete(id: string) {
		const used = (this.store?.getAll() ?? []).filter((i) => i.status === id).length;
		if (used > 0) {
			new Notice(
				`${used} issue${used === 1 ? "" : "s"} still use this status. Move or delete them first.`
			);
			throw new Error("Status in use.");
		}
		this.config.statuses = this.config.statuses.filter((s) => s.id !== id);
		if (this.config.defaultStatus === id) {
			const first = this.config.statuses[0];
			this.config.defaultStatus = first?.id ?? "todo";
		}
		this.requestSave();
		this.render();
	}

	// --- View popover -------------------------------------------------------

	private openViewPopover(anchor: HTMLElement) {
		if (this.viewPopover) {
			this.viewPopover.close();
			return;
		}
		this.viewPopover = new ViewPopover(
			{
				config: this.config,
				mode: this.mode,
				commit: () => {
					this.requestSave();
					this.render();
				},
				onClose: () => {
					this.viewPopover = null;
				},
			},
			anchor
		);
	}

	// --- Drag & drop --------------------------------------------------------

	private makeDraggable(el: HTMLElement, issue: Issue) {
		el.dataset.issueKey = issueKey(issue);
		el.setAttribute("draggable", "true");
		el.addEventListener("dragstart", (evt) => {
			this.drag = { issue, sourceEl: el };
			if (evt.dataTransfer) {
				evt.dataTransfer.effectAllowed = "move";
				evt.dataTransfer.setData("text/plain", issue.id);
			}
			// Defer the class so the browser captures the drag image
			// from the original opaque element first.
			window.setTimeout(() => el.classList.add("is-dragging"), 0);
		});
		el.addEventListener("dragend", () => {
			el.classList.remove("is-dragging");
			const wasDragging = this.drag !== null;
			this.drag = null;
			if (wasDragging) {
				// Cancelled drop — restore the original layout from the store.
				this.render();
			}
		});
	}

	private makeColumnDropZone(body: HTMLElement, statusId: string) {
		body.addEventListener("dragover", (evt) =>
			this.handleDragOver(evt, body, ".issue-board-card")
		);
		body.addEventListener("drop", (evt) =>
			this.handleDrop(evt, body, ".issue-board-card", statusId)
		);
	}

	private makeListDropZone(
		list: HTMLElement,
		ctx: { groupBy: GroupBy; groupKey: string }
	) {
		list.addEventListener("dragover", (evt) => {
			const dragged = this.drag?.issue;
			if (!dragged) return;
			// Reject drops that would cross a kind boundary — there's no way
			// to "convert" a draft↔file via DnD.
			if (ctx.groupBy === "kind" && dragged.kind !== ctx.groupKey) return;
			this.handleDragOver(evt, list, ".issue-board-row");
		});
		list.addEventListener("drop", (evt) => {
			const dragged = this.drag?.issue;
			if (!dragged) return;
			if (ctx.groupBy === "kind" && dragged.kind !== ctx.groupKey) return;
			const targetStatus =
				ctx.groupBy === "status" ? ctx.groupKey : dragged.status;
			this.handleDrop(evt, list, ".issue-board-row", targetStatus);
		});
	}

	private handleDragOver(
		evt: DragEvent,
		container: HTMLElement,
		selector: string
	) {
		if (!this.drag) return;
		evt.preventDefault();
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
		this.repositionDragged(container, selector, evt.clientY);
	}

	/**
	 * Moves the dragged element to the visual position implied by the
	 * pointer's Y, so the user sees a live preview of where the item will
	 * land. We keep the original element draggable so the native drag
	 * operation continues uninterrupted.
	 */
	private repositionDragged(
		container: HTMLElement,
		selector: string,
		y: number
	) {
		if (!this.drag) return;
		const draggedEl = this.drag.sourceEl;
		const candidates = Array.from(
			container.querySelectorAll<HTMLElement>(selector)
		).filter((el) => el !== draggedEl);

		let before: HTMLElement | null = null;
		for (const el of candidates) {
			const rect = el.getBoundingClientRect();
			if (y < rect.top + rect.height / 2) {
				before = el;
				break;
			}
		}
		if (before) {
			if (before.previousSibling !== draggedEl) {
				container.insertBefore(draggedEl, before);
			}
			return;
		}
		// Insert at end — but before any trailing non-issue rows such as
		// the "+ Add item" footer.
		const addRow = container.querySelector(".issue-board-add-row");
		if (addRow && addRow.parentElement === container) {
			if (addRow.previousSibling !== draggedEl) {
				container.insertBefore(draggedEl, addRow);
			}
		} else if (container.lastElementChild !== draggedEl) {
			container.appendChild(draggedEl);
		}
	}

	private handleDrop(
		evt: DragEvent,
		container: HTMLElement,
		selector: string,
		targetStatus: string
	) {
		if (!this.drag) return;
		evt.preventDefault();
		const dragged = this.drag.issue;
		const draggedEl = this.drag.sourceEl;
		this.drag = null;

		const all = this.store!.getAll();
		const prev = findIssueFromSibling(draggedEl, "previous", selector, all);
		const next = findIssueFromSibling(draggedEl, "next", selector, all);
		const newOrder = computeOrder(prev?.order, next?.order);

		if (
			dragged.status === targetStatus &&
			Math.abs(dragged.order - newOrder) < 1e-9
		) {
			// No semantic change. Re-render so DOM matches store ordering.
			this.render();
			return;
		}
		void (async () => {
			try {
				await this.store!.moveIssue(dragged, targetStatus, newOrder);
			} catch (e) {
				new Notice(`Failed to move issue: ${(e as Error).message}`);
				this.render();
			}
		})();
		// Container container suppresses cleanup
		void container;
	}
}

function issueKey(issue: Issue): string {
	return issue.kind === "file" ? `file:${issue.path}` : `draft:${issue.id}`;
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function appendPriorityBadge(parent: HTMLElement, priority: Priority | undefined) {
	// P4 (or unset) is the default and is rendered without a badge to keep
	// the view low-visual-noise — same convention as Todoist.
	if (!priority || priority === DEFAULT_PRIORITY) return;
	const badge = parent.createSpan({
		cls: `issue-board-priority issue-board-priority-p${priority}`,
	});
	const icon = badge.createSpan({ cls: "issue-board-priority-icon" });
	setIcon(icon, "flag");
	badge.createSpan({ text: `P${priority}` });
}

function dueDateClass(due: string): string {
	const today = new Date();
	const todayStr = `${today.getFullYear()}-${String(
		today.getMonth() + 1
	).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
	if (due < todayStr) return "is-overdue";
	if (due === todayStr) return "is-today";
	return "";
}

function findIssueFromSibling(
	el: HTMLElement,
	dir: "previous" | "next",
	selector: string,
	issues: Issue[]
): Issue | undefined {
	let sib: Element | null =
		dir === "previous" ? el.previousElementSibling : el.nextElementSibling;
	while (sib) {
		if (sib instanceof HTMLElement && sib.matches(selector)) {
			const key = sib.dataset.issueKey;
			if (key) return issues.find((i) => issueKey(i) === key);
		}
		sib = dir === "previous" ? sib.previousElementSibling : sib.nextElementSibling;
	}
	return undefined;
}

function computeOrder(prev: number | undefined, next: number | undefined): number {
	if (prev === undefined && next === undefined) return 1000;
	if (prev === undefined && next !== undefined) return next - 1000;
	if (prev !== undefined && next === undefined) return prev + 1000;
	// both defined
	const p = prev as number;
	const n = next as number;
	return (p + n) / 2;
}

interface IssueGroup {
	key: string;
	label: string;
	items: Issue[];
}

export const FIELD_LABELS: Record<Field, string> = {
	id: "ID",
	title: "Title",
	status: "Status",
	priority: "Priority",
	due: "Due",
	created: "Created",
	updated: "Updated",
	checklist: "Tasks",
};

const FIELD_SORT_KEY: Record<Field, SortBy | undefined> = {
	id: undefined,
	title: "title",
	status: "status",
	priority: "priority",
	due: "due",
	created: "createdAt",
	updated: "updatedAt",
	checklist: undefined,
};

const FIELD_WIDTH: Record<Field, string> = {
	id: "100px",
	title: "minmax(160px, 1fr)",
	status: "120px",
	priority: "60px",
	due: "100px",
	created: "100px",
	updated: "100px",
	checklist: "70px",
};

function buildGridTemplate(fields: Field[]): string {
	// First column is the drag-handle gutter.
	return ["auto", ...fields.map((f) => FIELD_WIDTH[f])].join(" ");
}

function formatDate(ts: number): string {
	if (!Number.isFinite(ts) || ts <= 0) return "";
	const d = new Date(ts);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function sortIssues(
	issues: Issue[],
	sortBy: SortBy,
	dir: SortDirection,
	statuses: StatusDef[]
): Issue[] {
	const statusIndex = new Map<string, number>();
	statuses.forEach((s, i) => statusIndex.set(s.id, i));

	const cmp = (a: Issue, b: Issue): number => {
		switch (sortBy) {
			case "manual":
				return a.order - b.order;
			case "title":
				return a.title.localeCompare(b.title);
			case "status": {
				const ai = statusIndex.get(a.status) ?? Number.MAX_SAFE_INTEGER;
				const bi = statusIndex.get(b.status) ?? Number.MAX_SAFE_INTEGER;
				if (ai !== bi) return ai - bi;
				return a.status.localeCompare(b.status);
			}
			case "due": {
				const ad = a.due ?? "";
				const bd = b.due ?? "";
				if (!ad && !bd) return 0;
				if (!ad) return 1; // items without due go last when ascending
				if (!bd) return -1;
				return ad.localeCompare(bd);
			}
			case "priority": {
				const ap = a.priority ?? DEFAULT_PRIORITY;
				const bp = b.priority ?? DEFAULT_PRIORITY;
				return ap - bp;
			}
			case "createdAt":
				return a.createdAt - b.createdAt;
			case "updatedAt":
				return a.updatedAt - b.updatedAt;
		}
	};

	const sorted = [...issues].sort((a, b) => {
		const c = cmp(a, b);
		if (c !== 0) return c;
		// Stable tiebreaker so equal-key items have a deterministic order.
		return a.createdAt - b.createdAt;
	});
	return dir === "asc" ? sorted : sorted.reverse();
}

function groupIssues(
	issues: Issue[],
	groupBy: GroupBy,
	statuses: StatusDef[]
): IssueGroup[] {
	if (groupBy === "none") {
		return [{ key: "all", label: "", items: issues }];
	}
	if (groupBy === "kind") {
		return [
			{ key: "file", label: "File", items: issues.filter((i) => i.kind === "file") },
			{ key: "draft", label: "Draft", items: issues.filter((i) => i.kind === "draft") },
		];
	}
	// status
	const groups: IssueGroup[] = statuses.map((s) => ({
		key: s.id,
		label: s.name,
		items: issues.filter((i) => i.status === s.id),
	}));
	const known = new Set(statuses.map((s) => s.id));
	const unknownStatuses = new Set(
		issues.filter((i) => !known.has(i.status)).map((i) => i.status)
	);
	for (const id of unknownStatuses) {
		groups.push({
			key: id,
			label: id,
			items: issues.filter((i) => i.status === id),
		});
	}
	return groups;
}

import { setIcon } from "obsidian";
import {
	ALL_FIELDS,
	BoardConfig,
	Field,
	GroupBy,
	SortBy,
	SortDirection,
	ViewMode,
} from "../types";

const FIELD_LABELS: Record<Field, string> = {
	id: "ID",
	title: "Title",
	status: "Status",
	priority: "Priority",
	due: "Due",
	created: "Created",
	updated: "Updated",
	checklist: "Tasks",
};

const GROUP_OPTIONS: Array<{ id: GroupBy; label: string }> = [
	{ id: "none", label: "None" },
	{ id: "status", label: "Status" },
	{ id: "kind", label: "Type" },
];

const SORT_OPTIONS: Array<{ id: SortBy; label: string }> = [
	{ id: "manual", label: "Manual" },
	{ id: "title", label: "Title" },
	{ id: "status", label: "Status" },
	{ id: "priority", label: "Priority" },
	{ id: "due", label: "Due date" },
	{ id: "createdAt", label: "Created" },
	{ id: "updatedAt", label: "Updated" },
];

export interface ViewPopoverHost {
	config: BoardConfig;
	mode: ViewMode;
	commit: () => void;
	onClose?: () => void;
}

type Pane = "root" | "fields" | "groupBy" | "sortBy";

interface FieldDragState {
	field: Field;
	indicator: HTMLElement;
	beforeField: Field | null;
}

/**
 * GitHub Projects–style popover for the View button. Has hierarchical
 * panes (Fields, Group by, Sort by) and stays open until the user clicks
 * outside or hits Escape.
 */
export class ViewPopover {
	private host: ViewPopoverHost;
	private anchor: HTMLElement;
	private el: HTMLElement;
	private stack: Pane[] = ["root"];
	private outsideHandler: (evt: MouseEvent) => void;
	private escHandler: (evt: KeyboardEvent) => void;
	private fieldDrag: FieldDragState | null = null;

	constructor(host: ViewPopoverHost, anchor: HTMLElement) {
		this.host = host;
		this.anchor = anchor;
		this.el = document.body.createDiv({ cls: "issue-board-vp" });
		this.position();
		this.render();

		this.outsideHandler = (evt) => {
			const t = evt.target as Node;
			if (this.el.contains(t)) return;
			if (this.anchor.contains(t)) return;
			this.close();
		};
		this.escHandler = (evt) => {
			if (evt.key === "Escape") this.close();
		};
		// Defer so the click that opened the popover doesn't immediately close it.
		window.setTimeout(() => {
			document.addEventListener("click", this.outsideHandler);
			document.addEventListener("keydown", this.escHandler);
		}, 0);
	}

	private position() {
		const r = this.anchor.getBoundingClientRect();
		this.el.setCssStyles({
			position: "fixed",
			top: `${r.bottom + 4}px`,
			right: `${Math.max(8, window.innerWidth - r.right)}px`,
		});
	}

	private render() {
		this.el.empty();
		const top = this.stack[this.stack.length - 1] ?? "root";
		if (top === "root") this.renderRoot();
		else if (top === "fields") this.renderFields();
		else if (top === "groupBy") this.renderGroupBy();
		else if (top === "sortBy") this.renderSortBy();
	}

	private renderRoot() {
		if (this.host.mode === "list") {
			this.addNavRow("Fields", "list-checks", () => this.push("fields"));
			this.addNavRow("Group by", "rows-3", () => this.push("groupBy"));
		}
		this.addNavRow("Sort by", "arrow-up-down", () => this.push("sortBy"));
		this.addSeparator();
		const lv = this.host.config.listView;
		const directions: Array<{ id: SortDirection; label: string; icon: string }> = [
			{ id: "asc", label: "Ascending", icon: "arrow-up" },
			{ id: "desc", label: "Descending", icon: "arrow-down" },
		];
		for (const d of directions) {
			this.addCheckRow(d.label, d.icon, lv.sortDirection === d.id, () => {
				lv.sortDirection = d.id;
				this.commit();
			});
		}
	}

	private renderFields() {
		this.renderBack("Fields");
		const lv = this.host.config.listView;
		// Show every field exactly once, in the user-defined order. Toggling
		// a checkbox flips visibility without changing the row's position.
		const ordered = lv.fields.length > 0 ? lv.fields : [...ALL_FIELDS];
		const hidden = new Set(lv.hiddenFields);
		const list = this.el.createDiv({ cls: "issue-board-vp-fields-list" });
		for (const field of ordered) {
			const row = this.buildFieldRow(field, !hidden.has(field));
			list.appendChild(row);
		}
		// Drop handler on the whole list so dragover/drop work over any space.
		list.addEventListener("dragover", (evt) => this.handleFieldDragOver(list, evt));
		list.addEventListener("drop", (evt) => this.handleFieldDrop(evt));
	}

	private buildFieldRow(field: Field, isVisible: boolean): HTMLElement {
		const row = document.createElement("div");
		row.className = "issue-board-vp-row issue-board-vp-field-row";
		row.dataset.fieldId = field;
		row.setAttribute("draggable", "true");

		const handle = row.createSpan({ cls: "issue-board-vp-handle" });
		setIcon(handle, "grip-vertical");

		row.createSpan({ cls: "issue-board-vp-label", text: FIELD_LABELS[field] });

		const check = row.createSpan({ cls: "issue-board-vp-check" });
		if (isVisible) setIcon(check, "check");

		row.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.toggleFieldVisibility(field);
		});
		row.addEventListener("dragstart", (evt) => this.handleFieldDragStart(evt, row, field));
		row.addEventListener("dragend", () => this.handleFieldDragEnd(row));
		return row;
	}

	private toggleFieldVisibility(field: Field) {
		const lv = this.host.config.listView;
		const hidden = new Set(lv.hiddenFields);
		if (hidden.has(field)) {
			hidden.delete(field);
		} else {
			hidden.add(field);
		}
		// Keep at least one visible field — fall back to "title".
		const visibleCount = lv.fields.filter((f) => !hidden.has(f)).length;
		if (visibleCount === 0) hidden.delete("title");
		lv.hiddenFields = lv.fields.filter((f) => hidden.has(f));
		this.commit();
	}

	private handleFieldDragStart(
		evt: DragEvent,
		row: HTMLElement,
		field: Field
	) {
		const list = row.parentElement;
		if (!list) return;
		const listRect = list.getBoundingClientRect();
		const indicator = document.body.createDiv({
			cls: "issue-board-vp-field-drop-indicator",
		});
		indicator.setCssStyles({
			position: "fixed",
			left: `${listRect.left}px`,
			width: `${listRect.width}px`,
			height: "2px",
			top: `${listRect.top}px`,
		});
		this.fieldDrag = { field, indicator, beforeField: null };
		if (evt.dataTransfer) {
			evt.dataTransfer.effectAllowed = "move";
			evt.dataTransfer.setData("text/plain", field);
		}
		window.setTimeout(() => row.addClass("is-dragging"), 0);
	}

	private handleFieldDragEnd(row: HTMLElement) {
		row.removeClass("is-dragging");
		if (this.fieldDrag) {
			this.fieldDrag.indicator.remove();
			this.fieldDrag = null;
		}
	}

	private handleFieldDragOver(list: HTMLElement, evt: DragEvent) {
		if (!this.fieldDrag) return;
		evt.preventDefault();
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
		const draggedField = this.fieldDrag.field;
		const rows = Array.from(
			list.querySelectorAll<HTMLElement>("[data-field-id]")
		).filter((el) => el.dataset.fieldId !== draggedField);

		let beforeField: Field | null = null;
		let lineY = 0;
		for (const r of rows) {
			const rect = r.getBoundingClientRect();
			if (evt.clientY < rect.top + rect.height / 2) {
				beforeField = (r.dataset.fieldId as Field) ?? null;
				lineY = rect.top;
				break;
			}
		}
		if (beforeField === null) {
			if (rows.length > 0) {
				const last = rows[rows.length - 1];
				if (last) lineY = last.getBoundingClientRect().bottom;
			} else {
				lineY = list.getBoundingClientRect().top;
			}
		}
		this.fieldDrag.beforeField = beforeField;
		this.fieldDrag.indicator.setCssStyles({
			top: `${Math.round(lineY) - 1}px`,
		});
	}

	private handleFieldDrop(evt: DragEvent) {
		if (!this.fieldDrag) return;
		evt.preventDefault();
		const moved = this.fieldDrag.field;
		const beforeField = this.fieldDrag.beforeField;
		this.fieldDrag.indicator.remove();
		this.fieldDrag = null;

		const lv = this.host.config.listView;
		const next = lv.fields.filter((f) => f !== moved);
		if (beforeField === null) {
			next.push(moved);
		} else {
			const idx = next.indexOf(beforeField);
			if (idx >= 0) next.splice(idx, 0, moved);
			else next.push(moved);
		}
		lv.fields = next;
		this.commit();
	}

	private renderGroupBy() {
		this.renderBack("Group by");
		const lv = this.host.config.listView;
		for (const g of GROUP_OPTIONS) {
			this.addCheckRow(g.label, null, lv.groupBy === g.id, () => {
				lv.groupBy = g.id;
				this.commit();
			});
		}
	}

	private renderSortBy() {
		this.renderBack("Sort by");
		const lv = this.host.config.listView;
		for (const s of SORT_OPTIONS) {
			this.addCheckRow(s.label, null, lv.sortBy === s.id, () => {
				lv.sortBy = s.id;
				this.commit();
			});
		}
	}

	private push(p: Pane) {
		this.stack.push(p);
		this.render();
	}

	private pop() {
		if (this.stack.length > 1) {
			this.stack.pop();
			this.render();
		}
	}

	private renderBack(title: string) {
		const row = this.el.createDiv({ cls: "issue-board-vp-row issue-board-vp-back" });
		const icon = row.createSpan({ cls: "issue-board-vp-icon" });
		setIcon(icon, "arrow-left");
		row.createSpan({ cls: "issue-board-vp-label", text: title });
		row.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.pop();
		});
	}

	private addNavRow(label: string, icon: string, onClick: () => void) {
		const row = this.el.createDiv({ cls: "issue-board-vp-row" });
		const iconEl = row.createSpan({ cls: "issue-board-vp-icon" });
		setIcon(iconEl, icon);
		row.createSpan({ cls: "issue-board-vp-label", text: label });
		const right = row.createSpan({ cls: "issue-board-vp-right" });
		setIcon(right, "chevron-right");
		row.addEventListener("click", (evt) => {
			evt.stopPropagation();
			onClick();
		});
	}

	private addCheckRow(
		label: string,
		icon: string | null,
		checked: boolean,
		onClick: () => void
	) {
		const row = this.el.createDiv({ cls: "issue-board-vp-row" });
		if (icon) {
			const iconEl = row.createSpan({ cls: "issue-board-vp-icon" });
			setIcon(iconEl, icon);
		} else {
			row.createSpan({ cls: "issue-board-vp-icon" });
		}
		row.createSpan({ cls: "issue-board-vp-label", text: label });
		const check = row.createSpan({ cls: "issue-board-vp-check" });
		if (checked) setIcon(check, "check");
		row.addEventListener("click", (evt) => {
			evt.stopPropagation();
			onClick();
		});
	}

	private addSeparator() {
		this.el.createDiv({ cls: "issue-board-vp-separator" });
	}

	private commit() {
		this.host.commit();
		this.render();
	}

	close() {
		document.removeEventListener("click", this.outsideHandler);
		document.removeEventListener("keydown", this.escHandler);
		this.el.remove();
		if (this.fieldDrag) {
			this.fieldDrag.indicator.remove();
			this.fieldDrag = null;
		}
		this.host.onClose?.();
	}
}

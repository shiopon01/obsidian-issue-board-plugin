export type IssueKind = "draft" | "file";

export type ViewMode = "list" | "kanban";

export interface StatusDef {
	id: string;
	name: string;
	color?: string;
}

export type Priority = 1 | 2 | 3 | 4;

export const DEFAULT_PRIORITY: Priority = 4;

export interface DraftIssue {
	kind: "draft";
	id: string;
	title: string;
	status: string;
	body: string;
	createdAt: number;
	updatedAt: number;
	order: number;
	due?: string; // YYYY-MM-DD
	priority?: Priority;
}

export interface FileIssue {
	kind: "file";
	id: string;
	title: string;
	status: string;
	body: string;
	createdAt: number;
	updatedAt: number;
	order: number;
	path: string;
	due?: string; // YYYY-MM-DD
	priority?: Priority;
}

export type Issue = DraftIssue | FileIssue;

export interface BoardFilter {
	statuses: string[];
	query: string;
	kinds: IssueKind[];
}

export const DEFAULT_FILTER: BoardFilter = {
	statuses: [],
	query: "",
	kinds: ["draft", "file"],
};

export type GroupBy = "none" | "status" | "kind";

export type SortBy =
	| "manual"
	| "title"
	| "status"
	| "priority"
	| "due"
	| "createdAt"
	| "updatedAt";

export type SortDirection = "asc" | "desc";

export type Field =
	| "id"
	| "title"
	| "status"
	| "priority"
	| "due"
	| "created"
	| "updated"
	| "checklist";

export const ALL_FIELDS: Field[] = [
	"id",
	"title",
	"status",
	"priority",
	"due",
	"checklist",
	"created",
	"updated",
];

/** Subset of {@link ALL_FIELDS} that is visible by default. */
export const DEFAULT_VISIBLE_FIELDS: Field[] = [
	"id",
	"title",
	"priority",
	"due",
	"status",
];

/**
 * Full list of fields in their preferred display order. The header and the
 * popover both read this; {@link ListViewSettings.hiddenFields} controls
 * which subset is actually rendered as columns.
 */
export const DEFAULT_FIELDS: Field[] = [
	...DEFAULT_VISIBLE_FIELDS,
	...ALL_FIELDS.filter((f) => !DEFAULT_VISIBLE_FIELDS.includes(f)),
];

export const DEFAULT_HIDDEN_FIELDS: Field[] = ALL_FIELDS.filter(
	(f) => !DEFAULT_VISIBLE_FIELDS.includes(f)
);

export interface ListViewSettings {
	groupBy: GroupBy;
	sortBy: SortBy;
	sortDirection: SortDirection;
	/** All fields in display order (both visible and hidden). */
	fields: Field[];
	/** Subset of {@link fields} that should NOT be shown as a column. */
	hiddenFields: Field[];
	collapsedGroups: string[];
}

export const DEFAULT_LIST_VIEW: ListViewSettings = {
	groupBy: "none",
	sortBy: "manual",
	sortDirection: "asc",
	fields: [...DEFAULT_FIELDS],
	hiddenFields: [...DEFAULT_HIDDEN_FIELDS],
	collapsedGroups: [],
};

export const ISSUE_BOARD_VIEW_TYPE = "issue-board-view";

export interface BoardConfig {
	issueFolder: string;
	idPrefix: string;
	nextIdNumber: number;
	statuses: StatusDef[];
	defaultStatus: string;
	template: string;
	listView: ListViewSettings;
}

/** Frontmatter key that marks a markdown file as an Issue Board. */
export const BOARD_MARKER = "issue-board";


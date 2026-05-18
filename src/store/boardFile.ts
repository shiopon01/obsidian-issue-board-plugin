import {
	getFrontMatterInfo,
	parseYaml,
	stringifyYaml,
} from "obsidian";
import {
	ALL_FIELDS,
	BOARD_MARKER,
	BoardConfig,
	DEFAULT_FIELDS,
	DEFAULT_HIDDEN_FIELDS,
	DEFAULT_LIST_VIEW,
	DraftIssue,
	Field,
} from "../types";

export interface ParsedBoard {
	config: BoardConfig;
	drafts: DraftIssue[];
}

const DRAFTS_HEADER = "%% issue-board:drafts (managed by the Issue Board plugin) %%";

export const DEFAULT_STATUSES = [
	{ id: "todo", name: "Todo", color: "#7a7a7a" },
	{ id: "in-progress", name: "In progress", color: "#3b82f6" },
	{ id: "done", name: "Done", color: "#16a34a" },
];

export const DEFAULT_TEMPLATE = `## Overview

{{body}}

## Acceptance criteria

- [ ] ...

## Notes

`;

export function isBoardFileContent(content: string): boolean {
	const info = getFrontMatterInfo(content);
	if (!info.exists) return false;
	try {
		const fm = parseYaml(info.frontmatter) as Record<string, unknown> | null;
		return !!(fm && fm[BOARD_MARKER]);
	} catch {
		return false;
	}
}

export function parseBoardFile(content: string): ParsedBoard {
	const info = getFrontMatterInfo(content);
	if (!info.exists) throw new Error("Not an Issue Board file (missing frontmatter).");
	let fm: Record<string, unknown> = {};
	try {
		fm = (parseYaml(info.frontmatter) ?? {}) as Record<string, unknown>;
	} catch (e) {
		throw new Error(`Failed to parse board frontmatter: ${(e as Error).message}`);
	}
	if (!fm[BOARD_MARKER]) {
		throw new Error(`Not an Issue Board file (missing "${BOARD_MARKER}" marker).`);
	}

	const fmListView = (fm.listView as Partial<typeof DEFAULT_LIST_VIEW>) ?? {};
	const allowedFields = new Set<string>(ALL_FIELDS);
	const parsedFields = Array.isArray(fmListView.fields)
		? fmListView.fields.filter((f): f is Field => allowedFields.has(f))
		: [];
	const parsedHidden = Array.isArray(fmListView.hiddenFields)
		? fmListView.hiddenFields.filter((f): f is Field => allowedFields.has(f))
		: null;

	let fields: Field[];
	let hiddenFields: Field[];
	if (parsedHidden === null) {
		// Legacy shape: `fields` was the visible-only list; treat missing
		// fields as hidden so the upgrade preserves the old layout.
		if (parsedFields.length > 0) {
			const missing = ALL_FIELDS.filter((f) => !parsedFields.includes(f));
			fields = [...parsedFields, ...missing];
			hiddenFields = missing;
		} else {
			fields = [...DEFAULT_FIELDS];
			hiddenFields = [...DEFAULT_HIDDEN_FIELDS];
		}
	} else {
		// New shape: trust the persisted order, but make sure every field
		// is represented in the order list.
		fields = parsedFields.length > 0 ? parsedFields : [...DEFAULT_FIELDS];
		for (const f of ALL_FIELDS) {
			if (!fields.includes(f)) {
				fields.push(f);
				if (!parsedHidden.includes(f)) parsedHidden.push(f);
			}
		}
		hiddenFields = parsedHidden;
	}

	const config: BoardConfig = {
		issueFolder: stringOr(fm.issueFolder, "Issues"),
		idPrefix: stringOr(fm.idPrefix, "TASK"),
		nextIdNumber: numberOr(fm.nextIdNumber, 1),
		statuses: Array.isArray(fm.statuses) && fm.statuses.length > 0
			? (fm.statuses as BoardConfig["statuses"])
			: DEFAULT_STATUSES,
		defaultStatus: stringOr(fm.defaultStatus, "todo"),
		template: stringOr(fm.template, DEFAULT_TEMPLATE),
		listView: {
			...DEFAULT_LIST_VIEW,
			...fmListView,
			fields,
			hiddenFields,
			collapsedGroups: Array.isArray(fmListView.collapsedGroups)
				? fmListView.collapsedGroups
				: [],
		},
	};
	const body = content.slice(info.contentStart);
	const drafts = parseDrafts(body);
	return { config, drafts };
}

export function serializeBoardFile(
	config: BoardConfig,
	drafts: DraftIssue[]
): string {
	const fm = { [BOARD_MARKER]: true, ...config };
	const yaml = stringifyYaml(fm).trimEnd();
	const draftsJson = JSON.stringify(drafts, null, 2);
	return (
		`---\n${yaml}\n---\n\n` +
		`${DRAFTS_HEADER}\n` +
		"```json\n" +
		`${draftsJson}\n` +
		"```\n"
	);
}

function parseDrafts(body: string): DraftIssue[] {
	const re = /```json\s*\r?\n([\s\S]*?)\r?\n```/;
	const m = re.exec(body);
	if (!m || !m[1]) return [];
	try {
		const parsed = JSON.parse(m[1]) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.filter(isDraftLike) as DraftIssue[];
		}
	} catch {
		// Drafts block is malformed; return empty to avoid losing the file entirely.
	}
	return [];
}

function isDraftLike(v: unknown): boolean {
	if (typeof v !== "object" || v === null) return false;
	const obj = v as Record<string, unknown>;
	return obj.kind === "draft" && typeof obj.id === "string";
}

function stringOr(v: unknown, fallback: string): string {
	return typeof v === "string" && v.length > 0 ? v : fallback;
}

function numberOr(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Generates default config for a new board, deriving the folder and prefix
 * from the board file's name and parent folder.
 *
 * - `boardFilePath` e.g. "Projects/Game/Issue Board.md"
 * - `defaultTemplate` is taken from plugin global defaults.
 */
export function buildDefaultBoardConfig(
	boardFilePath: string,
	defaultTemplate: string
): BoardConfig {
	const lastSlash = boardFilePath.lastIndexOf("/");
	const parent = lastSlash >= 0 ? boardFilePath.slice(0, lastSlash) : "";
	const baseName = (lastSlash >= 0
		? boardFilePath.slice(lastSlash + 1)
		: boardFilePath
	).replace(/\.md$/i, "");

	const issueFolder = parent
		? `${parent}/${baseName} Issues`
		: `${baseName} Issues`;

	const prefix = derivePrefix(baseName);

	return {
		issueFolder,
		idPrefix: prefix,
		nextIdNumber: 1,
		statuses: DEFAULT_STATUSES,
		defaultStatus: "todo",
		template: defaultTemplate || DEFAULT_TEMPLATE,
		listView: {
			...DEFAULT_LIST_VIEW,
			fields: [...DEFAULT_FIELDS],
			collapsedGroups: [],
		},
	};
}

function derivePrefix(name: string): string {
	// Take the first alphanumeric run, uppercased. Fall back to TASK.
	const m = name.match(/[A-Za-z0-9]+/);
	if (!m) return "TASK";
	return m[0].toUpperCase().slice(0, 12);
}

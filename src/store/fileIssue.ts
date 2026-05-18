import {
	App,
	TFile,
	TFolder,
	getFrontMatterInfo,
	normalizePath,
	parseYaml,
	stringifyYaml,
} from "obsidian";
import type { FileIssue, Priority } from "../types";
import { sanitizeFileTitle } from "../utils/template";

export interface FileIssueFrontmatter {
	id: string;
	title: string;
	status: string;
	created: string;
	updated: string;
	order: number;
	due?: string;
	priority?: number;
}

export function buildFileIssueContent(
	frontmatter: FileIssueFrontmatter,
	body: string
): string {
	const yaml = stringifyYaml(frontmatter).trimEnd();
	const trimmedBody = body.startsWith("\n") ? body : `\n${body}`;
	return `---\n${yaml}\n---\n${trimmedBody}`;
}

export function parseFileIssue(file: TFile, content: string): FileIssue | null {
	const info = getFrontMatterInfo(content);
	if (!info.exists) return null;
	let fm: Partial<FileIssueFrontmatter> = {};
	try {
		fm = (parseYaml(info.frontmatter) ?? {}) as Partial<FileIssueFrontmatter>;
	} catch {
		return null;
	}
	if (!fm.id || !fm.status) return null;
	const body = content.slice(info.contentStart);
	const created = fm.created ? Date.parse(fm.created) : file.stat.ctime;
	const updated = fm.updated ? Date.parse(fm.updated) : file.stat.mtime;
	const order =
		typeof fm.order === "number" && Number.isFinite(fm.order)
			? fm.order
			: file.stat.ctime;
	const priority: Priority | undefined =
		typeof fm.priority === "number" &&
		fm.priority >= 1 &&
		fm.priority <= 4
			? (fm.priority as Priority)
			: undefined;
	return {
		kind: "file",
		id: fm.id,
		title: fm.title ?? file.basename,
		status: fm.status,
		body,
		createdAt: Number.isFinite(created) ? created : file.stat.ctime,
		updatedAt: Number.isFinite(updated) ? updated : file.stat.mtime,
		order,
		path: file.path,
		due: typeof fm.due === "string" && fm.due ? fm.due : undefined,
		priority,
	};
}

export async function ensureFolder(app: App, path: string): Promise<TFolder> {
	const normalized = normalizePath(path);
	// Fast path: already in the in-memory index (exact-case match).
	const cached = app.vault.getAbstractFileByPath(normalized);
	if (cached instanceof TFolder) return cached;
	if (cached) {
		throw new Error(`A file with the name "${normalized}" already exists.`);
	}
	// Case-insensitive lookup before attempting to create. On macOS/Windows
	// the filesystem is typically case-insensitive but Obsidian's index keys
	// folders by their on-disk case, so "issues" in settings would not match
	// an actual "Issues" folder via exact lookup.
	const caseInsensitive = findFolderCaseInsensitive(app, normalized);
	if (caseInsensitive) return caseInsensitive;

	// Try to create. createFolder throws when the folder already exists on
	// disk but is missing from the in-memory index (which can happen right
	// after plugin load or in races). We swallow that error and fall through.
	try {
		const created = await app.vault.createFolder(normalized);
		if (created) return created;
	} catch {
		// Intentionally ignored; we'll try to resolve below.
	}
	const resolved = await resolveFolderWithRetry(app, normalized);
	if (resolved) return resolved;
	const fallback = findFolderCaseInsensitive(app, normalized);
	if (fallback) return fallback;
	const conflict = app.vault.getAbstractFileByPath(normalized);
	if (conflict) {
		throw new Error(`A file with the name "${normalized}" already exists.`);
	}
	throw new Error(`Failed to ensure folder "${normalized}".`);
}

function findFolderCaseInsensitive(app: App, normalized: string): TFolder | null {
	const parts = normalized.split("/").filter((p) => p.length > 0);
	let current: TFolder = app.vault.getRoot();
	for (const part of parts) {
		const lower = part.toLowerCase();
		let match: TFolder | null = null;
		for (const child of current.children) {
			if (child instanceof TFolder && child.name.toLowerCase() === lower) {
				match = child;
				break;
			}
		}
		if (!match) return null;
		current = match;
	}
	return current;
}

async function resolveFolderWithRetry(
	app: App,
	normalized: string
): Promise<TFolder | null> {
	for (let i = 0; i < 10; i++) {
		const f = app.vault.getAbstractFileByPath(normalized);
		if (f instanceof TFolder) return f;
		await new Promise((resolve) => window.setTimeout(resolve, 20));
	}
	const last = app.vault.getAbstractFileByPath(normalized);
	return last instanceof TFolder ? last : null;
}

export function buildFileName(id: string, title: string): string {
	const cleanTitle = sanitizeFileTitle(title);
	const base = cleanTitle ? `${id} ${cleanTitle}` : id;
	return `${base}.md`;
}

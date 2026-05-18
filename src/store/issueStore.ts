import {
	App,
	Events,
	TFile,
	TFolder,
	getFrontMatterInfo,
	normalizePath,
} from "obsidian";
import type { BoardConfig, DraftIssue, FileIssue, Issue, Priority } from "../types";
import {
	FileIssueFrontmatter,
	buildFileIssueContent,
	buildFileName,
	ensureFolder,
	parseFileIssue,
} from "./fileIssue";
import { applyTemplate } from "../utils/template";

export interface CreateIssueOptions {
	title: string;
	status?: string;
	body?: string;
	asDraft: boolean;
	due?: string;
	priority?: Priority;
}

/**
 * Per-board state container. The view owns the BoardConfig and the drafts
 * array; the store mutates them in place and asks for a save via {@link save}.
 */
export interface BoardContext {
	config: BoardConfig;
	drafts: DraftIssue[];
	save: () => void | Promise<void>;
}

export class IssueStore extends Events {
	private app: App;
	private ctx: BoardContext;
	private fileIssues = new Map<string, FileIssue>();
	private loaded = false;

	constructor(app: App, ctx: BoardContext) {
		super();
		this.app = app;
		this.ctx = ctx;
	}

	get config(): BoardConfig {
		return this.ctx.config;
	}

	get drafts(): DraftIssue[] {
		return this.ctx.drafts;
	}

	private async persist() {
		await this.ctx.save();
	}

	async load() {
		this.fileIssues.clear();
		const folder = this.resolveIssueFolder();
		if (folder) {
			await this.indexFolder(folder);
		}
		this.loaded = true;
		await this.reconcileNextIdNumber();
		this.trigger("change");
	}

	private resolveIssueFolder(): TFolder | null {
		const normalized = normalizePath(this.ctx.config.issueFolder);
		const exact = this.app.vault.getAbstractFileByPath(normalized);
		if (exact instanceof TFolder) return exact;
		const parts = normalized.split("/").filter((p) => p.length > 0);
		let current: TFolder = this.app.vault.getRoot();
		for (const part of parts) {
			const lower = part.toLowerCase();
			let next: TFolder | null = null;
			for (const child of current.children) {
				if (child instanceof TFolder && child.name.toLowerCase() === lower) {
					next = child;
					break;
				}
			}
			if (!next) return null;
			current = next;
		}
		return current;
	}

	private async reconcileNextIdNumber() {
		const prefix = this.ctx.config.idPrefix;
		const pattern = new RegExp(`^${escapeRegex(prefix)}-(\\d+)$`);
		let max = 0;
		for (const issue of this.fileIssues.values()) {
			const m = pattern.exec(issue.id);
			if (m && m[1]) {
				const n = parseInt(m[1], 10);
				if (Number.isFinite(n) && n > max) max = n;
			}
		}
		const desired = max + 1;
		if (this.ctx.config.nextIdNumber < desired) {
			this.ctx.config.nextIdNumber = desired;
			await this.persist();
		}
	}

	private async indexFolder(folder: TFolder) {
		const queue: TFolder[] = [folder];
		while (queue.length > 0) {
			const current = queue.shift();
			if (!current) continue;
			for (const child of current.children) {
				if (child instanceof TFolder) {
					queue.push(child);
				} else if (child instanceof TFile && child.extension === "md") {
					await this.indexFile(child);
				}
			}
		}
	}

	private async indexFile(file: TFile) {
		try {
			const content = await this.app.vault.cachedRead(file);
			const issue = parseFileIssue(file, content);
			if (issue) {
				this.fileIssues.set(file.path, issue);
			} else {
				this.fileIssues.delete(file.path);
			}
		} catch {
			this.fileIssues.delete(file.path);
		}
	}

	isUnderIssueFolder(path: string): boolean {
		const folder =
			this.resolveIssueFolder()?.path ??
			normalizePath(this.ctx.config.issueFolder);
		const a = path.toLowerCase();
		const b = folder.toLowerCase();
		return a === b || a.startsWith(`${b}/`);
	}

	async handleFileChange(file: TFile) {
		if (!this.isUnderIssueFolder(file.path) || file.extension !== "md") return;
		await this.indexFile(file);
		this.trigger("change");
	}

	handleFileDelete(path: string) {
		if (this.fileIssues.delete(path)) {
			this.trigger("change");
		}
	}

	handleFileRename(file: TFile, oldPath: string) {
		const wasIndexed = this.fileIssues.delete(oldPath);
		if (this.isUnderIssueFolder(file.path) && file.extension === "md") {
			void this.handleFileChange(file);
		} else if (wasIndexed) {
			this.trigger("change");
		}
	}

	getDrafts(): DraftIssue[] {
		return [...this.ctx.drafts];
	}

	getFileIssues(): FileIssue[] {
		return [...this.fileIssues.values()];
	}

	getAll(): Issue[] {
		return [...this.getDrafts(), ...this.getFileIssues()];
	}

	isLoaded(): boolean {
		return this.loaded;
	}

	private nextFileId(): string {
		const s = this.ctx.config;
		let id = `${s.idPrefix}-${s.nextIdNumber}`;
		while (this.fileIdExists(id)) {
			s.nextIdNumber += 1;
			id = `${s.idPrefix}-${s.nextIdNumber}`;
		}
		s.nextIdNumber += 1;
		return id;
	}

	private fileIdExists(id: string): boolean {
		for (const issue of this.fileIssues.values()) {
			if (issue.id === id) return true;
		}
		return false;
	}

	private nextDraftId(): string {
		return `draft-${Date.now().toString(36)}-${Math.random()
			.toString(36)
			.slice(2, 8)}`;
	}

	private nextOrder(): number {
		let max = 0;
		for (const issue of this.fileIssues.values()) {
			if (issue.order > max) max = issue.order;
		}
		for (const draft of this.ctx.drafts) {
			if (draft.order > max) max = draft.order;
		}
		return max + 1000;
	}

	async create(options: CreateIssueOptions): Promise<Issue> {
		const cfg = this.ctx.config;
		const status = options.status ?? cfg.defaultStatus;
		const now = Date.now();
		const order = this.nextOrder();

		if (options.asDraft) {
			const draftId = this.nextDraftId();
			const draft: DraftIssue = {
				kind: "draft",
				id: draftId,
				title: options.title,
				status,
				body: options.body ?? "",
				createdAt: now,
				updatedAt: now,
				order,
				due: options.due,
				priority: options.priority,
			};
			this.ctx.drafts.push(draft);
			await this.persist();
			this.trigger("change");
			return draft;
		}

		const fileId = this.nextFileId();
		const body = renderFileBody(
			cfg.template,
			fileId,
			options.title,
			options.body ?? ""
		);
		const issue = await this.writeNewFileIssue(
			fileId,
			options.title,
			status,
			body,
			now,
			order,
			options.due,
			options.priority
		);
		await this.persist();
		this.trigger("change");
		return issue;
	}

	private async writeNewFileIssue(
		id: string,
		title: string,
		status: string,
		body: string,
		now: number,
		order: number,
		due?: string,
		priority?: Priority
	): Promise<FileIssue> {
		const folder = await ensureFolder(
			this.app,
			normalizePath(this.ctx.config.issueFolder)
		);
		const folderPath = folder.path;
		let fullPath = normalizePath(`${folderPath}/${buildFileName(id, title)}`);
		if (this.app.vault.getAbstractFileByPath(fullPath)) {
			let suffix = 2;
			let candidate = normalizePath(
				`${folderPath}/${buildFileName(id, `${title} (${suffix})`)}`
			);
			while (this.app.vault.getAbstractFileByPath(candidate)) {
				suffix += 1;
				candidate = normalizePath(
					`${folderPath}/${buildFileName(id, `${title} (${suffix})`)}`
				);
			}
			fullPath = candidate;
		}
		const fm: FileIssueFrontmatter = {
			id,
			title,
			status,
			created: new Date(now).toISOString(),
			updated: new Date(now).toISOString(),
			order,
		};
		if (due) fm.due = due;
		if (priority !== undefined) fm.priority = priority;
		const content = buildFileIssueContent(fm, body);
		const file = await this.app.vault.create(fullPath, content);
		const issue: FileIssue = {
			kind: "file",
			id,
			title,
			status,
			body,
			createdAt: now,
			updatedAt: now,
			order,
			path: file.path,
			due,
			priority,
		};
		this.fileIssues.set(file.path, issue);
		return issue;
	}

	async updateDraft(
		id: string,
		patch: Partial<Omit<DraftIssue, "kind" | "id" | "createdAt">>
	) {
		const drafts = this.ctx.drafts;
		const idx = drafts.findIndex((d) => d.id === id);
		if (idx === -1) return;
		const current = drafts[idx];
		if (!current) return;
		const updated: DraftIssue = {
			...current,
			...patch,
			updatedAt: Date.now(),
		};
		drafts[idx] = updated;
		await this.persist();
		this.trigger("change");
	}

	async deleteDraft(id: string) {
		const drafts = this.ctx.drafts;
		const idx = drafts.findIndex((d) => d.id === id);
		if (idx === -1) return;
		drafts.splice(idx, 1);
		await this.persist();
		this.trigger("change");
	}

	async updateFileIssue(
		path: string,
		patch: Partial<
			Pick<FileIssue, "title" | "status" | "body" | "order" | "due" | "priority">
		>
	) {
		const issue = this.fileIssues.get(path);
		if (!issue) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const next: FileIssue = {
			...issue,
			...patch,
			updatedAt: Date.now(),
		};
		await this.app.fileManager.processFrontMatter(
			file,
			(fm: Record<string, unknown>) => {
				fm.title = next.title;
				fm.status = next.status;
				fm.order = next.order;
				fm.updated = new Date(next.updatedAt).toISOString();
				if (next.due) {
					fm.due = next.due;
				} else {
					delete fm.due;
				}
				if (next.priority !== undefined) {
					fm.priority = next.priority;
				} else {
					delete fm.priority;
				}
			}
		);
		if (patch.body !== undefined) {
			const content = await this.app.vault.read(file);
			const info = getFrontMatterInfo(content);
			if (info.exists) {
				const newContent = content.slice(0, info.contentStart) + patch.body;
				await this.app.vault.modify(file, newContent);
			}
		}
		if (patch.title !== undefined && patch.title !== issue.title) {
			const folderPath =
				file.parent?.path ?? normalizePath(this.ctx.config.issueFolder);
			const newPath = normalizePath(
				`${folderPath}/${buildFileName(issue.id, patch.title)}`
			);
			if (newPath !== file.path && !this.app.vault.getAbstractFileByPath(newPath)) {
				await this.app.fileManager.renameFile(file, newPath);
				next.path = newPath;
				this.fileIssues.delete(path);
			}
		}
		this.fileIssues.set(next.path, next);
		this.trigger("change");
	}

	async deleteFileIssue(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		await this.app.fileManager.trashFile(file);
		this.fileIssues.delete(path);
		this.trigger("change");
	}

	async promoteDraft(id: string): Promise<FileIssue | null> {
		const drafts = this.ctx.drafts;
		const idx = drafts.findIndex((d) => d.id === id);
		if (idx === -1) return null;
		const draft = drafts[idx];
		if (!draft) return null;
		const fileId = this.nextFileId();
		const body = renderFileBody(
			this.ctx.config.template,
			fileId,
			draft.title,
			draft.body
		);
		const issue = await this.writeNewFileIssue(
			fileId,
			draft.title,
			draft.status,
			body,
			draft.createdAt,
			draft.order,
			draft.due,
			draft.priority
		);
		drafts.splice(idx, 1);
		await this.persist();
		this.trigger("change");
		return issue;
	}

	async moveIssue(issue: Issue, status: string, order: number): Promise<void> {
		if (issue.kind === "draft") {
			await this.updateDraft(issue.id, { status, order });
		} else {
			await this.updateFileIssue(issue.path, { status, order });
		}
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const BODY_PLACEHOLDER = /\{\{\s*body\s*\}\}/;

/**
 * Renders a file issue's markdown body from the board template, dropping
 * the user-typed body into the `{{body}}` slot. When the template has no
 * such slot, the body is appended at the end (with a blank-line separator)
 * so the user's text is never silently dropped.
 */
function renderFileBody(
	template: string,
	id: string,
	title: string,
	body: string
): string {
	if (BODY_PLACEHOLDER.test(template)) {
		return applyTemplate(template, { id, title, body });
	}
	const applied = applyTemplate(template, { id, title });
	if (!body.trim()) return applied;
	const sep = applied.endsWith("\n\n")
		? ""
		: applied.endsWith("\n")
			? "\n"
			: "\n\n";
	const tail = body.endsWith("\n") ? "" : "\n";
	return applied + sep + body + tail;
}

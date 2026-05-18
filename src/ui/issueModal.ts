import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { BoardConfig, DEFAULT_PRIORITY, Issue, Priority } from "../types";
import type { IssueStore } from "../store/issueStore";
import { joinTitleAndBody, splitTitleAndBody } from "../utils/titleBody";

/** Minimal surface a modal needs to talk to the currently open board. */
export interface BoardSurface {
	config: BoardConfig;
	store: IssueStore;
}

interface IssueFormValues {
	title: string;
	status: string;
	body: string;
	asDraft: boolean;
	due: string;
	priority: Priority;
}

export interface CreateIssuePrefill {
	status?: string;
	asDraft?: boolean;
	priority?: Priority;
}

export class CreateIssueModal extends Modal {
	private surface: BoardSurface;
	private values: IssueFormValues;

	constructor(
		app: App,
		surface: BoardSurface,
		prefill?: CreateIssuePrefill
	) {
		super(app);
		this.surface = surface;
		this.values = {
			title: "",
			status: prefill?.status ?? surface.config.defaultStatus,
			body: "",
			// Issues default to draft so a quick capture doesn't immediately
			// create a file in the vault.
			asDraft: prefill?.asDraft ?? true,
			due: "",
			priority: prefill?.priority ?? DEFAULT_PRIORITY,
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("issue-board-modal");
		contentEl.createEl("h2", { text: "Create issue" });

		new Setting(contentEl)
			.setName("Title")
			.setDesc("First line is the title. Lines below become the body.")
			.addTextArea((text) => {
				text
					.setPlaceholder("Issue title")
					.setValue(joinTitleAndBody(this.values.title, this.values.body))
					.onChange((v) => {
						const split = splitTitleAndBody(v);
						this.values.title = split.title;
						this.values.body = split.body;
					});
				text.inputEl.rows = 8;
				text.inputEl.classList.add("issue-board-modal-title");
				text.inputEl.classList.add("issue-board-modal-body");
				window.setTimeout(() => text.inputEl.focus(), 0);
			});

		new Setting(contentEl).setName("Status").addDropdown((dd) => {
			for (const s of this.surface.config.statuses) {
				dd.addOption(s.id, s.name);
			}
			dd.setValue(this.values.status).onChange((v) => (this.values.status = v));
		});

		new Setting(contentEl).setName("Priority").addDropdown((dd) => {
			dd.addOption("1", "P1 — urgent");
			dd.addOption("2", "P2 — high");
			dd.addOption("3", "P3 — medium");
			dd.addOption("4", "P4 — low (default)");
			dd.setValue(String(this.values.priority)).onChange((v) => {
				this.values.priority = parsePriority(v);
			});
		});

		new Setting(contentEl).setName("Due date").addText((text) => {
			text.inputEl.type = "date";
			text
				.setValue(this.values.due)
				.onChange((v) => (this.values.due = v));
		});

		new Setting(contentEl)
			.setName("Type")
			.setDesc(
				"Drafts live only inside the board file; file issues are created as a Markdown file in the configured folder."
			)
			.addDropdown((dd) => {
				dd.addOption("file", "File");
				dd.addOption("draft", "Draft");
				dd.setValue(this.values.asDraft ? "draft" : "file").onChange((v) => {
					this.values.asDraft = v === "draft";
				});
			});

		const buttons = contentEl.createDiv({ cls: "issue-board-modal-buttons" });
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		new ButtonComponent(buttons)
			.setCta()
			.setButtonText("Create")
			.onClick(() => void this.submit());
	}

	private async submit() {
		const title = this.values.title.trim();
		if (!title) {
			new Notice("Issue title is required.");
			return;
		}
		try {
			await this.surface.store.create({
				title,
				status: this.values.status,
				body: this.values.body,
				asDraft: this.values.asDraft,
				due: this.values.due || undefined,
				priority:
					this.values.priority === DEFAULT_PRIORITY
						? undefined
						: this.values.priority,
			});
			this.close();
		} catch (e) {
			new Notice(`Failed to create issue: ${(e as Error).message}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class EditIssueModal extends Modal {
	private surface: BoardSurface;
	private issue: Issue;
	private values: {
		title: string;
		status: string;
		body: string;
		due: string;
		priority: Priority;
	};

	constructor(app: App, surface: BoardSurface, issue: Issue) {
		super(app);
		this.surface = surface;
		this.issue = issue;
		this.values = {
			title: issue.title,
			status: issue.status,
			body: issue.body,
			due: issue.due ?? "",
			priority: issue.priority ?? DEFAULT_PRIORITY,
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("issue-board-modal");
		const isDraft = this.issue.kind === "draft";
		const heading = isDraft ? "Edit draft" : `Edit ${this.issue.id}`;
		contentEl.createEl("h2", { text: heading });

		if (isDraft) {
			new Setting(contentEl)
				.setName("Title")
				.setDesc("First line is the title. Lines below become the body.")
				.addTextArea((text) => {
					text
						.setValue(joinTitleAndBody(this.values.title, this.values.body))
						.onChange((v) => {
							const split = splitTitleAndBody(v);
							this.values.title = split.title;
							this.values.body = split.body;
						});
					text.inputEl.rows = 12;
					text.inputEl.classList.add("issue-board-modal-title");
					text.inputEl.classList.add("issue-board-modal-body");
				});
		} else {
			new Setting(contentEl).setName("Title").addText((text) => {
				text
					.setValue(this.values.title)
					.onChange((v) => (this.values.title = v));
				text.inputEl.classList.add("issue-board-modal-title");
			});
		}

		new Setting(contentEl).setName("Status").addDropdown((dd) => {
			for (const s of this.surface.config.statuses) {
				dd.addOption(s.id, s.name);
			}
			if (
				!this.surface.config.statuses.some((s) => s.id === this.values.status)
			) {
				dd.addOption(this.values.status, this.values.status);
			}
			dd.setValue(this.values.status).onChange((v) => (this.values.status = v));
		});

		new Setting(contentEl).setName("Priority").addDropdown((dd) => {
			dd.addOption("1", "P1 — urgent");
			dd.addOption("2", "P2 — high");
			dd.addOption("3", "P3 — medium");
			dd.addOption("4", "P4 — low (default)");
			dd.setValue(String(this.values.priority)).onChange((v) => {
				this.values.priority = parsePriority(v);
			});
		});

		new Setting(contentEl).setName("Due date").addText((text) => {
			text.inputEl.type = "date";
			text
				.setValue(this.values.due)
				.onChange((v) => (this.values.due = v));
		});

		if (!isDraft) {
			new Setting(contentEl).setName("Body").addTextArea((text) => {
				text
					.setValue(this.values.body)
					.onChange((v) => (this.values.body = v));
				text.inputEl.rows = 12;
				text.inputEl.classList.add("issue-board-modal-body");
			});
		}

		const buttons = contentEl.createDiv({ cls: "issue-board-modal-buttons" });
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		new ButtonComponent(buttons)
			.setCta()
			.setButtonText("Save")
			.onClick(() => void this.submit());
	}

	private async submit() {
		const title = this.values.title.trim();
		if (!title) {
			new Notice("Issue title is required.");
			return;
		}
		const due = this.values.due || undefined;
		const priority =
			this.values.priority === DEFAULT_PRIORITY
				? undefined
				: this.values.priority;
		try {
			if (this.issue.kind === "draft") {
				await this.surface.store.updateDraft(this.issue.id, {
					title,
					status: this.values.status,
					body: this.values.body,
					due,
					priority,
				});
			} else {
				await this.surface.store.updateFileIssue(this.issue.path, {
					title,
					status: this.values.status,
					body: this.values.body,
					due,
					priority,
				});
			}
			this.close();
		} catch (e) {
			new Notice(`Failed to update issue: ${(e as Error).message}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function parsePriority(v: string): Priority {
	const n = parseInt(v, 10);
	if (n === 1 || n === 2 || n === 3 || n === 4) return n;
	return DEFAULT_PRIORITY;
}

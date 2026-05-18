import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { StatusDef } from "../types";

const DEFAULT_NEW_COLOR = "#7a7a7a";

export interface StatusModalCallbacks {
	/** Save handler. For edits, `previousId` is the status being modified. */
	onSave: (next: StatusDef, previousId: string | null) => Promise<void> | void;
	/** Delete handler. Only invoked for edits. */
	onDelete?: (id: string) => Promise<void> | void;
}

/**
 * Add-or-edit dialog for a board status. Use `null` for `existing` to add
 * a new status; pass an existing {@link StatusDef} to edit it.
 */
export class StatusModal extends Modal {
	private existing: StatusDef | null;
	private name: string;
	private color: string;
	private callbacks: StatusModalCallbacks;

	constructor(
		app: App,
		existing: StatusDef | null,
		callbacks: StatusModalCallbacks
	) {
		super(app);
		this.existing = existing;
		this.name = existing?.name ?? "";
		this.color = existing?.color ?? DEFAULT_NEW_COLOR;
		this.callbacks = callbacks;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("issue-board-modal");
		contentEl.createEl("h2", {
			text: this.existing ? "Edit status" : "Add status",
		});

		new Setting(contentEl).setName("Name").addText((text) => {
			text
				.setPlaceholder("Status name")
				.setValue(this.name)
				.onChange((v) => (this.name = v));
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		new Setting(contentEl).setName("Color").addColorPicker((picker) => {
			picker.setValue(this.color).onChange((v) => (this.color = v));
		});

		const buttons = contentEl.createDiv({ cls: "issue-board-modal-buttons" });
		if (this.existing && this.callbacks.onDelete) {
			new ButtonComponent(buttons)
				.setButtonText("Delete")
				.setWarning()
				.onClick(() => void this.handleDelete());
		}
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		new ButtonComponent(buttons)
			.setCta()
			.setButtonText(this.existing ? "Save" : "Add")
			.onClick(() => void this.handleSave());
	}

	private async handleSave() {
		const name = this.name.trim();
		if (!name) {
			new Notice("Status name is required.");
			return;
		}
		const id = this.existing?.id ?? toStatusId(name);
		try {
			await this.callbacks.onSave({ id, name, color: this.color }, this.existing?.id ?? null);
			this.close();
		} catch (e) {
			new Notice(`Failed to save status: ${(e as Error).message}`);
		}
	}

	private async handleDelete() {
		if (!this.existing || !this.callbacks.onDelete) return;
		try {
			await this.callbacks.onDelete(this.existing.id);
			this.close();
		} catch (e) {
			new Notice(`Failed to delete status: ${(e as Error).message}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function toStatusId(name: string): string {
	const cleaned = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "status";
}

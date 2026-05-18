export function applyTemplate(
	template: string,
	values: Record<string, string>
): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
		const v = values[key];
		return v === undefined ? "" : v;
	});
}

export function sanitizeFileTitle(title: string): string {
	// Obsidian disallows the following characters in file names.
	return title.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
}

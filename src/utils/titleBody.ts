/**
 * Helpers for the unified Title/Body textarea used by drafts. Line 1 is the
 * title; lines 2+ are the body. Kept here so both modal and inline editors
 * share the exact same split/join semantics.
 */
export function splitTitleAndBody(value: string): { title: string; body: string } {
	const newlineIdx = value.indexOf("\n");
	if (newlineIdx === -1) return { title: value, body: "" };
	return {
		title: value.slice(0, newlineIdx),
		body: value.slice(newlineIdx + 1),
	};
}

export function joinTitleAndBody(title: string, body: string): string {
	if (!body) return title;
	return `${title}\n${body}`;
}

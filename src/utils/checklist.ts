export interface ChecklistCount {
	total: number;
	done: number;
}

const CHECKLIST_RE = /^[ \t]*[-*+]\s+\[([ xX])\]\s+/gm;

export function countChecklist(body: string): ChecklistCount {
	let total = 0;
	let done = 0;
	let m: RegExpExecArray | null;
	CHECKLIST_RE.lastIndex = 0;
	while ((m = CHECKLIST_RE.exec(body))) {
		total += 1;
		if (m[1] !== " ") done += 1;
	}
	return { total, done };
}

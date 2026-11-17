const FENCE = /^\s{0,3}(```|~~~)/;
/**
 * The closing questions heading of a reply (S8): "Needs your decision" as a Markdown heading or a bold-only line,
 * any case, with or without a final colon (inside or outside the bold).
 */
const QUESTIONS =
	/^\s{0,3}(?:#{1,6}\s+(?:\*\*|__)?needs your decision:?(?:\*\*|__)?:?(?:\s+#+)?|(?:\*\*|__)needs your decision:?(?:\*\*|__):?)\s*$/i;

/** The last "Needs your decision" heading or bold-only line and everything after it, or undefined when there is none. */
export function questionsSection(markdown: string): string | undefined {
	const lines = markdown.split("\n");
	let start: number | undefined;
	let fenced = false;
	lines.forEach((line, index) => {
		if (FENCE.test(line)) fenced = !fenced;
		if (!fenced && QUESTIONS.test(line)) start = index;
	});
	return start === undefined ? undefined : lines.slice(start).join("\n").trimEnd();
}

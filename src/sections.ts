/** A fence line opening or closing a code block; headings inside one are not headings. */
const FENCE = /^\s{0,3}(```|~~~)/;
/** An ATX heading: up to three spaces, one to six `#` (its level), then its text (a closing run of `#` is dropped). */
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
/** Leading numbering of a heading or a section name: `2.`, `5.2.`, `3)`, `1:`. */
const NUMBERING = /^\d+(?:\.\d+)*[.):]?\s+/;

/**
 * How a heading or a wanted section compares (S9): lower case, no accents, no leading numbering, `-`, `_` and `/` as
 * spaces, other punctuation dropped, spaces collapsed.
 */
export function sectionKey(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[-_/]/g, " ")
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(NUMBERING, "");
}

/**
 * The section of `markdown` whose heading matches `section` (S9): from that heading up to the next heading of the same
 * or a higher level, or to the end with `rest`. Undefined when no heading matches. An exact match wins over a prefix
 * match; a prefix match counts only when exactly one heading has it; of several exact matches the first wins.
 */
export function sectionFrom(markdown: string, section: string, options: { rest?: boolean } = {}): string | undefined {
	const wanted = sectionKey(section);
	if (!wanted) return undefined;
	const lines = markdown.split("\n");
	const headings: { line: number; level: number; key: string }[] = [];
	let fenced = false;
	lines.forEach((line, index) => {
		if (FENCE.test(line)) fenced = !fenced;
		if (fenced) return;
		const heading = HEADING.exec(line);
		if (heading) headings.push({ line: index, level: heading[1].length, key: sectionKey(heading[2]) });
	});
	const exact = headings.find((heading) => heading.key === wanted);
	const prefixes = headings.filter((heading) => heading.key.startsWith(wanted));
	const match = exact ?? (prefixes.length === 1 ? prefixes[0] : undefined);
	if (!match) return undefined;
	const end = options.rest ? undefined : headings.find((heading) => heading.line > match.line && heading.level <= match.level)?.line;
	return lines.slice(match.line, end).join("\n").trimEnd();
}

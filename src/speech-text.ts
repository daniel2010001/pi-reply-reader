/**
 * Turns a Markdown reply into text meant to be heard: the syntax a voice would read literally
 * ("asterisco asterisco", "or col 1 or", "comilla simple") is removed and the words are kept.
 * Deterministic and model-free, so the same reply always sounds the same.
 */
export function speechText(markdown: string): string {
	const out: string[] = [];
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	let fence: { char: string; length: number } | undefined;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];

		if (fence) {
			const close = /^\s*(`{3,}|~{3,})\s*$/.exec(raw);
			if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = undefined;
			continue;
		}
		const open = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
		if (open) {
			fence = { char: open[1][0], length: open[1].length };
			out.push(CODE_BLOCK);
			continue;
		}

		if (raw.includes("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
			out.push(tableRow(raw));
			i++;
			while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim() !== "") {
				out.push(tableRow(lines[++i]));
			}
			continue;
		}

		out.push(blockLine(raw));
	}

	return out
		.join("\n")
		.replace(/[ \t]{2,}|\t/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Said in place of a fenced block, so a sentence like "run this:" does not hang. */
const CODE_BLOCK = "Bloque de código.";
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const WORD = String.raw`\p{L}\p{N}_`;

function blockLine(raw: string): string {
	let line = raw.trim();
	while (/^>\s?/.test(line)) line = line.replace(/^>\s?/, "").trim();

	if (/^([-*_])(\s*\1){2,}$/.test(line)) return "";
	if (/^\[[^\]]+\]:\s*\S+/.test(line)) return "";

	const heading = /^#{1,6}\s+(.*?)(\s+#+)?$/.exec(line);
	if (heading) return closeSentence(inline(heading[1]));

	const bullet = /^[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
	if (bullet) return closeSentence(inline(bullet[1]));

	const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);
	if (numbered) return closeSentence(`${numbered[1]}. ${inline(numbered[2])}`);

	return inline(line);
}

function tableRow(raw: string): string {
	const cells = raw
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => inline(cell.trim()))
		.filter((cell) => cell !== "");
	return closeSentence(cells.join(", "));
}

function closeSentence(text: string): string {
	return text === "" || /[.!?:;…,]$/.test(text) ? text : `${text}.`;
}

/**
 * Inline syntax: code spans are spoken verbatim (minus backticks), everything else is unwrapped.
 * Code spans and escapes are parked behind private-use markers so emphasis around them still pairs up
 * and their characters never count as Markdown.
 */
function inline(text: string): string {
	const spans: string[] = [];
	const parked = text
		.replace(/(`+)(.+?)(?<!`)\1(?!`)/g, (_m, _ticks, code: string) => `\uE002${spans.push(codeSpan(code)) - 1}\uE003`)
		.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_m, ch: string) => `\uE000${ch.codePointAt(0)}\uE001`);
	return prose(parked)
		.replace(/\uE000(\d+)\uE001/g, (_m, code: string) => String.fromCodePoint(Number(code)))
		.replace(/\uE002(\d+)\uE003/g, (_m, index: string) => spans[Number(index)]);
}

function codeSpan(code: string): string {
	return identifierSpaces(code.trim());
}

/** `auto_read` reads as "auto read", not "auto guion bajo read". */
function identifierSpaces(text: string): string {
	return text.replace(/(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu, " ");
}

function prose(text: string): string {
	const unwrapped = text
		.replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1")
		.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
		.replace(/<(https?:\/\/[^>\s]+)>/g, (_m, url: string) => host(url))
		.replace(/\bhttps?:\/\/[^\s<>()[\]*]+/g, (url) => {
			const trailing = /[.,;:!?]+$/.exec(url)?.[0] ?? "";
			return host(url.slice(0, url.length - trailing.length)) + trailing;
		})
		.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
		.replace(new RegExp(`(?<![${WORD}])__(?=\\S)(.+?)(?<=\\S)__(?![${WORD}])`, "gu"), "$1")
		.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
		.replace(new RegExp(`(?<![${WORD}*])\\*(?=\\S)([^*\\n]*?)(?<=\\S)\\*(?![${WORD}*])`, "gu"), "$1")
		.replace(new RegExp(`(?<![${WORD}])_(?=\\S)([^_\\n]*?)(?<=\\S)_(?![${WORD}])`, "gu"), "$1");
	return identifierSpaces(unwrapped);
}

function host(url: string): string {
	return url
		.replace(/^https?:\/\//, "")
		.split(/[/?#]/)[0]
		.replace(/^www\./, "");
}

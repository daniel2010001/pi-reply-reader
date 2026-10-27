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
	return speakable(code.trim());
}

/** IDs, symbols, emoji and paths a voice stumbles on, made speakable (prose and code spans alike). */
function speakable(text: string): string {
	const urls: string[] = [];
	let out = text.replace(/\S*:\/\/\S*/g, (url) => `\uE004${urls.push(url) - 1}\uE005`);
	out = identifierSpaces(out.replace(/\S+/g, pathWords));
	out = out.replace(
		/(?<![\p{L}\p{N}.])P(\d+)\.R(\d+)(?:\.Q(\d+))?(?![\p{L}\p{N}]|\.[\p{L}\p{N}])/gu,
		(_m, p: string, r: string, q?: string) => `P ${p}, R ${r}${q ? `, Q ${q}` : ""}`,
	);
	out = out.replace(/(\d)[ \t]*×[ \t]*(?=\d)/g, "$1 por ");
	for (const [symbol, word] of SYMBOL_WORDS) out = spokenAs(out, symbol, word);
	return spokenAs(out, EMOJI, "").replace(/\uE004(\d+)\uE005/g, (_m, index: string) => identifierSpaces(urls[Number(index)]));
}

const SYMBOL_WORDS: [RegExp, string][] = [
	[/[→⇒➜]/, "a"],
	[/←/, "desde"],
	[/≈/, "aproximadamente"],
	[/≠/, "distinto de"],
	[/≥/, "mayor o igual a"],
	[/≤/, "menor o igual a"],
	[/±/, "más o menos"],
	[/&+/, "y"],
];
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3])+/u;

/** Replaces `symbol` with `word`, spaced from neighbouring words but not from punctuation. */
function spokenAs(text: string, symbol: RegExp, word: string): string {
	const pattern = new RegExp(`[ \\t]*(?:${symbol.source})[ \\t]*`, "gu");
	return text.replace(pattern, (match: string, offset: number, whole: string) => {
		const before = offset > 0 && !/[([{\s]/u.test(whole[offset - 1]);
		const next = whole[offset + match.length];
		const after = next !== undefined && !/[)\]}.,;:!?\s]/u.test(next);
		if (word === "") return before && after ? " " : "";
		return `${before ? " " : ""}${word}${after ? " " : ""}`;
	});
}

/**
 * `~/.gentle-shell/agent/AGENTS.md` reads as "gentle shell agent AGENTS punto md" and
 * `feat/pending-central` as "feat pending central". Fractions (`1/2`), URLs and short word pairs
 * such as `y/o` or `km/h` are kept.
 */
function pathWords(token: string): string {
	const [, lead, core, trail] = /^([("'“«[]*)(.*?)([)"'”»\].,;:!?]*)$/u.exec(token) ?? [];
	if (!core || core.includes("://") || !/[\p{L}\p{N}]/u.test(core)) return token;
	const rooted = /^(?:~|\.{1,2})?\//.test(core);
	if (!rooted && !/\p{L}\/[\p{L}\p{N}]|[\p{L}\p{N}]\/\p{L}/u.test(core)) return token;
	if (!rooted && /^\p{L}{1,3}\/\p{L}{1,3}$/u.test(core)) return token;
	const segments = core.split("/").map((segment) => segment.replace(/^[~.]+/, "")).filter((segment) => segment !== "");
	const last = segments.length - 1;
	if (last >= 0) segments[last] = segments[last].replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, " punto ");
	const words = segments.join(" ").replace(/(?<=[\p{L}\p{N}])[-_]+(?=[\p{L}\p{N}])/gu, " ");
	return `${lead}${words}${trail}`;
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
	return speakable(unwrapped);
}

function host(url: string): string {
	return url
		.replace(/^https?:\/\//, "")
		.split(/[/?#]/)[0]
		.replace(/^www\./, "");
}

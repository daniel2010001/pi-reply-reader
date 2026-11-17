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

		const { text, section } = blockLine(raw);
		out.push(text);
		// A heading or bold-only line ends its section, so playback pauses as at a blank line; trim drops a last one.
		if (section) out.push("");
	}

	return out
		.join("\n")
		.replace(/[ \t]{2,}|\t/g, " ")
		// The readings above add "el comando"; Spanish contracts "de el" and "a el" (but not "de él").
		.replace(/(?<![\p{L}\p{N}])([dD]e|[aA]) el(?![\p{L}\p{N}])/gu, (_m, word: string) => (word.length === 1 ? `${word}l` : `${word[0]}el`))
		// The reverse for a contraction already written before the token: "del el comando" → "del comando",
		// "del la rama" → "de la rama", "al un commit" → "a un commit".
		.replace(
			/(?<![\p{L}\p{N}])([dD]e|[aA])l (el|la|un) (comando|carpeta|rama|commit)(?![\p{L}\p{N}])/gu,
			(_m, word: string, article: string, noun: string) => (article === "el" ? `${word}l ${noun}` : `${word} ${article} ${noun}`),
		)
		// A numbered heading or bold line ("## 1. Estado", "## 5.2. Título") starts with "1." too; "1:" keeps playback
		// from cutting there.
		.replace(/^(\d+(?: punto \d+)*)\. /gm, "$1: ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Said in place of a fenced block, so a sentence like "run this:" does not hang. */
const CODE_BLOCK = "Bloque de código.";
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const WORD = String.raw`\p{L}\p{N}_`;

/** A line wrapped whole in one emphasis (`**Qué cambió**`, `*Nota*`, `__X__`), read like a heading. */
const EMPHASIS_LINE = /^(?:\*\*(?=\S)(?:(?!\*\*).)+(?<=\S)\*\*|__(?=\S)(?:(?!__).)+(?<=\S)__|\*(?=\S)[^*]+(?<=\S)\*|_(?=\S)[^_]+(?<=\S)_)$/;

/** One line of text; `section` marks a heading or bold-only line, which a section break follows. */
function blockLine(raw: string): { text: string; section?: boolean } {
	let line = raw.trim();
	while (/^>\s?/.test(line)) line = line.replace(/^>\s?/, "").trim();

	if (/^([-*_])(\s*\1){2,}$/.test(line)) return { text: "" };
	if (/^\[[^\]]+\]:\s*\S+/.test(line)) return { text: "" };

	const heading = /^#{1,6}\s+(.*?)(\s+#+)?$/.exec(line);
	if (heading) {
		const text = inline(heading[1]);
		return { text: closeSentence(spokenHeading(text)), section: true };
	}
	if (EMPHASIS_LINE.test(line)) return { text: closeSentence(spokenHeading(inline(line))), section: true };

	const bullet = /^[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
	if (bullet) return { text: closeSentence(inline(bullet[1])) };

	const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);
	// "1:" rather than "1.", which playback would cut at, reading the number alone.
	if (numbered) return { text: closeSentence(`${numbered[1]}: ${inline(numbered[2])}`) };

	return { text: inline(line) };
}

/** Every reply here closes with the English heading "Needs your decision"; a Spanish voice would mangle it. */
function spokenHeading(text: string): string {
	return /^needs your decision:?$/i.test(text) ? "Decisiones pendientes" : text;
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
		.replace(
			/(`+)(.+?)(?<!`)\1(?!`)/g,
			(_m, _ticks, code: string, offset: number) => `\uE002${spans.push(codeSpan(code, text.slice(0, offset))) - 1}\uE003`,
		)
		.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_m, ch: string) => `\uE000${ch.codePointAt(0)}\uE001`);
	return prose(parked)
		.replace(/\uE000(\d+)\uE001/g, (_m, code: string) => String.fromCodePoint(Number(code)))
		.replace(/\uE002(\d+)\uE003/g, (_m, index: string) => spans[Number(index)])
		.replace(/[ \t]*\uE008|[\uE006\uE007]/g, "");
}

/** `before` is the text ahead of the span, so a branch or hash in it can tell what word precedes it. */
function codeSpan(code: string, before: string): string {
	return PUNCTUATION_NAMES[code.trim()] ?? speakable(code.trim(), before);
}

/** A code span holding one mark is spoken by name; a bare "." would also end a sentence in playback. */
const PUNCTUATION_NAMES: Record<string, string> = {
	".": "punto",
	",": "coma",
	";": "punto y coma",
	":": "dos puntos",
	"!": "signo de exclamación",
	"?": "signo de pregunta",
	"~": "virgulilla",
	"/": "barra",
	"-": "guion",
	_: "guion bajo",
	"*": "asterisco",
	"#": "numeral",
	"|": "barra vertical",
};

/** IDs, symbols, emoji and technical tokens a voice stumbles on, made speakable (prose and code spans alike). */
function speakable(text: string, before = ""): string {
	const urls: string[] = [];
	let out = text.replace(/\S*:\/\/\S*/g, (url) => `\uE004${urls.push(url) - 1}\uE005`);
	out = identifierSpaces(
		out.replace(/\S+/g, (token: string, offset: number, whole: string) =>
			tokenReading(token, previousWord(before + whole.slice(0, offset))),
		),
	);
	out = out
		// "aproximadamente" has no gender, unlike "unos" ("las unos 400 líneas").
		.replace(/(?<![\p{L}\p{N}])~(?=\d)/gu, "aproximadamente ")
		.replace(UNIT, (_m, number: string, unit: string) => `${number} ${(number === "1" ? UNIT_WORD : UNIT_WORDS)[unit]}`)
		// After the units, so "2.1 s" is "2 punto 1 segundos" and not "2 punto 1 segundo".
		.replace(DOTTED_NUMBER, dottedNumber);
	out = out.replace(
		/(?<![\p{L}\p{N}.])P(\d+)\.R(\d+)(?:\.Q(\d+))?(?![\p{L}\p{N}]|\.[\p{L}\p{N}])/gu,
		(_m, p: string, r: string, q?: string) => `P ${p}, R ${r}${q ? `, Q ${q}` : ""}`,
	);
	out = out.replace(/(\d)[ \t]*×[ \t]*(?=\d)/g, "$1 por ");
	for (const [symbol, word] of SYMBOL_WORDS) out = spokenAs(out, symbol, word);
	return spokenAs(out, EMOJI, "")
		.replace(/\uE004(\d+)\uE005/g, (_m, index: string) => identifierSpaces(urls[Number(index)]))
		.replace(/\uE009/g, ".");
}

/**
 * (h1) Digit groups joined by single dots, standing alone: not inside a word, a version tag (`v2.0.1`,
 * `x@2.0.1`), a file name (`2.0.1.tgz`), a host (marked by `prose`) or an address after `tcp:`. A dot between
 * digits in a technical token's own reading is parked as \uE009, so paths and file names keep theirs.
 */
const DOTTED_NUMBER =
	/\uE006[^\uE007]*\uE007|(?<![\p{L}\p{N}_.@/:\\\uE009])(?<![\p{L}\p{N}_]-)\d+(?:\.\d+)+(?![\p{L}\p{N}_@/\\\uE009]|\.[\p{L}\p{N}])/gu;
/** Spanish thousands: "2.750", "1.500.000". */
const THOUSANDS = /^[1-9]\d{0,2}(?:\.\d{3})+$/;

/** "1.1" reads as "1 punto 1"; thousands, IP addresses and hosts stay as they are. */
function dottedNumber(match: string): string {
	if (match.startsWith("\uE006") || THOUSANDS.test(match)) return match;
	const groups = match.split(".");
	if (groups.length === 4 && groups.every((group) => group.length <= 3 && Number(group) <= 255)) return match;
	return groups.join(" punto ");
}

/** A unit right after a number that letters or a version dot do not precede: "2,5 s", "80%", "-16 dB". */
const UNIT = /(?<![\p{L}\p{N}_.,])(\d+(?:[.,]\d+)*)[ \t]?(dBFS|dB|ms|min|s|KB|MB|GB|%)(?![\p{L}\p{N}])/gu;
const UNIT_WORDS: Record<string, string> = {
	s: "segundos",
	ms: "milisegundos",
	min: "minutos",
	KB: "kilobytes",
	MB: "megabytes",
	GB: "gigabytes",
	"%": "por ciento",
	dB: "decibeles",
	dBFS: "decibeles",
};
/** The same units after exactly 1. */
const UNIT_WORD: Record<string, string> = {
	s: "segundo",
	ms: "milisegundo",
	min: "minuto",
	KB: "kilobyte",
	MB: "megabyte",
	GB: "gigabyte",
	"%": "por ciento",
	dB: "decibel",
	dBFS: "decibel",
};

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
 * One technical token, read by its class in the order of S2 (e2)-(e8); URLs never get here (e1).
 * Leading and trailing punctuation stays outside, so "`README.md`." reads "README punto md.".
 * A dropped token leaves a \uE008 marker that takes the space before it along when removed.
 */
function tokenReading(token: string, previous: string): string {
	const [, lead, core, trail] = /^([("'“«[]*)(.*?)([)"'”»\].,;:!?]*)$/u.exec(token) ?? [];
	if (!core || /[\uE000-\uE008]/u.test(token) || !/[\p{L}\p{N}]/u.test(core)) return token;
	const reading = classified(core, previous.toLowerCase());
	if (reading === undefined) return token;
	if (reading === "") return `\uE008${trail}`;
	// A dot between digits in a reading ("a punto ts, en 1.2") is the token's own; (h1) leaves it.
	return `${lead}${reading.replace(/(?<=\d)\.(?=\d)/g, "\uE009")}${trail}`;
}

function classified(core: string, previous: string): string | undefined {
	if (previous === "rama" || previous === "branch") return nameWords(core);
	const line = /^(.+):(\d+)$/.exec(core);
	const file = line && (pathReading(line[1], previous) ?? fileName(line[1]));
	if (line && file) return `${file}, línea ${line[2]}`;
	if (BRANCH.test(core) && !/\.\p{L}+$/u.test(core)) return `la rama ${nameWords(core)}`;
	return (
		alternatives(core) ??
		pathReading(core, previous) ??
		command(core, previous) ??
		fileName(core) ??
		commitHash(core, previous) ??
		slashWords(core)
	);
}

const BRANCH = /^(?:feat|fix|docs|chore|refactor|test|release|origin|upstream)\/[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u;
const PATH = /^[\p{L}\p{N}._~/+-]+$/u;
/** A bare `name.<tld>` is a host, not a file. */
const HOST_ENDINGS = new Set(["com", "org", "net", "io", "dev", "lan", "app", "ai", "co"]);

/** `feat/pending-central` reads as "feat pending central". */
function nameWords(core: string): string {
	return core.replace(/(?<=[\p{L}\p{N}])[-_/]+(?=[\p{L}\p{N}])/gu, " ");
}

/** `light/dark` reads as "light o dark"; short pairs such as `y/o` or `km/h` are kept. */
function alternatives(core: string): string | undefined {
	const pair = /^(\p{L}+)\/(\p{L}+)$/u.exec(core);
	if (!pair) return undefined;
	return pair[1].length <= 3 && pair[2].length <= 3 ? core : `${pair[1]} o ${pair[2]}`;
}

/**
 * The last part plus its folder: `~/.gentle-shell/agent/AGENTS.md` reads as "AGENTS punto md, en agent"
 * and `/tmp/x/wav/hs/` as "la carpeta hs, en wav" ("hs, en wav" right after "carpeta"). A single `/word` is
 * left to `command`, `1/2` to the numbers.
 */
function pathReading(core: string, previous: string): string | undefined {
	if (!PATH.test(core)) return undefined;
	const root = /^(?:~|\.{1,2})?\//.exec(core)?.[0] ?? "";
	const parts = core.slice(root.length).split("/").filter((part) => part !== "");
	const isFolder = core.endsWith("/");
	if (root === "/" ? parts.length < 2 && !isFolder : root === "" && parts.length < 2) return undefined;
	if (root === "" && !/\p{L}\/[\p{L}\p{N}]|[\p{L}\p{N}]\/\p{L}/u.test(core)) return undefined;
	const name = partName(parts.at(-1) ?? "");
	if (name === "") return undefined;
	const said = previous === "carpeta" || previous === "folder";
	const reading = (!isFolder && fileReading(parts.at(-1) ?? "")) || (said ? name : `la carpeta ${name}`);
	const folder = parts.length > 1 ? partName(parts[parts.length - 2]) : "";
	return folder === "" ? reading : `${reading}, en ${folder}`;
}

/** A leading `.` is dropped and `-`/`_` become spaces: `.gentle-shell` reads as "gentle shell". */
function partName(part: string): string {
	return part.replace(/^\.+/, "").replace(/[-_]+/g, " ").trim();
}

/** `speech-text.ts` reads as "speech text punto ts"; a part without a letter-only extension is not a file. */
function fileReading(part: string): string | undefined {
	const file = /^(.*\p{L}.*)\.(\p{L}+)$/u.exec(part);
	if (!file) return undefined;
	const name = partName(file[1]).replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, " punto ");
	return name === "" ? undefined : `${name} punto ${file[2]}`;
}

/** Top-level folders of a Unix system: `/tmp` is a place, not a command. */
const SYSTEM_FOLDERS = new Set(["bin", "boot", "dev", "etc", "home", "lib", "media", "mnt", "opt", "proc", "root", "run", "srv", "sys", "tmp", "usr", "var"]);

/** `/reload` reads as "el comando reload", or just "reload" right after "comando"; `/tmp` reads as "la carpeta tmp". */
function command(core: string, previous: string): string | undefined {
	const name = /^\/(\p{L}[\p{L}\p{N}_:-]*)$/u.exec(core)?.[1]?.replace(/[-_:]+/g, " ");
	if (!name) return undefined;
	if (SYSTEM_FOLDERS.has(name)) return previous === "carpeta" || previous === "folder" ? name : `la carpeta ${name}`;
	return previous === "comando" || previous === "command" ? name : `el comando ${name}`;
}

/** A bare `README.md`; versions, numbers, hosts, `a..b` ranges and abbreviations such as `e.g` are not file names. */
function fileName(core: string): string | undefined {
	if (!/^[\p{L}\p{N}_.-]+$/u.test(core) || /^(?:\p{L}\.)+\p{L}$/u.test(core) || core.includes("..")) return undefined;
	const ext = /\.(\p{L}+)$/u.exec(core)?.[1];
	return ext && !HOST_ENDINGS.has(ext.toLowerCase()) ? fileReading(core) : undefined;
}

/** A hash is dropped right after "commit" and spoken as "un commit" elsewhere. */
function commitHash(core: string, previous: string): string | undefined {
	if (!/^(?=.*\d)(?=.*[a-f])[0-9a-f]{7,40}$/.test(core)) return undefined;
	return previous === "commit" || previous === "commits" ? "" : "un commit";
}

/** Other paths, such as `@scope/pkg`, `lab-*` globs or `/a/<id>/b`, keep (d)'s reading: their parts as words. */
function slashWords(core: string): string | undefined {
	if (!/^(?:~|\.{1,2})?\//.test(core) && !/\p{L}\/[\p{L}\p{N}]|[\p{L}\p{N}]\/\p{L}/u.test(core)) return undefined;
	const parts = core.split("/").map((part) => part.replace(/^[~.]+/, "")).filter((part) => part !== "");
	return parts.join(" ").replace(/(?<=[\p{L}\p{N}])[-_]+(?=[\p{L}\p{N}])/gu, " ");
}

/** The word right before a token, across spaces, opening quotes and emphasis markers. */
function previousWord(text: string): string {
	return /(?<![\p{L}\p{N}])(\p{L}+)[ \t*_`"'“«(]*$/u.exec(text)?.[1] ?? "";
}

/** `auto_read` reads as "auto read", not "auto guion bajo read". */
function identifierSpaces(text: string): string {
	return text.replace(/(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu, " ");
}

function prose(text: string): string {
	const unwrapped = text
		.replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1")
		.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
		// Hosts are marked so the file-name rule leaves `github.com` alone; `inline` drops the marks.
		.replace(/<(https?:\/\/[^>\s]+)>/g, (_m, url: string) => `\uE006${host(url)}\uE007`)
		.replace(/\bhttps?:\/\/[^\s<>()[\]*]+/g, (url) => {
			const trailing = /[.,;:!?]+$/.exec(url)?.[0] ?? "";
			return `\uE006${host(url.slice(0, url.length - trailing.length))}\uE007${trailing}`;
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

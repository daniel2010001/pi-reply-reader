/**
 * Turns a Markdown reply into text meant to be heard: the syntax a voice would read literally
 * ("asterisco asterisco", "or col 1 or", "comilla simple") is removed and the words are kept.
 * Deterministic and model-free, so the same reply always sounds the same.
 */
export function speechText(markdown: string, language?: Language): string {
	return speechReading(markdown, language).text;
}

export type Language = "es" | "en";

/**
 * The cleaned text plus the language its added words are in (S7). Pass `language` when `markdown` is part
 * of a larger text (a section, the closing questions), so the part follows the language of the whole.
 */
export function speechReading(markdown: string, language: Language = detectLanguage(markdown)): { text: string; language: Language } {
	const { text } = speechNarration(markdown, language);
	return { text, language };
}

/** (S12) What a block of the reply is, which a listener hears as its shape. */
export type Role = "heading" | "paragraph" | "item" | "row" | "codeBlock";

/** (S12) What follows a fragment: a sentence on the same line, a line, or a blank line (also after a heading). */
export type Boundary = "sentence" | "line" | "paragraph";

/**
 * (S12) One block of the Markdown, in order, with its 1-based source line and still in Markdown: the plan adds no
 * word of any language. A `break` is a blank line, a thematic break or a reference definition.
 */
export type PlanBlock =
	| { role: "heading"; source: string; line: number }
	| { role: "paragraph"; source: string; line: number }
	| { role: "item"; number?: string; source: string; line: number }
	| { role: "row"; cells: string[]; line: number }
	| { role: "codeBlock"; line: number }
	| { role: "break"; line: number };

export interface NarrationPlan {
	blocks: PlanBlock[];
}

/** (S12) One piece of speech, synthesized at once, with the boundary (and so the pause) after it. */
export interface Fragment {
	text: string;
	role: Role;
	after: Boundary;
}

/**
 * (S12) A technical token no reading class claimed, read as written: one holding `/ \ = < > | * { } $ ^ @ # +`
 * or `..`, other than a plain number. Listed by source line; within a line,
 * tokens in code spans come before those in prose. Never changes what is spoken.
 */
export interface Diagnostic {
	line: number;
	token: string;
}

export interface Narration {
	/** The same text `speechText` returns. */
	text: string;
	language: Language;
	fragments: Fragment[];
	diagnostics: Diagnostic[];
}

/** (S12) `speechReading`, plus the fragments playback speaks and the tokens the cleanup could not classify. */
export function speechNarration(markdown: string, language: Language = detectLanguage(markdown)): Narration {
	return renderNarration(narrationPlan(markdown), language);
}

/**
 * (S7) English or Spanish, from the text's own function words; code, URLs and paths do not count.
 * Spanish wins ties, so a reply with no clear English majority reads as it always did.
 */
export function detectLanguage(markdown: string): Language {
	const prose = markdown
		.replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\s{0,3}\1[^\n]*$|(?![\s\S]))/gm, " ")
		// The closing heading every reply here uses is English even in a Spanish reply.
		.replace(/^\s*(?:#{1,6}\s+|\*\*|__)?needs your decision:?(?:\*\*|__)?\s*$/gim, " ")
		.replace(/(`+)[\s\S]+?\1/g, " ")
		.replace(/\S*(?::\/\/|[/\\~])\S*/g, " ")
		.toLowerCase();
	let english = 0;
	let spanish = 0;
	for (const [word] of prose.matchAll(/\p{L}+/gu)) {
		if (ENGLISH_WORDS.has(word)) english++;
		else if (SPANISH_WORDS.has(word)) spanish++;
	}
	return english > spanish ? "en" : "es";
}

/** Common function words found in one language only ("a", "no" and "me" are in both and count for neither). */
const ENGLISH_WORDS = new Set(
	"the and of to is are was were be been being it its this that these those with for from on at by an as or not but if then than when which what who how you your we our they their there here will would can could should does do did has have had into only also just about all any each more most such so".split(" "),
);
const SPANISH_WORDS = new Set(
	"el la los las de del al que y en un una unos unas es son era fue ser está están estar por para con sin se lo le les su sus este esta esto estos estas ese esa eso como más pero si sí ya hay cuando también porque sobre muy entre hasta desde todo todos cada qué cómo donde dónde o ni".split(" "),
);

/** The phrasebook of the text being cleaned; `renderNarration` sets it around one synchronous run. */
let words: Phrasebook;
/** Where `renderNarration` collects diagnostics during its run, and the source line of the block being rendered. */
let diagnosis: { diagnostics: Diagnostic[]; line: number } | undefined;

/** (S12) The blocks of `markdown`, language-free: fences, table rows and one block per other line. */
export function narrationPlan(markdown: string): NarrationPlan {
	const blocks: PlanBlock[] = [];
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
			blocks.push({ role: "codeBlock", line: i + 1 });
			continue;
		}

		if (raw.includes("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
			blocks.push({ role: "row", cells: tableCells(raw), line: i + 1 });
			i++;
			while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim() !== "") {
				i++;
				blocks.push({ role: "row", cells: tableCells(lines[i]), line: i + 1 });
			}
			continue;
		}

		blocks.push(lineBlock(raw, i + 1));
	}
	return { blocks };
}

/**
 * (S12) The words of `plan` in `language`: one line per block (and a blank one after a heading, so playback pauses
 * as at a blank line), split into fragments, with the tokens no reading class claimed.
 */
export function renderNarration(plan: NarrationPlan, language: Language): Narration {
	const previous = { words, diagnosis };
	words = PHRASEBOOKS[language];
	diagnosis = { diagnostics: [], line: 0 };
	try {
		const lines: SpokenLine[] = [];
		for (const block of plan.blocks) {
			diagnosis.line = block.line;
			const role = block.role === "break" ? "paragraph" : block.role;
			lines.push({ text: finished(blockText(block)), role });
			// A heading or bold-only line ends its section, so playback pauses as at a blank line; trim drops a last one.
			if (block.role === "heading") lines.push({ text: "", role });
		}
		const text = lines
			.map((line) => line.text)
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		return { text, language, fragments: fragmentsOf(lines), diagnostics: diagnosis.diagnostics };
	} finally {
		({ words, diagnosis } = previous);
	}
}

/** (S12) Text already meant for speech, split as playback speaks it: every fragment a paragraph's. */
export function spokenFragments(text: string): Fragment[] {
	return fragmentsOf(text.split("\n").map((line) => ({ text: line, role: "paragraph" })));
}

interface SpokenLine {
	text: string;
	role: Role;
}

/**
 * Sentences and lines, in order, each with the boundary after it; Supertonic only calls back once per
 * 300 characters, so we split first. Never at ":" or ";", where a pause would sound like a full stop.
 * A line with no sentence (blank, or emoji only) ends a paragraph.
 */
function fragmentsOf(lines: readonly SpokenLine[]): Fragment[] {
	const result: Fragment[] = [];
	let blank = false;
	for (const { text, role } of lines) {
		const sentences = text
			.split(/(?<=[.!?…])\s+/)
			.map((sentence) => sentence.trim())
			.filter((sentence) => sentence !== "");
		if (sentences.length === 0) {
			blank = true;
			continue;
		}
		const previous = result.at(-1);
		if (previous) previous.after = blank ? "paragraph" : "line";
		blank = false;
		for (const sentence of sentences) result.push({ text: sentence, role, after: "sentence" });
	}
	return result;
}

/** The passes that once ran over the whole text; none of them crosses a line break, so they run per line. */
function finished(line: string): string {
	const spaced = line.replace(/[ \t]{2,}|\t/g, " ");
	return (words.contracts ? contracted(spaced) : spaced)
		// A numbered heading or bold line ("## 1. Estado", "## 5.2. Título") starts with "1." too; "1:" keeps playback
		// from cutting there.
		.replace(new RegExp(`^(\\d+(?: ${words.point} \\d+)*)\\. `), "$1: ");
}

/** Spanish: the readings add "el comando", "la rama", "un commit" next to "de" and "a". */
function contracted(text: string): string {
	return (
		text
			// Spanish contracts "de el" and "a el" (but not "de él").
			.replace(/(?<![\p{L}\p{N}])([dD]e|[aA]) el(?![\p{L}\p{N}])/gu, (_m, word: string) => (word.length === 1 ? `${word}l` : `${word[0]}el`))
			// The reverse for a contraction already written before the token: "del el comando" → "del comando",
			// "del la rama" → "de la rama", "al un commit" → "a un commit".
			.replace(
				/(?<![\p{L}\p{N}])([dD]e|[aA])l (el|la|un) (comando|carpeta|rama|commit)(?![\p{L}\p{N}])/gu,
				(_m, word: string, article: string, noun: string) => (article === "el" ? `${word}l ${noun}` : `${word} ${article} ${noun}`),
			)
	);
}

/** Every word the cleanup adds, per language (S7). */
interface Phrasebook {
	/** Said in place of a fenced block, so a sentence like "run this:" does not hang. */
	codeBlock: string;
	/** Said for the English closing heading "Needs your decision", which this language's voice would mangle. */
	needsYourDecision?: string;
	/** "de el" and "a el" contract, as in Spanish. */
	contracts: boolean;
	command: string;
	folder: string;
	branch: string;
	aCommit: string;
	/** "AGENTS punto md, en agent": the folder a path's last part is in. */
	in: string;
	line: string;
	/** Between a file name and its extension. */
	dot: string;
	/** Between the digit groups of a dotted number (h1). */
	point: string;
	or: string;
	approximately: string;
	/** × between numbers. */
	times: string;
	units: Record<string, string>;
	/** The same units after exactly 1. */
	unit: Record<string, string>;
	punctuation: Record<string, string>;
	symbols: [RegExp, string][];
	/** "2.750" is a Spanish thousand; in English it is a decimal. */
	thousands: boolean;
}

const SPANISH: Phrasebook = {
	codeBlock: "Bloque de código.",
	needsYourDecision: "Decisiones pendientes",
	contracts: true,
	command: "el comando",
	folder: "la carpeta",
	branch: "la rama",
	aCommit: "un commit",
	in: "en",
	line: "línea",
	dot: "punto",
	point: "punto",
	or: "o",
	approximately: "aproximadamente",
	times: "por",
	units: {
		s: "segundos",
		ms: "milisegundos",
		min: "minutos",
		KB: "kilobytes",
		MB: "megabytes",
		GB: "gigabytes",
		"%": "por ciento",
		dB: "decibeles",
		dBFS: "decibeles",
	},
	unit: {
		s: "segundo",
		ms: "milisegundo",
		min: "minuto",
		KB: "kilobyte",
		MB: "megabyte",
		GB: "gigabyte",
		"%": "por ciento",
		dB: "decibel",
		dBFS: "decibel",
	},
	punctuation: {
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
	},
	symbols: [
		[/[→⇒➜]/, "a"],
		[/←/, "desde"],
		[/≈/, "aproximadamente"],
		[/≠/, "distinto de"],
		[/≥/, "mayor o igual a"],
		[/≤/, "menor o igual a"],
		[/±/, "más o menos"],
		[/&+/, "y"],
	],
	thousands: true,
};

const ENGLISH: Phrasebook = {
	codeBlock: "Code block.",
	contracts: false,
	command: "the command",
	folder: "the folder",
	branch: "the branch",
	aCommit: "a commit",
	in: "in",
	line: "line",
	dot: "dot",
	point: "point",
	or: "or",
	approximately: "approximately",
	times: "times",
	units: {
		s: "seconds",
		ms: "milliseconds",
		min: "minutes",
		KB: "kilobytes",
		MB: "megabytes",
		GB: "gigabytes",
		"%": "percent",
		dB: "decibels",
		dBFS: "decibels",
	},
	unit: {
		s: "second",
		ms: "millisecond",
		min: "minute",
		KB: "kilobyte",
		MB: "megabyte",
		GB: "gigabyte",
		"%": "percent",
		dB: "decibel",
		dBFS: "decibel",
	},
	punctuation: {
		".": "period",
		",": "comma",
		";": "semicolon",
		":": "colon",
		"!": "exclamation mark",
		"?": "question mark",
		"~": "tilde",
		"/": "slash",
		"-": "hyphen",
		_: "underscore",
		"*": "asterisk",
		"#": "hash",
		"|": "pipe",
	},
	symbols: [
		[/[→⇒➜]/, "to"],
		[/←/, "from"],
		[/≈/, "approximately"],
		[/≠/, "not equal to"],
		[/≥/, "greater than or equal to"],
		[/≤/, "less than or equal to"],
		[/±/, "plus or minus"],
		[/&+/, "and"],
	],
	thousands: false,
};

const PHRASEBOOKS: Record<Language, Phrasebook> = { es: SPANISH, en: ENGLISH };
words = SPANISH;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const WORD = String.raw`\p{L}\p{N}_`;

/** A line wrapped whole in one emphasis (`**Qué cambió**`, `*Nota*`, `__X__`), read like a heading. */
const EMPHASIS_LINE = /^(?:\*\*(?=\S)(?:(?!\*\*).)+(?<=\S)\*\*|__(?=\S)(?:(?!__).)+(?<=\S)__|\*(?=\S)[^*]+(?<=\S)\*|_(?=\S)[^_]+(?<=\S)_)$/;

/** One line outside fences and tables, as a block; `line` is its 1-based source line. */
function lineBlock(raw: string, line: number): PlanBlock {
	let text = raw.trim();
	while (/^>\s?/.test(text)) text = text.replace(/^>\s?/, "").trim();

	if (text === "" || /^([-*_])(\s*\1){2,}$/.test(text) || /^\[[^\]]+\]:\s*\S+/.test(text)) return { role: "break", line };

	const heading = /^#{1,6}\s+(.*?)(\s+#+)?$/.exec(text);
	if (heading) return { role: "heading", source: heading[1], line };
	if (EMPHASIS_LINE.test(text)) return { role: "heading", source: text, line };

	const bullet = /^[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(text);
	if (bullet) return { role: "item", source: bullet[1], line };

	const numbered = /^(\d+)[.)]\s+(.*)$/.exec(text);
	if (numbered) return { role: "item", number: numbered[1], source: numbered[2], line };

	return { role: "paragraph", source: text, line };
}

/** One block in the words of the current phrasebook, before the per-line passes. */
function blockText(block: PlanBlock): string {
	switch (block.role) {
		case "break":
			return "";
		case "codeBlock":
			return words.codeBlock;
		case "heading":
			return closeSentence(spokenHeading(inline(block.source)));
		case "item":
			// "1:" rather than "1.", which playback would cut at, reading the number alone.
			return closeSentence(block.number === undefined ? inline(block.source) : `${block.number}: ${inline(block.source)}`);
		case "row":
			return closeSentence(
				block.cells
					.map((cell) => inline(cell))
					.filter((cell) => cell !== "")
					.join(", "),
			);
		case "paragraph":
			return inline(block.source);
	}
}

/** Every reply here closes with the English heading "Needs your decision"; a Spanish voice would mangle it. */
function spokenHeading(text: string): string {
	return words.needsYourDecision !== undefined && /^needs your decision:?$/i.test(text) ? words.needsYourDecision : text;
}

/** A table row's cells, trimmed and still in Markdown; escaped pipes stay inside their cell. */
function tableCells(raw: string): string[] {
	return raw
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());
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
			(m: string, _ticks, code: string, offset: number) =>
				`\uE002${spans.push(codeSpan(code, text.slice(0, offset), text.slice(offset + m.length))) - 1}\uE003`,
		)
		.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_m, ch: string) => `\uE000${ch.codePointAt(0)}\uE001`);
	return prose(parked)
		.replace(/\uE000(\d+)\uE001/g, (_m, code: string) => String.fromCodePoint(Number(code)))
		.replace(/\uE002(\d+)\uE003/g, (_m, index: string) => spans[Number(index)])
		.replace(/[ \t]*\uE008|[\uE006\uE007]/g, "");
}

/**
 * `before` and `after` are the text around the span, so a branch or hash in it can tell what word precedes it,
 * and in English what noun follows it ("the `/read` command").
 */
function codeSpan(code: string, before: string, after: string): string {
	// A code span holding one mark is spoken by name; a bare "." would also end a sentence in playback.
	return Object.hasOwn(words.punctuation, code.trim()) ? words.punctuation[code.trim()] : speakable(code.trim(), before, after);
}

/** IDs, symbols, emoji and technical tokens a voice stumbles on, made speakable (prose and code spans alike). */
function speakable(text: string, before = "", after = ""): string {
	const urls: string[] = [];
	let out = text.replace(/\S*:\/\/\S*/g, (url) => `\uE004${urls.push(url) - 1}\uE005`);
	out = identifierSpaces(
		out.replace(/\S+/g, (token: string, offset: number, whole: string) =>
			tokenReading(token, previousWord(before + whole.slice(0, offset)), nextWord(whole.slice(offset + token.length) + after)),
		),
	);
	out = out
		// "aproximadamente" has no gender, unlike "unos" ("las unos 400 líneas").
		.replace(/(?<![\p{L}\p{N}])~(?=\d)/gu, `${words.approximately} `)
		.replace(UNIT, (_m, number: string, unit: string) => `${number} ${(number === "1" ? words.unit : words.units)[unit]}`)
		// After the units, so "2.1 s" is "2 punto 1 segundos" and not "2 punto 1 segundo".
		.replace(DOTTED_NUMBER, dottedNumber);
	out = out.replace(
		/(?<![\p{L}\p{N}.])P(\d+)\.R(\d+)(?:\.Q(\d+))?(?![\p{L}\p{N}]|\.[\p{L}\p{N}])/gu,
		(_m, p: string, r: string, q?: string) => `P ${p}, R ${r}${q ? `, Q ${q}` : ""}`,
	);
	out = out.replace(/(\d)[ \t]*×[ \t]*(?=\d)/g, `$1 ${words.times} `);
	for (const [symbol, word] of words.symbols) out = spokenAs(out, symbol, word);
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

/** "1.1" reads as "1 punto 1"; Spanish thousands, IP addresses and hosts stay as they are. */
function dottedNumber(match: string): string {
	if (match.startsWith("\uE006") || (words.thousands && THOUSANDS.test(match))) return match;
	const groups = match.split(".");
	if (groups.length === 4 && groups.every((group) => group.length <= 3 && Number(group) <= 255)) return match;
	return groups.join(` ${words.point} `);
}

/** A unit right after a number that letters or a version dot do not precede: "2,5 s", "80%", "-16 dB". */
const UNIT = /(?<![\p{L}\p{N}_.,])(\d+(?:[.,]\d+)*)[ \t]?(dBFS|dB|ms|min|s|KB|MB|GB|%)(?![\p{L}\p{N}])/gu;
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
function tokenReading(token: string, previous: string, next: string): string {
	const [, lead, core, trail] = /^([("'“«[]*)(.*?)([)"'”»\].,;:!?]*)$/u.exec(token) ?? [];
	if (!core || /[\uE000-\uE008]/u.test(token) || !/[\p{L}\p{N}]/u.test(core)) return token;
	// English puts the noun after the token ("the `/read` command"); punctuation in between ends the phrase.
	const noun = words === ENGLISH && trail === "" ? next.toLowerCase() : "";
	const reading = classified(core, previous.toLowerCase(), noun);
	if (reading === undefined) {
		if (diagnosis && UNCLASSIFIED.test(core) && !NUMERIC.test(core)) diagnosis.diagnostics.push({ line: diagnosis.line, token: core });
		return token;
	}
	if (reading === "") return `\uE008${trail}`;
	// A dot between digits in a reading ("a punto ts, en 1.2") is the token's own; (h1) leaves it.
	return `${lead}${reading.replace(/(?<=\d)\.(?=\d)/g, "\uE009")}${trail}`;
}

/** (S12) Characters a voice reads oddly in a token no class claimed; numbers such as `1/2` or `10:30` are fine. */
const UNCLASSIFIED = /[/\\=<>|*{}$^@#+]|\.\./;
const NUMERIC = /^~?[\d.,:/]+$/;

/** `noun` is the English noun right after the token, which the reading then leaves out ("the read command"). */
function classified(core: string, previous: string, noun: string): string | undefined {
	if (previous === "rama" || previous === "branch") return nameWords(core);
	const line = /^(.+):(\d+)$/.exec(core);
	const file = line && (pathReading(line[1], previous) ?? fileName(line[1]));
	if (line && file) return `${file}, ${words.line} ${line[2]}`;
	if (BRANCH.test(core) && !/\.\p{L}+$/u.test(core)) return noun === "branch" ? nameWords(core) : `${words.branch} ${nameWords(core)}`;
	if (noun === "folder") {
		const folder = folderName(core);
		if (folder !== undefined) return folder;
	}
	return (
		alternatives(core) ??
		pathReading(core, previous) ??
		command(core, previous, noun) ??
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
	return pair[1].length <= 3 && pair[2].length <= 3 ? core : `${pair[1]} ${words.or} ${pair[2]}`;
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
	const reading = (!isFolder && fileReading(parts.at(-1) ?? "")) || (said ? name : `${words.folder} ${name}`);
	const folder = parts.length > 1 ? partName(parts[parts.length - 2]) : "";
	return folder === "" ? reading : `${reading}, ${words.in} ${folder}`;
}

/** A leading `.` is dropped and `-`/`_` become spaces: `.gentle-shell` reads as "gentle shell". */
function partName(part: string): string {
	return part.replace(/^\.+/, "").replace(/[-_]+/g, " ").trim();
}

/** `speech-text.ts` reads as "speech text punto ts"; a part without a letter-only extension is not a file. */
function fileReading(part: string): string | undefined {
	const file = /^(.*\p{L}.*)\.(\p{L}+)$/u.exec(part);
	if (!file) return undefined;
	const name = partName(file[1]).replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, ` ${words.dot} `);
	return name === "" ? undefined : `${name} ${words.dot} ${file[2]}`;
}

/** Top-level folders of a Unix system: `/tmp` is a place, not a command. */
const SYSTEM_FOLDERS = new Set(["bin", "boot", "dev", "etc", "home", "lib", "media", "mnt", "opt", "proc", "root", "run", "srv", "sys", "tmp", "usr", "var"]);

/** `/reload` reads as "el comando reload", or just "reload" right after "comando"; `/tmp` reads as "la carpeta tmp". */
function command(core: string, previous: string, noun: string): string | undefined {
	const name = /^\/(\p{L}[\p{L}\p{N}_:-]*)$/u.exec(core)?.[1]?.replace(/[-_:]+/g, " ");
	if (!name) return undefined;
	if (SYSTEM_FOLDERS.has(name)) return previous === "carpeta" || previous === "folder" ? name : `${words.folder} ${name}`;
	return previous === "comando" || previous === "command" || noun === "command" ? name : `${words.command} ${name}`;
}

/** "the `/tmp/a/b/` folder" and "the `src/` folder" read as "the b folder" and "the src folder"; files are not folders. */
function folderName(core: string): string | undefined {
	if (!PATH.test(core) || !core.includes("/")) return undefined;
	const last = core.split("/").filter((part) => part !== "").at(-1) ?? "";
	if (!core.endsWith("/") && fileReading(last)) return undefined;
	const name = partName(last);
	return /\p{L}/u.test(name) ? name : undefined;
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
	return previous === "commit" || previous === "commits" ? "" : words.aCommit;
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

/** The word right after a token, across closing emphasis or quotes and spaces, but not across punctuation. */
function nextWord(text: string): string {
	return /^[*_`"'”»]*[ \t]+[*_`"'“«]*(\p{L}+)(?![\p{L}\p{N}])/u.exec(text)?.[1] ?? "";
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

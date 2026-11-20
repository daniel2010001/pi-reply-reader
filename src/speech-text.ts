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
/**
 * (k5) The tags of the text being rendered, in the order the renderer meets them: a first run records them, and
 * `paired` then says which opening and closing tags match, for the run that is kept.
 */
let tagging: { seen: { name: string; closing: boolean }[]; paired?: boolean[]; next: number } | undefined;

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
	const previous = { words, diagnosis, tagging };
	words = PHRASEBOOKS[language];
	try {
		tagging = undefined;
		// (k5) A closing tag anywhere means a pair may span blocks: a first run finds which tags match.
		if (plan.blocks.some((block) => CLOSING_TAG.test("source" in block ? block.source : "cells" in block ? block.cells.join(" ") : ""))) {
			tagging = { seen: [], next: 0 };
			rendered(plan, language);
			tagging = { seen: [], paired: pairedTags(tagging.seen), next: 0 };
		}
		return rendered(plan, language);
	} finally {
		({ words, diagnosis, tagging } = previous);
	}
}

const CLOSING_TAG = /<\/\p{L}[\p{L}\p{N}-]*>/u;

/** (k5) Which of `seen` belong to a pair: each closing tag matches the nearest open tag of the same name before it. */
function pairedTags(seen: readonly { name: string; closing: boolean }[]): boolean[] {
	const paired = seen.map(() => false);
	const open = new Map<string, number[]>();
	seen.forEach(({ name, closing }, index) => {
		const key = name.toLowerCase();
		const stack = open.get(key) ?? [];
		open.set(key, stack);
		if (!closing) stack.push(index);
		else {
			const start = stack.pop();
			if (start !== undefined) paired[start] = paired[index] = true;
		}
	});
	return paired;
}

/** One run of the renderer over `plan`, with the current phrasebook. */
function rendered(plan: NarrationPlan, language: Language): Narration {
	diagnosis = { diagnostics: [], line: 0 };
	const lines: SpokenLine[] = [];
	for (const block of plan.blocks) {
		diagnosis.line = block.line;
		const role = block.role === "break" ? "paragraph" : block.role;
		lines.push({ text: numbersInWords(finished(blockText(block))), role });
		// A heading or bold-only line ends its section, so playback pauses as at a blank line; trim drops a last one.
		if (block.role === "heading") lines.push({ text: "", role });
	}
	const text = lines
		.map((line) => line.text)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { text, language, fragments: fragmentsOf(lines), diagnostics: diagnosis.diagnostics };
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
				/(?<![\p{L}\p{N}])([dD]e|[aA])l (el|la|un) (comando|carpeta|rama|commit|etiqueta)(?![\p{L}\p{N}])/gu,
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
	/** (i2) Before an issue or PR number: `#43`. */
	number: string;
	/** (i3) Between the keys of a combination: `Alt+R`. */
	plus: string;
	/** (i4) After a minimum version: `v1+`. */
	orLater: string;
	/** (i4) After a count: `100+`. */
	orMore: string;
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
	/** (j1) "1,234" is an English thousand; any other comma between digits is read as `comma`. */
	commaThousands: boolean;
	/** (j1) Between the digit groups of a decimal written with a comma: "1,2". */
	comma: string;
	/** (j1) A leading minus: "-16". */
	minus: string;
	/** (j1) A whole number from 0 to 999.999.999.999 in words. */
	cardinal: (n: number) => string;
	/** (j1) Spanish only: "un"/"una" by the word after a number ending in 1; (k1) feminine hundreds. */
	agreement?: { feminine: Set<string>; keepsUno: Set<string> };
	/** (k2) A time with minutes 00, after its hour: "siete en punto". */
	oClock: string;
	/** (k3) Month names, January first. */
	months: readonly string[];
	/** (k3) A date from its parts, already in words. */
	date: (day: string, month: string, year: string) => string;
	/** (k4) A glob's leading `*`: "cualquier hs punto lan". */
	any: string;
	/** (k4) A glob's trailing `/*`: "todo lo de bin". */
	everythingIn: string;
	/** (k4) Any other `*` in a glob: "lab algo". */
	something: string;
	/** (k5) A lone closing or self-closing tag by its name: "la etiqueta iframe". */
	tag: (name: string) => string;
}

const SPANISH_UNITS = "cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciséis diecisiete dieciocho diecinueve veinte veintiuno veintidós veintitrés veinticuatro veinticinco veintiséis veintisiete veintiocho veintinueve".split(" ");
const SPANISH_TENS = "  veinte treinta cuarenta cincuenta sesenta setenta ochenta noventa".split(" ");
const SPANISH_HUNDREDS = " ciento doscientos trescientos cuatrocientos quinientos seiscientos setecientos ochocientos novecientos".split(" ");

/** "veintiuno" → "veintiún", "treinta y uno" → "treinta y un": before "mil", "millones" or a noun. */
function apocope(text: string): string {
	return text.replace(/(veinti)?uno$/, (_m, twenty?: string) => (twenty ? "veintiún" : "un"));
}

function spanishBelowThousand(n: number): string {
	if (n === 100) return "cien";
	const hundreds = SPANISH_HUNDREDS[Math.floor(n / 100)];
	const rest = n % 100;
	const tens = rest < 30 ? SPANISH_UNITS[rest] : `${SPANISH_TENS[Math.floor(rest / 10)]}${rest % 10 ? ` y ${SPANISH_UNITS[rest % 10]}` : ""}`;
	return [hundreds, rest || !hundreds ? tens : ""].filter((part) => part !== "").join(" ");
}

function spanishCardinal(n: number): string {
	if (n >= 1_000_000) {
		const millions = Math.floor(n / 1_000_000);
		const rest = n % 1_000_000;
		const head = millions === 1 ? "un millón" : `${apocope(spanishCardinal(millions))} millones`;
		return rest ? `${head} ${spanishCardinal(rest)}` : head;
	}
	if (n >= 1000) {
		const thousands = Math.floor(n / 1000);
		const rest = n % 1000;
		const head = thousands === 1 ? "mil" : `${apocope(spanishBelowThousand(thousands))} mil`;
		return rest ? `${head} ${spanishBelowThousand(rest)}` : head;
	}
	return spanishBelowThousand(n);
}

const ENGLISH_UNITS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const ENGLISH_TENS = "  twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

function englishCardinal(n: number): string {
	for (const [size, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"], [100, "hundred"]] as const) {
		if (n >= size) {
			const rest = n % size;
			const head = `${englishCardinal(Math.floor(n / size))} ${name}`;
			return rest ? `${head} ${englishCardinal(rest)}` : head;
		}
	}
	return n < 20 ? ENGLISH_UNITS[n] : `${ENGLISH_TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ENGLISH_UNITS[n % 10]}` : ""}`;
}

/** (j1) Frequent feminine nouns, singular and plural: "una respuesta", "veintiuna líneas". Tunable. */
const FEMININE = new Set(
	(
		"línea respuesta pregunta sesión tarea vez hora semana página carpeta rama prueba versión lectura voz opción regla palabra cosa parte persona máquina salida entrada imagen corrida fila " +
		"líneas respuestas preguntas sesiones tareas veces horas semanas páginas carpetas ramas pruebas versiones lecturas voces opciones reglas palabras cosas partes personas máquinas salidas entradas imágenes corridas filas"
	).split(" "),
);
/** (j1) Function words a number ending in 1 keeps "uno" before: "de 1 a 5", "1 de 3". */
const KEEPS_UNO = new Set("a de del al y e o u ni en por para con sin entre hasta desde sobre contra según que es son más menos coma punto no ya se lo la el los las le está era queda sigue fue".split(" "));

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
	number: "número",
	plus: "más",
	orLater: "o superior",
	orMore: "o más",
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
	commaThousands: false,
	comma: "coma",
	minus: "menos",
	cardinal: spanishCardinal,
	agreement: { feminine: FEMININE, keepsUno: KEEPS_UNO },
	oClock: "en punto",
	months: "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre".split(" "),
	date: (day, month, year) => `${day} de ${month} de ${year}`,
	any: "cualquier",
	everythingIn: "todo lo de",
	something: "algo",
	tag: (name) => `la etiqueta ${name}`,
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
	number: "number",
	plus: "plus",
	orLater: "or later",
	orMore: "or more",
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
	commaThousands: true,
	comma: "comma",
	minus: "minus",
	cardinal: englishCardinal,
	oClock: "o'clock",
	months: "January February March April May June July August September October November December".split(" "),
	date: (day, month, year) => `${month} ${day}, ${year}`,
	any: "any",
	everythingIn: "everything in",
	something: "something",
	tag: (name) => `the ${name} tag`,
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
	const bare = text.replace(KEPT_MARKS, "");
	return bare === "" || /[.!?:;…,]$/.test(bare) ? text : `${text}.`;
}

/**
 * (j1) Text whose digits stay as written (URL hosts, technical tokens no class claimed) is held between \uE00A and
 * \uE00B from `speakable` until `numbersInWords` drops the marks.
 */
const KEPT_MARKS = /[\uE00A\uE00B]/g;

/** (j1) Kept text, or a run of digits, its groups joined by single dots or commas, with an optional leading minus. */
const DIGITS = /\uE00A[^\uE00B]*\uE00B|[-−]?\d+(?:[.,]\d+)*/gu;

/**
 * (j1) The last pass of a line: every run of digits left becomes words in the current language, except in kept text.
 * The text around it does not change, so units, numbering, IDs and the (h1) and (i4) readings keep their shape.
 */
function numbersInWords(line: string): string {
	return line.replace(DIGITS, (match: string, offset: number, whole: string) => {
		if (match.startsWith("\uE00A")) {
			// A later rule may have split a kept token into words (">=1 punto 2 punto 0"): only its technical parts stay.
			const kept = match.slice(1, -1);
			return /\s/.test(kept) ? kept.replace(/\S+/g, (part) => (UNCLASSIFIED.test(part) && !NUMERIC.test(part) ? part : numbersInWords(part))) : kept;
		}
		const before = whole.slice(0, offset);
		const after = whole.slice(offset + match.length);
		let sign = "";
		let run = match;
		if (/^[-−]/.test(run)) {
			// A hyphen right after a word or a number ("2026-10-27", "a-1") is not a minus.
			sign = /[\p{L}\p{N}_.,\-−]$/u.test(before) ? run[0] : `${words.minus} `;
			run = run.slice(1);
		}
		// Digits glued to letters are spoken apart from them: "Q5" reads "Q cinco".
		const space = (char: string) => (/\p{L}/u.test(char) ? " " : "");
		// A decimal part ("2 punto 1 segundos") keeps "uno", as a decimal run does, and so does a name such as "T1".
		const decimalPart = new RegExp(`(?:^|\\s)(?:${words.point}|${words.comma}) $`).test(before);
		const glued = sign === "" && space(before.at(-1) ?? "") !== "";
		const following = /^[ \t]+(\p{L}+)(?:[ \t]+(\p{L}+))?/u.exec(after);
		const next = following?.[1];
		// (k1) "200 mil líneas": the hundreds agree with the noun after "mil".
		const noun = next?.toLowerCase() === "mil" ? following?.[2] : next;
		const reading = digitRun(run, decimalPart || glued ? undefined : { next: next ?? "", noun });
		return `${sign === "" ? space(before.at(-1) ?? "") : ""}${sign}${reading}${space(after[0] ?? "")}`;
	});
}

/** The word right after a number, and the noun it counts (the word after "mil" when that word is "mil"). */
interface Following {
	next: string;
	noun: string | undefined;
}

/** One run of digit groups; `following` holds the words after it, which a whole number agrees with (Spanish). */
function digitRun(run: string, following: Following | undefined): string {
	const thousands = words.thousands
		? /^([1-9]\d{0,2}(?:\.\d{3})+)(?:,(\d+))?$/.exec(run)
		: words.commaThousands
			? /^([1-9]\d{0,2}(?:,\d{3})+)$/.exec(run)
			: null;
	if (thousands && !IP_ADDRESS.test(run)) {
		const whole = words.cardinal(Number(thousands[1].replace(/[.,]/g, "")));
		return thousands[2] === undefined ? agreed(whole, following) : `${whole} ${words.comma} ${digitGroup(thousands[2])}`;
	}
	if (/^\d+$/.test(run)) {
		const reading = digitGroup(run);
		return run.length > 1 && (run.startsWith("0") || run.length > 9) ? reading : agreed(reading, following);
	}
	return run
		.split(/([.,])/)
		.map((part) => (part === "." ? ` ${words.point} ` : part === "," ? ` ${words.comma} ` : digitGroup(part)))
		.join("");
}

/** Four groups of 0-255: an IP address, read group by group even when it looks like a Spanish thousand. */
const IP_ADDRESS = /^(?:(?:25[0-5]|2[0-4]\d|1?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,2})$/;

/** A group of digits: a whole number, or digit by digit when it is longer than 9 digits or starts with 0. */
function digitGroup(digits: string): string {
	if (digits.length > 9 || (digits.length > 1 && digits.startsWith("0"))) return [...digits].map((digit) => words.cardinal(Number(digit))).join(" ");
	return words.cardinal(Number(digits));
}

/**
 * "uno" becomes "un" before a word, "una" before a listed feminine noun; it stays before a function word. (k1) Before
 * a listed feminine noun, right after the number or after "mil", the hundreds below the millions are feminine too.
 */
function agreed(reading: string, following: Following | undefined): string {
	const agreement = words.agreement;
	if (!agreement || following === undefined || following.next === "") return reading;
	const feminine = following.noun !== undefined && agreement.feminine.has(following.noun.toLowerCase());
	const agreeing = feminine ? feminineHundreds(reading) : reading;
	if (!/uno$/.test(agreeing)) return agreeing;
	const word = following.next.toLowerCase();
	if (agreement.feminine.has(word)) return agreeing.replace(/uno$/, "una");
	return agreement.keepsUno.has(word) ? agreeing : apocope(agreeing);
}

/** (k1) "doscientos mil" → "doscientas mil"; "millón" and "millones" are masculine, so hundreds before them stay. */
function feminineHundreds(reading: string): string {
	const parts = reading.split(/(?<=millón |millones )/);
	const last = parts.pop() ?? "";
	return `${parts.join("")}${last.replace(/ientos(?![\p{L}])/gu, "ientas")}`;
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
		.replace(/[ \t]*\uE008/g, "")
		// (k5) The pauses around `<< text >>`, now that code spans are back in the line.
		.replace(QUOTE_OPENING, (_m, offset: number, whole: string) => {
			const before = whole.slice(0, offset).replace(KEPT_MARKS, "");
			if (before === "" || /[([{"'“«¿¡]$/u.test(before)) return "";
			return /[\p{L}\p{N}]$/u.test(before) ? ", " : " ";
		})
		.replace(QUOTE_CLOSING, (match: string, offset: number, whole: string) => {
			const after = whole.slice(offset + match.length).replace(KEPT_MARKS, "");
			if (after === "" || /^[)\]}.,;:!?…"'”»]/u.test(after)) return "";
			return /[.,;:!?…]$/u.test(whole.slice(0, offset)) ? " " : ", ";
		})
		// (j1) A host keeps its digits: its marks become the kept-text marks `numbersInWords` drops.
		.replace(/\uE006/g, "\uE00A")
		.replace(/\uE007/g, "\uE00B");
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
	out = tags(angleQuotes(out), before, after);
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
		.replace(/\uE004(\d+)\uE005/g, (_m, index: string) => `\uE00A${identifierSpaces(urls[Number(index)])}\uE00B`)
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
		if (!UNCLASSIFIED.test(core) || NUMERIC.test(core)) return token;
		if (diagnosis) diagnosis.diagnostics.push({ line: diagnosis.line, token: core });
		// (j1) Read as written, digits included.
		return `${lead}\uE00A${core}\uE00B${trail}`;
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
	const moment = clockTime(core) ?? calendarDate(core);
	if (moment !== undefined) return moment;
	const line = /^(.+):(\d+)$/.exec(core);
	const file = line && (pathReading(line[1], previous) ?? fileName(line[1]));
	if (line && file) return `${file}, ${words.line} ${line[2]}`;
	if (BRANCH.test(core) && !/\.\p{L}+$/u.test(core)) return noun === "branch" ? nameWords(core) : `${words.branch} ${nameWords(core)}`;
	if (noun === "folder") {
		const folder = folderName(core);
		if (folder !== undefined) return folder;
	}
	return (
		issueNumber(core) ??
		keyCombination(core) ??
		minimumVersion(core) ??
		alternatives(core) ??
		pathReading(core, previous) ??
		command(core, previous, noun) ??
		fileName(core) ??
		commitHash(core, previous) ??
		emphasis(core) ??
		glob(core) ??
		slashWords(core)
	);
}

/**
 * (k2) A standalone `H:MM` or `HH:MM`, optionally `:SS`, reads like a digital clock, already in words: `21:02`
 * "veintiuno cero dos", `07:30` "siete treinta", `07:00` "siete en punto". With seconds, minutes 00 read "cero cero".
 */
function clockTime(core: string): string | undefined {
	const time = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(core);
	if (!time) return undefined;
	const [, hour, minutes, seconds] = time;
	const said = words.cardinal(Number(hour));
	if (seconds === undefined && minutes === "00") return `${said} ${words.oClock}`;
	return [said, digitGroup(minutes), ...(seconds === undefined ? [] : [digitGroup(seconds)])].join(" ");
}

/** (k3) `2026-10-27` and day-first `27/10/2026`, valid only: "veintisiete de octubre de dos mil veintiséis". */
function calendarDate(core: string): string | undefined {
	const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(core);
	const dayFirst = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(core);
	const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : dayFirst ? [dayFirst[3], dayFirst[2], dayFirst[1]] : [];
	if (year === undefined || month === undefined || day === undefined) return undefined;
	const [y, m, d] = [Number(year), Number(month), Number(day)];
	// Day 0 of the next month is the last day of this one.
	if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return undefined;
	return words.date(words.cardinal(d), words.months[m - 1], words.cardinal(y));
}

/** (k5) Where the pauses around `<< text >>` go, placed by `inline` once code spans are back in the line. */
const QUOTE_OPEN = String.fromCharCode(0xe00c);
const QUOTE_CLOSE = String.fromCharCode(0xe00d);
const QUOTE_OPENING = new RegExp(`[ \\t]*${QUOTE_OPEN}[ \\t]*`, "g");
const QUOTE_CLOSING = new RegExp(`[ \\t]*${QUOTE_CLOSE}[ \\t]*`, "g");

/**
 * (k5) `<< text >>`, a format models use, reads like quotes: the marks are silent and the text has a short pause
 * around it. It needs a letter inside and a `>>` on the same line, so a shift such as `a << b` or `x << 2 >> 1`
 * keeps its reading and swallows nothing.
 */
function angleQuotes(text: string): string {
	return text.replace(
		/(?<![^\s([{"'“«])<<(?!<)[ \t]*([^<>\n]*?\p{L}[^<>\n]*?)[ \t]*>>(?![>\p{L}\p{N}_])/gu,
		(_m, inside: string) => ` ${QUOTE_OPEN} ${inside} ${QUOTE_CLOSE} `,
	);
}

/** (k5) A tag name: letters, digits and `-`, starting with a letter. */
const TAG = /<(\/?)(\p{L}[\p{L}\p{N}-]*)(\/?)>/gu;
/**
 * A tag glued to a letter, digit or `_` (`a<b>c`, `List<String>`) is not one: markup or a generic type. So is one
 * glued to a code span, URL or escape parked behind a private-use mark (`` `x`<br>`y` ``).
 */
const TAG_GLUE = /[\p{L}\p{N}_\uE000-\uE00F]/u;

/**
 * (k5) Tags, HTML or not. A pair `<name>…</name>` of the same text reads "name: " and then the content, the closing
 * tag silent; the opening tag may be glued to the content, the closing one to the content before it. A lone
 * `<name>` reads its name (`<archivo>` "archivo"); a lone `</name>` or `<name/>` reads "la etiqueta name" ("the
 * name tag"), only the name right after "etiqueta"/"tag". Lone tags glued to other text (`a<b>c`) are not tags.
 */
function tags(text: string, before: string, after: string): string {
	return text.replace(TAG, (match: string, closing: string, rawName: string, selfClosing: string, offset: number, whole: string) => {
		if (closing !== "" && selfClosing !== "") return match;
		const prior = offset === 0 ? "" : whole[offset - 1];
		const next = whole[offset + match.length] ?? "";
		const apartBefore = prior === "" || !TAG_GLUE.test(prior);
		const apartAfter = next === "" || !TAG_GLUE.test(next);
		const name = rawName.replace(/-+/g, " ");
		let paired = false;
		// An opening tag may start a pair only where a word could start, a closing one end it only where a word could end.
		if (selfClosing === "" && tagging && (closing === "" ? apartBefore : apartAfter)) {
			const index = tagging.next++;
			tagging.seen.push({ name: rawName, closing: closing !== "" });
			paired = tagging.paired?.[index] ?? false;
		}
		if (paired) return closing === "" ? `${name}:${next === "" || /\s/.test(next) ? "" : " "}` : "";
		// Alone, a tag right after another tag's `>` (`height="450"></iframe>`) is still markup, and one between `/`
		// (`/catalog/<id>`) is part of a path, whose reading gives the name.
		if (!apartBefore || !apartAfter || prior === ">" || next === "<" || prior === "/" || next === "/") return match;
		if (closing === "" && selfClosing === "") return name;
		const said = previousWord(before + whole.slice(0, offset)).toLowerCase();
		const noun = words === ENGLISH && /^\s/.test(next) ? nextWord(whole.slice(offset + match.length) + after).toLowerCase() : "";
		return said === "etiqueta" || said === "tag" || noun === "tag" ? name : words.tag(name);
	});
}

/** (k4, L128) Markdown emphasis written as code, `**negrita**` or `*nota*`, reads only its letters: "negrita". */
function emphasis(core: string): string | undefined {
	return /^(\*{1,2})(\p{L}+)\1$/u.exec(core)?.[2];
}

/**
 * (k4) A glob with a letter: a leading `*` reads "cualquier" (`*.hs.lan` "cualquier hs punto lan"), a trailing `/*`
 * "todo lo de" plus the folder (`bin/*` "todo lo de bin"), any other `*` "algo" (`lab-*` "lab algo").
 */
function glob(core: string): string | undefined {
	if (!core.includes("*") || !/^[\p{L}\p{N}._~/*-]+$/u.test(core) || !/\p{L}/u.test(core)) return undefined;
	const folder = /^(.*[^/*])\/\*+$/.exec(core)?.[1];
	if (folder !== undefined && !folder.includes("*")) return `${words.everythingIn} ${pathReading(`${folder}/`, "carpeta") ?? nameWords(folder)}`;
	if (!core.startsWith("*")) return globWords(core);
	const rest = globWords(core.replace(/^\*+/, ""));
	return rest === "" ? undefined : `${words.any} ${rest}`;
}

/** A glob's parts as words, each `*` (or `**`) as "algo": `TEST_CKAN_*` "TEST CKAN algo". */
function globWords(text: string): string {
	return text
		.split(/\*+/)
		.map((part) =>
			part
				.replace(/^[._~/-]+|[._~/-]+$/g, "")
				.replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, ` ${words.dot} `)
				.replace(/[._~/-]+/g, " "),
		)
		.join(` ${words.something} `)
		.replace(/\s+/g, " ")
		.trim();
}

const BRANCH = /^(?:feat|fix|docs|chore|refactor|test|release|origin|upstream)\/[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u;
const PATH = /^[\p{L}\p{N}._~/+-]+$/u;
/** A bare `name.<tld>` is a host, not a file. */
const HOST_ENDINGS = new Set(["com", "org", "net", "io", "dev", "lan", "app", "ai", "co"]);

/** (i2) `#43` reads as "número 43"; a heading's own `#` never gets here. */
function issueNumber(core: string): string | undefined {
	const digits = /^#(\d+)$/.exec(core)?.[1];
	return digits === undefined ? undefined : `${words.number} ${digits}`;
}

const MODIFIER = /^(?:ctrl|control|alt|shift|cmd|command|super|meta|win|option|fn)$/i;
const KEY = /^(?:[\p{L}\p{N}]|enter|tab|esc|space|delete|backspace|up|down|left|right|home|end|f(?:[1-9]|1[0-2]))$/iu;

/** (i3) `Ctrl+Shift+P` reads as "Control más Shift más P": modifiers joined by `+` to one key. */
function keyCombination(core: string): string | undefined {
	const keys = core.split("+");
	const key = keys.pop() ?? "";
	if (keys.length === 0 || !keys.every((name) => MODIFIER.test(name)) || !KEY.test(key)) return undefined;
	return [...keys.map((name) => (/^ctrl$/i.test(name) ? "Control" : name)), key].join(` ${words.plus} `);
}

/**
 * (i4) `v2.0+` reads as "v2 punto 0 o superior". Without a `v`, a whole number (`100+`, or a Spanish thousand such
 * as `6.000+`) is a count: "100 o más".
 */
function minimumVersion(core: string): string | undefined {
	const version = /^(v?)(\d+(?:\.\d+)*)\+$/.exec(core);
	if (!version) return undefined;
	const [, v, number] = version;
	if (v === "" && (!number.includes(".") || (words.thousands && THOUSANDS.test(number)))) return `${number} ${words.orMore}`;
	return `${v}${dottedNumber(number)} ${words.orLater}`;
}

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
 * left to `command`, `1/2` to the numbers. (i1) A relative `src/` is a folder too, and a last part starting with
 * a dot (`ckan-docker/.prettierrc.json`) reads like any other; with no extension and a folder before it
 * (`ckan-docker/.gitignore`) it is a file named without the dot: "gitignore, en ckan docker".
 */
function pathReading(core: string, previous: string): string | undefined {
	if (!PATH.test(core)) return undefined;
	const root = /^(?:~|\.{1,2})?\//.exec(core)?.[0] ?? "";
	const parts = core.slice(root.length).split("/").filter((part) => part !== "");
	const isFolder = core.endsWith("/");
	const bareFolder = root === "" && parts.length === 1 && isFolder && /\p{L}/u.test(parts[0]);
	if (bareFolder) return previous === "carpeta" || previous === "folder" ? partName(parts[0]) : `${words.folder} ${partName(parts[0])}`;
	if (root === "/" ? parts.length < 2 && !isFolder : root === "" && parts.length < 2) return undefined;
	if (root === "" && !/\p{L}\/\.?[\p{L}\p{N}]|[\p{L}\p{N}]\/\.?\p{L}/u.test(core)) return undefined;
	const name = partName(parts.at(-1) ?? "");
	if (name === "") return undefined;
	const said = previous === "carpeta" || previous === "folder";
	const last = parts.at(-1) ?? "";
	const dotFile = !isFolder && parts.length > 1 && last.startsWith(".") ? name : undefined;
	const reading = (!isFolder && fileReading(last)) || dotFile || (said ? name : `${words.folder} ${name}`);
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

/** Other paths, such as `@scope/pkg` or `/a/<id>/b`, keep (d)'s reading: their parts as words. */
function slashWords(core: string): string | undefined {
	if (!/^(?:~|\.{1,2})?\//.test(core) && !/\p{L}\/[\p{L}\p{N}]|[\p{L}\p{N}]\/\p{L}/u.test(core)) return undefined;
	const parts = core.split("/").map((part) => part.replace(/^[~.]+/, "")).filter((part) => part !== "");
	// (k5) A placeholder in a path reads by its name: `/catalog/download/<id>` "catalog download id".
	return parts
		.join(" ")
		.replace(/<(\p{L}[\p{L}\p{N}-]*)>/gu, "$1")
		.replace(/(?<=[\p{L}\p{N}])[-_]+(?=[\p{L}\p{N}])/gu, " ");
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

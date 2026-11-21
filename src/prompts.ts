/**
 * What auto-read says when the agent blocks on the human (S18, T43): the questions of an `ask_user_question` or
 * `ask_user_choice` call with their option labels, a command confirmation by its program name, or another dialog's
 * title. Each is Markdown in the words of one language, cleaned for speech like any reply.
 */
import type { Language } from "./speech-text.ts";

/** The tools whose calls ask the human questions with options. */
export const QUESTION_TOOLS = new Set(["ask_user_question", "ask_user_choice"]);

const WORDS: Record<Language, { question: string; of: string; options: string; command: string }> = {
	es: { question: "Pregunta", of: "de", options: "Opciones", command: "Confirmación de comando" },
	en: { question: "Question", of: "of", options: "Options", command: "Command confirmation" },
};

/** One question and its option labels, as given in the call's args. */
export interface AskedQuestion {
	question: string;
	labels: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** One line of text, its whitespace runs (line breaks too) made single spaces. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The labels of an options list; undefined when it is no list or any option has no text label. */
function labelsOf(options: unknown): string[] | undefined {
	if (options === undefined) return [];
	if (!Array.isArray(options)) return undefined;
	const labels: string[] = [];
	for (const option of options) {
		if (!isRecord(option) || typeof option.label !== "string" || !oneLine(option.label)) return undefined;
		labels.push(oneLine(option.label));
	}
	return labels;
}

function questionOf(value: unknown): AskedQuestion | undefined {
	if (!isRecord(value) || typeof value.question !== "string" || !oneLine(value.question)) return undefined;
	const labels = labelsOf(value.options);
	return labels && { question: oneLine(value.question), labels };
}

/**
 * The questions of an ask_user_* call, from its args: ask_user_question `{ questions: [{ question, options: [{ label }] }] }`,
 * ask_user_choice `{ question, options: [{ label }] }`. Undefined for any other tool or malformed args (then nothing is read).
 */
export function askedQuestions(toolName: string, args: unknown): AskedQuestion[] | undefined {
	if (toolName === "ask_user_choice") {
		const question = questionOf(args);
		return question && [question];
	}
	if (toolName !== "ask_user_question" || !isRecord(args) || !Array.isArray(args.questions) || args.questions.length === 0) return undefined;
	const questions: AskedQuestion[] = [];
	for (const value of args.questions) {
		const question = questionOf(value);
		if (!question) return undefined;
		questions.push(question);
	}
	return questions;
}

/** What an assistant message wrote and the tool calls it made (S18 Context, T48). */
export interface WrittenCalls {
	/** Its text blocks joined with a blank line, trimmed; "" when it wrote nothing (thinking is never text). */
	text: string;
	/** The IDs of its tool calls. */
	calls: string[];
}

/**
 * The text an assistant message wrote before its tool calls, with the calls' IDs, from the message itself (as
 * `message_end` carries it). Undefined for any other message.
 */
export function writtenCalls(message: unknown): WrittenCalls | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const texts: string[] = [];
	const calls: string[] = [];
	for (const block of message.content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
		else if (block.type === "toolCall" && typeof block.id === "string") calls.push(block.id);
	}
	return { text: texts.join("\n\n").trim(), calls };
}

/** A sentence's end: "." added unless it already ends in `. ? ! …`; a final `:` or `;` becomes ".". */
const closed = (text: string): string => (/[.?!…]$/.test(text) ? text : `${text.replace(/[:;,]+$/, "")}.`);

/**
 * "Pregunta 1 de 2: ¿Cómo suena? Opciones: 1, Bien; 2, Mal." one line per question ("Pregunta: …" for a single one),
 * labels only; the cleanup then reads the numbers in words ("uno, Bien").
 */
export function questionsMarkdown(questions: readonly AskedQuestion[], language: Language): string {
	const words = WORDS[language];
	return questions
		.map(({ question, labels }, index) => {
			const head = questions.length === 1 ? words.question : `${words.question} ${index + 1} ${words.of} ${questions.length}`;
			const options = labels.map((label, n) => `${n + 1}, ${label.replace(/[.;,:]+$/, "")}`).join("; ");
			return `${head}: ${closed(question)}${options ? ` ${words.options}: ${options}.` : ""}`;
		})
		.join("\n");
}

/** An environment assignment before a command (`FOO=1`, `A="b c"`). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;

/**
 * The program a shell command runs, never its arguments: the first word after any `NAME=value` assignments and a
 * leading `sudo` (or `env`) without options, without its directory (`/usr/bin/npm` → "npm"). Undefined when there is none.
 */
export function commandProgram(command: string): string | undefined {
	let rest = command.trim();
	for (;;) {
		const assignment = ASSIGNMENT.exec(rest);
		if (assignment) {
			rest = rest.slice(assignment[0].length);
			continue;
		}
		const wrapper = /^(?:sudo|env)\s+(?!-)/.exec(rest);
		if (wrapper) {
			rest = rest.slice(wrapper[0].length);
			continue;
		}
		break;
	}
	const first = /^["']?([^\s"';|&()<>]+)/.exec(rest)?.[1];
	const program = first?.split("/").filter(Boolean).at(-1);
	return program && /\p{L}/u.test(program) ? program : undefined;
}

/** "Confirmación de comando: git." / "Command confirmation: git."; without a program, just the words. */
export function commandMarkdown(program: string | undefined, language: Language): string {
	const words = WORDS[language].command;
	// As inline code, so a name's own `_` or `*` is not read as emphasis.
	return program ? `${words}: \`${program}\`.` : `${words}.`;
}

/** A dialog's title as one line, or undefined when it has none. */
export function dialogTitle(title: unknown): string | undefined {
	return typeof title === "string" && oneLine(title) ? oneLine(title) : undefined;
}

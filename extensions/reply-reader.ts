import { readFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, SelectList } from "@earendil-works/pi-tui";
import { createAutoQueue, type StartResult } from "../src/auto-queue.ts";
import { loadOutputs, type Output } from "../src/outputs.ts";
import { type Reading, type SherpaTts, startReading } from "../src/playback.ts";
import { playerTimeoutMs, reapOrphans } from "../src/player.ts";
import { questionsSection } from "../src/questions.ts";
import { askedQuestions, commandMarkdown, commandProgram, dialogTitle, QUESTION_TOOLS, questionsMarkdown } from "../src/prompts.ts";
import { isPing, parseReadRequest, READER_EVENTS, READER_EVENTS_VERSION } from "../src/reader-events.ts";
import { type Claim, openReadingLock } from "../src/reading-lock.ts";
import { findReply, latestReply, listReplies } from "../src/replies.ts";
import { sectionFrom } from "../src/sections.ts";
import { formatSpeed, loadSpeed, parseSpeed, SPEED_CHOICES, SPEED_HINT, saveSpeed } from "../src/settings.ts";
import { announcement, detectLanguage, type Language, languageOfWords, speechNarration } from "../src/speech-text.ts";
import { downloadVoice, findVoice, SPEAKERS, type SpeakerName, type Voice } from "../src/voice.ts";

const STATUS = "reply-reader";
const ASK_OUTPUT = "Where should readings sound?";
const ASK_SPEAKER = "Which voice should read?";
const ASK_SPEED = "Which speed should readings use?";
const SPEAKER_NAMES = Object.keys(SPEAKERS) as SpeakerName[];
/** An argument naming a Markdown file rather than a reply (S6). */
const MARKDOWN_FILE = /\.(md|markdown)$/i;
/**
 * How often a reading checks whether a newer one, or /read-stop, in another session took over (T21), and how often
 * a waiting auto-read checks whether the machine is free (T32).
 */
const WATCH_MS = 250;
/** What auto-read reads at the end of each agent turn (S8). */
type AutoMode = "off" | "full" | "questions";
const AUTO_CHOICES = [
	{ value: "on", description: "read each new reply in full" },
	{ value: "questions", description: 'read only its closing "Needs your decision" section' },
	{ value: "off", description: "read nothing by itself" },
];
const AUTO_MESSAGES: Record<AutoMode, string> = {
	full: "Auto-read on: full replies.",
	questions: "Auto-read on: questions only.",
	off: "Auto-read off.",
};
/** Asked when a manual /read or a read request comes while something plays (S8 Ask before cutting, T33). */
const ASK_CUT = "Something is being read.";
const CUT_NOW = "Stop it and read now";
const CUT_AFTER = "Read after it";
const CUT_CHOICES = [CUT_NOW, CUT_AFTER];
/** Just the question, centred over whatever is open (pi-reply-thread's Alt+R view is a capturing overlay too). */
const CUT_OVERLAY = { anchor: "center", width: 48 } as const;
/** Seconds of silence before a reading that waited in the line, which then says which it is (S14). */
const GAP_SECONDS = 1.5;

/** The part of Pi's theme the question uses. */
interface QuestionTheme {
	fg(color: "accent" | "border" | "dim" | "muted", text: string): string;
	bold(text: string): string;
}

/**
 * The "Something is being read." question as a small overlay of its own: a plain `ctx.ui.select` is drawn in the
 * editor area, under any overlay open at the time (Alt+R), where it takes the keys unseen. Enter picks, Esc (or
 * Ctrl+C) dismisses with undefined.
 */
function cutQuestion(theme: QuestionTheme, done: (choice: string | undefined) => void): Component {
	const list = new SelectList(
		CUT_CHOICES.map((value) => ({ value, label: value })),
		CUT_CHOICES.length,
		{
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("dim", text),
		},
	);
	list.onSelect = (item) => done(item.value);
	list.onCancel = () => done(undefined);
	return {
		render: (width) => {
			const border = theme.fg("border", "─".repeat(Math.max(1, width)));
			const inner = Math.max(1, width - 1);
			return [
				border,
				` ${theme.fg("accent", theme.bold(ASK_CUT))}`,
				"",
				...list.render(inner).map((line) => ` ${line}`),
				"",
				` ${theme.fg("dim", "↑↓ navigate  enter select  esc cancel")}`,
				border,
			];
		},
		handleInput: (data) => list.handleInput(data),
		invalidate: () => list.invalidate(),
	};
}

/** Why a Markdown file could not be read, in the user's words. */
function readProblem(error: NodeJS.ErrnoException): string {
	if (error.code === "ENOENT") return "file not found";
	if (error.code === "EISDIR") return "it is a folder";
	if (error.code === "EACCES" || error.code === "EPERM") return "permission denied";
	return error.message;
}

/**
 * Reads replies aloud on request only (S1): `/read` speaks the latest reply or one by ID, a new reading,
 * Esc or `/read-stop` stops the one playing, `/read-output` picks where it sounds (S4) and `/read-voice` picks the male
 * or female voice (S3), `/read-speed` the voice speed, saved in settings.json (S3). `/read <file.md>` reads a Markdown file the same way (S6). Nothing plays by itself.
 * One reading per machine (S1, T21): through `$XDG_RUNTIME_DIR/pi-reply-reader/`, a new reading in any session
 * stops the one playing in another, `/read-stop` stops it too, and the session stopped that way just clears its footer.
 * `/read <target>#<section>` reads only the section under a matching heading, or on to the end with `rest` (S9). `/read-auto` (S8) reads each new reply, or only its
 * "Needs your decision" section, as soon as it is stored, each once and in order (T42); it is off at every session start. Auto-read never
 * interrupts (S8 Queue, T32): a reply due while a reading plays here or in another session waits, in order, and is read
 * once the machine is free; an explicit /read (or read request), /read-stop or Esc drops every reply waiting on the
 * machine, and /read-auto off or the session's end drops this session's. A reading that waited in this line starts after
 * 1.5 s of silence by saying which reply or file it is, and the footer counts what waits (S14, T38).
 * Ask before cutting (S8, T33): a manual /read or read request while a reading plays anywhere asks "Something is being
 * read.": "Stop it and read now" (the above), "Read after it" (it waits like an auto-read, after this session's waiting
 * replies, and explicit actions drop it), or dismissed (nothing changes). Without a UI, or with nothing playing, it reads.
 * An answer given after the session ended or restarted is dropped.
 * Blocking prompts (S18, T43): with auto-read on (in full or questions only), an ask_user_question / ask_user_choice
 * call reads its questions with their option labels, a confirm raised while a bash call is pending reads "Confirmación
 * de comando: <program>", and any other dialog its title; each joins the line, and is dropped (stopped if playing)
 * once answered (ui_prompt_end, or the tool's end). The reader's own questions are never read.
 * Other extensions (pi-reply-thread's Alt+R view) reach it over `pi.events` (S10, src/reader-events.ts): a ping is
 * answered with ready, ready is also sent at each session start, and a read request reads its text like `/read`.
 */
export function createReplyReader(
	deps: { env?: NodeJS.ProcessEnv; hostname?: string; loadSherpa?: (voice: Voice) => Promise<SherpaTts> } = {},
) {
	const env = deps.env ?? process.env;
	const hostname = deps.hostname ?? osHostname();

	return (pi: ExtensionAPI): void => {
		let current:
			| {
					reading: Reading;
					ctx: ExtensionContext;
					claim?: Claim;
					watch?: ReturnType<typeof setInterval>;
					/** What the footer names, and where it sounds. */
					name: string;
					output: string;
					/** The footer last shown for it. */
					shown?: string;
					/** A blocking prompt's reading (S18): its answer stops it. */
					prompt?: string;
			  }
			| undefined;
		/** The output chosen in this session, by name; asked on the first reading. */
		let chosen: string | undefined;
		/** The voice for the next reading in this session (S3: male unless changed). */
		let speaker: SpeakerName = "male";
		/** Whether this session's first reading already reported problems in outputs.json. */
		let warned = false;
		/** A speed set with /read-speed in this session; otherwise each reading uses the saved one. */
		let sessionSpeed: number | undefined;
		/** Whether this session already reported a problem in settings.json. */
		let speedWarned = false;
		let unsubscribe: (() => void) | undefined;
		/** This session's auto-read mode (S8: off at session start). */
		let auto: AutoMode = "off";
		/**
		 * The entry IDs of the replies auto-read already queued or must never read (S8 Timing, T42): those on the branch
		 * when auto-read was turned on or the branch changed under it. Every other final reply is queued once.
		 */
		let seen = new Set<string>();
		/** The context of the latest session_start or command; bus events carry none (S10). Unset outside a session. */
		let latest: ExtensionContext | undefined;
		/** Ends this session's subscriptions on `pi.events`. */
		let unsubscribeEvents: (() => void) | undefined;

		/** How many "Something is being read." questions are open; Esc belongs to them meanwhile. */
		let asking = 0;
		/** Counts session starts and ends: an answer given after the session it was asked in ended or restarted is dropped. */
		let generation = 0;
		/** How many of the reader's own prompts (output, voice, speed, download confirm, the cut question) are open (S18). */
		let ownPrompts = 0;
		/** Tool calls started and not yet ended, in start order (S18): an ask_user_* call, or the bash a confirm is about. */
		const pending = new Map<string, { toolName: string; args: unknown }>();
		/** The prompt readings the open ui_prompt span answers when it ends (S18). */
		let spanPrompts: string[] = [];
		/** The keys of the prompt readings queued and not yet answered (S18). */
		const prompts = new Set<string>();
		/** Numbers dialogs, so each gets its own prompt key. */
		let dialogs = 0;

		/**
		 * A reply due for auto-read, or a manual request answered "Read after it" (T33), with the machine's waiting mark
		 * when it was queued (S8 Queue). `name` and `label` are as for readAloud.
		 */
		interface Waiting {
			ctx: ExtensionContext;
			name: string;
			label: string;
			markdown: string;
			language: Language | undefined;
			mark: string | undefined;
			manual?: true;
			/** A Markdown file rather than a reply: announced by its name (S14). */
			file?: true;
			/** A blocking prompt (S18): the key its answer drops it by. It says what it is, so it gets no announcement. */
			prompt?: string;
		}
		/** Whether a reading plays (or is starting) in this session or anywhere on the machine. */
		const playing = (): boolean => current !== undefined || (openReadingLock(env)?.busy() ?? false);
		/** This session's waiting auto-reads; without a usable XDG_RUNTIME_DIR it only waits for this session's readings. */
		const queue = createAutoQueue<Waiting>({
			busy: playing,
			start: (item, still, waited) =>
				readAloud(item.ctx, item.name, item.label, item.markdown, item.language, {
					mark: item.mark,
					still,
					announce: waited ? (item.prompt ? "prompt" : item.file ? "file" : "reply") : undefined,
					prompt: item.prompt,
				}).catch((error: Error) => {
					item.ctx.ui.notify(error.message, "error");
					return "done" as const;
				}),
			retryMs: WATCH_MS,
		});

		/** Runs one of the reader's own prompts; a ui_prompt_start meanwhile is the reader's and is not read (S18). */
		const own = async <T>(prompt: () => Promise<T>): Promise<T> => {
			ownPrompts++;
			try {
				return await prompt();
			} finally {
				ownPrompts--;
			}
		};

		/** Registers a command whose context becomes the one bus events read with. */
		const command = (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]): void =>
			pi.registerCommand(name, {
				...options,
				handler: (args, ctx) => {
					latest = ctx;
					return options.handler(args, ctx);
				},
			});

		/**
		 * Shows this session's reading in the footer, with how many readings wait in this session's line (S14):
		 * `Reading P12.R2 on local · 2 waiting · Esc stops`. Shown again only when it changed.
		 */
		const footer = (): void => {
			if (!current) return;
			const waiting = queue.size;
			const text = `Reading ${current.name} on ${current.output} · ${waiting > 0 ? `${waiting} waiting · ` : ""}Esc stops`;
			if (text === current.shown) return;
			current.shown = text;
			current.ctx.ui.setStatus(STATUS, text);
		};

		/** Ends this session's reading and clears its footer; another session's reading is left alone. */
		const stop = (): void => {
			if (!current) return;
			const { reading, ctx, claim, watch } = current;
			current = undefined;
			clearInterval(watch);
			reading.stop();
			claim?.release();
			ctx.ui.setStatus(STATUS, undefined);
			// A reply waiting for this reading may start now.
			queue.kick();
		};

		/** All outputs, telling the user about any entry of outputs.json that was skipped. */
		const outputs = (ctx: ExtensionContext): Output[] => {
			const loaded = loadOutputs(env, hostname);
			for (const problem of loaded.problems) ctx.ui.notify(problem, "warning");
			return loaded.outputs;
		};

		const askOutput = async (ctx: ExtensionContext, list: Output[]): Promise<Output | undefined> => {
			if (!ctx.hasUI) return undefined;
			const label = await own(() => ctx.ui.select(ASK_OUTPUT, list.map((output) => output.label)));
			const output = list.find((candidate) => candidate.label === label);
			if (output) chosen = output.name;
			return output;
		};

		const outputForReading = async (ctx: ExtensionContext): Promise<Output | undefined> => {
			// A typo in outputs.json must not silently send the reading to local; say so once per session.
			const list = warned ? loadOutputs(env, hostname).outputs : outputs(ctx);
			warned = true;
			const remembered = list.find((output) => output.name === chosen);
			if (remembered) return remembered;
			if (list.length === 1) return list[0];
			return askOutput(ctx, list);
		};

		/** The speed for a new reading: this session's choice, else the saved one, warning once about a bad file. */
		const speedForReading = (ctx: ExtensionContext): number => {
			if (sessionSpeed !== undefined) return sessionSpeed;
			const { speed, problem } = loadSpeed(env);
			if (problem && !speedWarned) ctx.ui.notify(problem, "warning");
			if (problem) speedWarned = true;
			return speed;
		};

		/**
		 * Reads Markdown aloud: the voice (download confirm), the output (asked on first use), the speed and voice of this
		 * session, the footer, Esc, /read-stop and one reading per machine. Used by /read, read requests and auto-read.
		 * `name` is what the footer names, `label` what the "nothing to read" message names.
		 * Explicit (no `auto`): stops the reading playing and drops every waiting auto-read on the machine. Auto: starts
		 * only when nothing plays and its reply was not dropped (`still`, the waiting mark), else answers "busy" or "done".
		 * `announce` (a reading that waited in the line, S14): it starts after GAP_SECONDS of silence by saying which it is;
		 * a blocking prompt (S18) already says what it is, so it gets the silence only. `prompt` is its key.
		 */
		const readAloud = async (
			ctx: ExtensionContext,
			name: string,
			label: string,
			markdown: string,
			language?: Language,
			auto?: { mark: string | undefined; still: () => boolean; announce?: "reply" | "file" | "prompt"; prompt?: string },
		): Promise<StartResult> => {
			const narration = speechNarration(markdown, language);
			if (!narration.text) {
				ctx.ui.notify(`${label} has nothing to read.`, "info");
				return "done";
			}

			let voice = findVoice(env);
			if (!voice) {
				try {
					voice = await downloadVoice({
						env,
						confirm: async (message) => ctx.hasUI && own(() => ctx.ui.confirm("Reply reader voice", message)),
					});
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
					return "done";
				}
				if (!voice) {
					ctx.ui.notify("Reading cancelled: the voice was not downloaded.", "info");
					return "done";
				}
			}

			const output = await outputForReading(ctx);
			if (!output) {
				ctx.ui.notify("Reading cancelled: no output chosen.", "info");
				return "done";
			}

			// Without a usable XDG_RUNTIME_DIR there is no claim: readings and the queue only see this session's.
			const lock = openReadingLock(env);
			let claim: Claim | undefined;
			if (auto) {
				// Dropped while asking (an explicit action, /read-auto off, the session's end): nothing plays.
				if (!auto.still()) return "done";
				if (current) return "busy";
				const taken = lock?.claimIfFree(auto.mark);
				if (taken === "dropped") return "done";
				if (taken === "busy") return "busy";
				claim = taken;
			} else {
				queue.clear();
				stop();
				claim = lock?.claim({ dropWaiting: true });
			}
			const speed = speedForReading(ctx);
			// An invalid REPLY_READER_PLAYER_TIMEOUT is reported once per process and the default used (S13 f).
			const timeoutMs = playerTimeoutMs(env, (message) => ctx.ui.notify(message, "warning"));
			/** Stopped by another session: no message, just the footer. */
			const stoppedElsewhere = (): void => {
				if (current?.reading === reading) stop();
			};
			const reading = startReading({
				voice,
				speaker: SPEAKERS[speaker],
				fragments:
					auto?.announce && auto.announce !== "prompt"
						? [...announcement(auto.announce, name, narration.language), ...narration.fragments]
						: narration.fragments,
				leadSilence: auto?.announce ? GAP_SECONDS : undefined,
				output,
				env,
				loadSherpa: deps.loadSherpa,
				speed,
				timeoutMs,
				onPlayer: (pid) => {
					if (claim && !claim.setPlayer(pid)) stoppedElsewhere();
				},
			});
			const watch = claim
				? setInterval(() => {
						if (claim.lost()) stoppedElsewhere();
					}, WATCH_MS)
				: undefined;
			watch?.unref();
			current = { reading, ctx, claim, watch, name, output: output.name, prompt: auto?.prompt };
			footer();
			reading.done
				.catch((error: Error) => {
					// A player killed by a newer reading or /read-stop elsewhere fails; that is not an error here.
					if (current?.reading === reading && !claim?.lost()) ctx.ui.notify(error.message, "error");
				})
				.finally(() => {
					if (current?.reading !== reading) return;
					stop();
				});
			return "done";
		};

		/**
		 * Asks "Something is being read." (T33): as an overlay of its own in Pi's TUI, so it shows above another overlay
		 * (Alt+R); elsewhere (RPC, a host without overlays) through ctx.ui.select. Undefined when dismissed.
		 */
		const askCut = async (ctx: ExtensionContext): Promise<"now" | "after" | undefined> => {
			asking++;
			ownPrompts++;
			try {
				const choice =
					ctx.mode === "tui" && typeof ctx.ui.custom === "function"
						? await ctx.ui.custom<string | undefined>((_tui, theme, _keybindings, done) => cutQuestion(theme, done), {
								overlay: true,
								overlayOptions: CUT_OVERLAY,
							})
						: await ctx.ui.select(ASK_CUT, CUT_CHOICES);
				return choice === CUT_NOW ? "now" : choice === CUT_AFTER ? "after" : undefined;
			} finally {
				asking--;
				ownPrompts--;
			}
		};

		/**
		 * A manual /read or a read request (S8 Ask before cutting): with a UI and a reading playing anywhere, asks first.
		 * The answer is acted on as things are then: "Read after it" joins the line, which starts it at once if the
		 * reading ended meanwhile; "Stop it and read now" stops whatever plays by then.
		 */
		const readRequested = async (
			ctx: ExtensionContext,
			name: string,
			label: string,
			markdown: string,
			language?: Language,
			file?: true,
		): Promise<void> => {
			if (ctx.hasUI && playing() && speechNarration(markdown, language).text) {
				const asked = generation;
				const answer = await askCut(ctx);
				// The session ended or restarted while the question was open: nothing plays in it, no message.
				if (!answer || generation !== asked) return;
				if (answer === "after") {
					queue.push({ ctx, name, label, markdown, language, mark: openReadingLock(env)?.waitingMark(), manual: true, file });
					footer();
					return;
				}
			}
			await readAloud(ctx, name, label, markdown, language);
		};

		command("read", {
			description:
				"Read a reply aloud: the latest, or one by ID (P12.R1); or a Markdown file (notes.md); add #section for one section (notes.md#install, #usage), then rest to read on to the end",
			handler: async (args, ctx) => {
				let wanted = args.trim();
				/** The section to read (S9); a whole argument that is a Markdown path keeps any `#` in its name. */
				let section: string | undefined;
				/** `#section rest` reads from that heading to the end instead of that section only. */
				let rest = false;
				const hash = wanted.indexOf("#");
				if (hash !== -1 && !MARKDOWN_FILE.test(wanted)) {
					section = wanted.slice(hash + 1).trim();
					wanted = wanted.slice(0, hash).trim();
					const words = /^(.*\S)\s+rest$/.exec(section);
					if (words) {
						section = words[1];
						rest = true;
					}
				}
				/** What the status line names: the reply ID or the file name. */
				let name: string;
				/** What the "nothing to read" message names: the reply ID or the path as given. */
				let label: string;
				let markdown: string;
				const file = MARKDOWN_FILE.test(wanted) ? (true as const) : undefined;
				if (file) {
					const path = wanted.startsWith("~/") ? resolve(env.HOME || homedir(), wanted.slice(2)) : resolve(ctx.cwd, wanted);
					try {
						markdown = readFileSync(path, "utf8");
					} catch (error) {
						ctx.ui.notify(`Cannot read "${wanted}": ${readProblem(error as NodeJS.ErrnoException)}.`, "warning");
						return;
					}
					name = basename(path);
					label = wanted;
				} else {
					const replies = listReplies(ctx.sessionManager.getBranch());
					const reply = wanted ? findReply(replies, wanted) : latestReply(replies);
					if (!reply) {
						ctx.ui.notify(wanted ? `No reply matches "${wanted}".` : "There is no reply to read yet.", "warning");
						return;
					}
					name = reply.id;
					label = reply.id;
					markdown = reply.text;
				}
				let language: Language | undefined;
				if (section) {
					// The section reads in the language of the whole file or reply (S7), not its own few words.
					language = detectLanguage(markdown);
					const from = sectionFrom(markdown, section, { rest });
					if (from === undefined) {
						ctx.ui.notify(`No section "${section}" in ${label}.`, "warning");
						return;
					}
					markdown = from;
				}
				await readRequested(ctx, name, label, markdown, language, file);
			},
		});

		command("read-stop", {
			description: "Stop the reading playing, in this or another Pi session (Esc or a new /read stop it too)",
			handler: async (_args, ctx) => {
				const here = current !== undefined;
				queue.clear();
				stop();
				// Also drops every auto-read waiting on the machine (S8).
				const elsewhere = openReadingLock(env)?.stopOthers() ?? false;
				ctx.ui.notify(here || elsewhere ? "Reading stopped." : "Nothing is being read.", "info");
			},
		});

		command("read-output", {
			description: "Choose where readings sound: local or an output from outputs.json",
			getArgumentCompletions: (prefix) =>
				loadOutputs(env, hostname)
					.outputs.filter((output) => output.name.startsWith(prefix.trim()))
					.map((output) => ({ value: output.name, label: output.name, description: output.pulseServer ?? `this machine (${hostname})` })),
			handler: async (args, ctx) => {
				const list = outputs(ctx);
				const name = args.trim();
				let output: Output | undefined;
				if (name) {
					output = list.find((candidate) => candidate.name === name);
					if (!output) {
						ctx.ui.notify(`No output named "${name}". Outputs: ${list.map((o) => o.name).join(", ")}.`, "warning");
						return;
					}
					chosen = output.name;
				} else {
					output = await askOutput(ctx, list);
					if (!output) return;
				}
				ctx.ui.notify(`Readings will sound on ${output.label}.`, "info");
			},
		});

		command("read-voice", {
			description: "Choose the voice for the next readings: male (default) or female",
			getArgumentCompletions: (prefix) =>
				SPEAKER_NAMES.filter((name) => name.startsWith(prefix.trim())).map((name) => ({
					value: name,
					label: name,
					description: `Supertonic 3, speaker ${SPEAKERS[name].sid}`,
				})),
			handler: async (args, ctx) => {
				const name = args.trim();
				let picked: string | undefined = name;
				if (!name) {
					if (!ctx.hasUI) return;
					picked = await own(() => ctx.ui.select(ASK_SPEAKER, SPEAKER_NAMES));
					if (!picked) return;
				}
				if (!SPEAKER_NAMES.includes(picked as SpeakerName)) {
					ctx.ui.notify(`No voice named "${name}". Voices: ${SPEAKER_NAMES.join(", ")}.`, "warning");
					return;
				}
				speaker = picked as SpeakerName;
				ctx.ui.notify(`Readings will use the ${speaker} voice.`, "info");
			},
		});

		command("read-speed", {
			description: "Choose the voice speed for the next readings, 0.5 to 2.0 (default 1.1); saved for later sessions",
			getArgumentCompletions: (prefix) =>
				SPEED_CHOICES.filter((choice) => choice.startsWith(prefix.trim())).map((choice) => ({ value: choice, label: choice })),
			handler: async (args, ctx) => {
				let text = args.trim();
				if (!text) {
					if (!ctx.hasUI) return;
					const picked = await own(() => ctx.ui.select(ASK_SPEED, SPEED_CHOICES));
					if (!picked) return;
					text = picked;
				}
				const speed = parseSpeed(text);
				if (speed === undefined) {
					ctx.ui.notify(SPEED_HINT, "warning");
					return;
				}
				sessionSpeed = speed;
				try {
					saveSpeed(env, speed);
				} catch (error) {
					ctx.ui.notify(`Readings will use speed ${formatSpeed(speed)} in this session, but ${(error as Error).message}.`, "warning");
					return;
				}
				ctx.ui.notify(`Readings will use speed ${formatSpeed(speed)}.`, "info");
			},
		});

		command("read-auto", {
			description:
				'Read each new reply aloud as soon as it is written, and each prompt that waits for you, in this session: on (in full), questions (only "Needs your decision"), off; no argument toggles',
			getArgumentCompletions: (prefix) =>
				AUTO_CHOICES.filter((choice) => choice.value.startsWith(prefix.trim())).map((choice) => ({ ...choice, label: choice.value })),
			handler: async (args, ctx) => {
				const wanted = args.trim();
				const modes: Record<string, AutoMode> = { on: "full", questions: "questions", off: "off", "": auto === "off" ? "full" : "off" };
				if (!Object.hasOwn(modes, wanted)) {
					ctx.ui.notify("Use /read-auto on, questions or off.", "warning");
					return;
				}
				// Turned on: what is already on the branch is never read (S8: no reply of earlier turns).
				if (auto === "off" && modes[wanted] !== "off") seen = replyIds(ctx);
				auto = modes[wanted];
				// Off drops this session's waiting replies (S8); other sessions' are theirs. A request the user chose to read
				// after the current one is not an auto-read and stays (T33).
				if (auto === "off") {
					queue.clear((item) => item.manual === true);
					footer();
				}
				ctx.ui.notify(AUTO_MESSAGES[auto], "info");
			},
		});

		const replyIds = (ctx: ExtensionContext): Set<string> => new Set(listReplies(ctx.sessionManager.getBranch()).map((reply) => reply.entryId));

		/** Queues, in order and once each, every final reply on the branch auto-read has not seen (S8 Timing, T42). */
		const queueNewReplies = (ctx: ExtensionContext): void => {
			if (auto === "off") return;
			const added = listReplies(ctx.sessionManager.getBranch()).filter((reply) => !seen.has(reply.entryId));
			const mark = added.length > 0 ? openReadingLock(env)?.waitingMark() : undefined;
			for (const reply of added) {
				seen.add(reply.entryId);
				const markdown = auto === "questions" ? questionsSection(reply.text) : reply.text;
				if (markdown === undefined) continue;
				// Queued, never awaited: it waits for any reading playing here or on the machine (S8 Queue), and a download
				// confirm or the output question must not hold the agent.
				queue.push({ ctx, name: reply.id, label: reply.id, markdown, language: detectLanguage(reply.text), mark });
				footer();
			}
		};

		// Each final reply joins the line as soon as it is stored (S8 Timing, T42), even while the agent keeps working
		// (an injected user-role message can chain another turn into the same run). Pi stores the entry only after the
		// message_end handlers return, so the branch is read on the next turn of the event loop, as pi-reply-thread does.
		pi.on("message_end", (_event, ctx) => {
			if (auto === "off") return;
			const asked = generation;
			setTimeout(() => {
				if (generation === asked) queueNewReplies(ctx);
			}, 0);
		});

		/**
		 * The language a prompt reads in (S18): its own words when they tell, else the latest reply's (the conversation's),
		 * else Spanish, as for any text that does not tell (S7).
		 */
		const promptLanguage = (ctx: ExtensionContext, text: string): Language => {
			const told = text ? languageOfWords(text) : undefined;
			if (told) return told;
			const reply = latestReply(listReplies(ctx.sessionManager.getBranch()));
			return reply ? detectLanguage(reply.text) : "es";
		};

		/** Queues a blocking prompt's reading (S18), when auto-read is on and it has something to say. */
		const queuePrompt = (ctx: ExtensionContext, key: string, name: string, markdown: string, language: Language): void => {
			if (!speechNarration(markdown, language).text) return;
			prompts.add(key);
			queue.push({ ctx, name, label: name, markdown, language, mark: openReadingLock(env)?.waitingMark(), prompt: key });
			footer();
		};

		/** An answered prompt (S18): its reading still waiting is dropped, one playing is stopped; other readings stay. */
		const dropPrompt = (key: string): void => {
			if (!prompts.delete(key)) return;
			queue.clear((item) => item.prompt !== key);
			if (current?.prompt === key) stop();
			footer();
		};

		pi.on("tool_execution_start", (event, ctx) => {
			pending.set(event.toolCallId, { toolName: event.toolName, args: event.args });
			if (auto === "off" || !QUESTION_TOOLS.has(event.toolName)) return;
			const questions = askedQuestions(event.toolName, event.args);
			if (!questions) return;
			const language = promptLanguage(ctx, questions.map(({ question, labels }) => [question, ...labels].join("\n")).join("\n"));
			queuePrompt(ctx, `tool:${event.toolCallId}`, "question", questionsMarkdown(questions, language), language);
		});

		pi.on("tool_execution_end", (event) => {
			pending.delete(event.toolCallId);
			dropPrompt(`tool:${event.toolCallId}`);
		});

		pi.on("ui_prompt_start", (event, ctx) => {
			spanPrompts = [];
			if (auto === "off" || ownPrompts > 0) return;
			const calls = [...pending];
			// An ask_user_* call shows its own dialog: it is already read from its call, so this span only answers it.
			const asks = calls.filter(([, call]) => QUESTION_TOOLS.has(call.toolName)).map(([id]) => `tool:${id}`);
			if (asks.length > 0) {
				spanPrompts = asks;
				return;
			}
			// A confirm while a bash call waits to run is that command's confirmation: the latest started is the one asked.
			const bash = calls.filter(([, call]) => call.toolName === "bash").at(-1);
			if (event.kind === "confirm" && bash) {
				const [id, call] = bash;
				const command = (call.args as { command?: unknown } | undefined)?.command;
				const language = promptLanguage(ctx, "");
				const key = `tool:${id}`;
				spanPrompts = [key];
				queuePrompt(ctx, key, "command confirmation", commandMarkdown(typeof command === "string" ? commandProgram(command) : undefined, language), language);
				return;
			}
			const title = dialogTitle(event.title);
			if (!title) return;
			const key = `dialog:${++dialogs}`;
			spanPrompts = [key];
			const language = promptLanguage(ctx, title);
			queuePrompt(ctx, key, "dialog", title, language);
		});

		pi.on("ui_prompt_end", () => {
			const answered = spanPrompts;
			spanPrompts = [];
			for (const key of answered) dropPrompt(key);
		});

		// Moving to another branch (/tree) is no new reply: what that branch already holds is never read.
		pi.on("session_tree", (_event, ctx) => {
			for (const id of replyIds(ctx)) seen.add(id);
		});

		/** Subscribes this session to the reader's channels (S10), replacing any earlier subscription, and says it is ready. */
		const listen = (): void => {
			unsubscribeEvents?.();
			unsubscribeEvents = undefined;
			// A host without an event bus (a bare test double) just has no integration; every command works as before.
			const bus = pi.events as ExtensionAPI["events"] | undefined;
			if (!bus) return;
			const presence = { v: READER_EVENTS_VERSION };
			const offPing = bus.on(READER_EVENTS.ping, (data) => {
				// Synchronous, before any await: the view reads its flag right after its own emit returns.
				if (latest && isPing(data)) bus.emit(READER_EVENTS.ready, { ...presence });
			});
			const offRead = bus.on(READER_EVENTS.read, (data) => {
				const request = parseReadRequest(data);
				const ctx = latest;
				if (!request || !ctx) return;
				// Not awaited: the sender gets no answer; the "Something is being read." question, a download confirm or the
				// output question are the reader's.
				readRequested(ctx, request.id, request.id, request.text, detectLanguage(request.text)).catch((error: Error) =>
					ctx.ui.notify(error.message, "error"),
				);
			});
			unsubscribeEvents = () => {
				offPing();
				offRead();
			};
			bus.emit(READER_EVENTS.ready, { ...presence });
		};

		pi.on("session_start", (_event, ctx) => {
			generation++;
			latest = ctx;
			// Players left by a Pi that died (S13 h): a hung paplay spins at about a core until it is ended.
			reapOrphans();
			auto = "off";
			queue.clear();
			seen = new Set();
			pending.clear();
			prompts.clear();
			spanPrompts = [];
			chosen = undefined;
			speaker = "male";
			warned = false;
			sessionSpeed = undefined;
			speedWarned = false;
			unsubscribe?.();
			unsubscribe = ctx.hasUI
				? ctx.ui.onTerminalInput((data) => {
						// While the "Something is being read." question is open, Esc dismisses it and stops nothing (T33).
						if (asking > 0 || !current || !matchesKey(data, Key.escape)) return undefined;
						// Esc stops this session's reading and drops every auto-read waiting on the machine (S8): dropped first,
						// so no waiter can take the machine between the reading ending and the drop.
						queue.clear();
						openReadingLock(env)?.dropWaiting();
						stop();
						return { consume: true };
					})
				: undefined;
			listen();
		});

		pi.on("session_shutdown", () => {
			generation++;
			// The session's end drops its waiting replies (S8), before its reading ends and would start one.
			queue.clear();
			stop();
			unsubscribe?.();
			unsubscribe = undefined;
			unsubscribeEvents?.();
			unsubscribeEvents = undefined;
			latest = undefined;
		});
	};
}

export default createReplyReader();

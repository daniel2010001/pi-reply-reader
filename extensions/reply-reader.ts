import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type KeyId, SelectList } from "@earendil-works/pi-tui";
import { createAutoQueue, type StartResult } from "../src/auto-queue.ts";
import { configFile, loadOutputs, type Output } from "../src/outputs.ts";
import { createMusic, describeMusic, loadMusic, MUSIC_MODES, type MusicSettings, parseMusicArgs, saveMusic } from "../src/music.ts";
import { keyName, loadPauseKey } from "../src/pause-key.ts";
import { startOutputReading } from "../src/listener.ts";
import type { Reading, SherpaTts } from "../src/playback.ts";
import { checkDeathSignal, playerTimeoutMs, reapOrphans } from "../src/player.ts";
import { questionsSection } from "../src/questions.ts";
import { projectChanged, projectOf } from "../src/project.ts";
import { askedQuestions, commandMarkdown, commandProgram, dialogTitle, QUESTION_TOOLS, questionsMarkdown, writtenCalls } from "../src/prompts.ts";
import { isPing, parseReadRequest, READER_EVENTS, READER_EVENTS_VERSION } from "../src/reader-events.ts";
import { type Claim, openReadingLock, type WaitingItem } from "../src/reading-lock.ts";
import { findReply, latestReply, listReplies } from "../src/replies.ts";
import { sectionFrom } from "../src/sections.ts";
import { formatSpeed, loadSaved, loadSpeed, parseSpeed, SPEED_CHOICES, SPEED_HINT, saveSettings, saveSpeed } from "../src/settings.ts";
import {
	announcement,
	detectLanguage,
	type Fragment,
	type Language,
	languageOfWords,
	projectAnnouncement,
	speechNarration,
	speechNarrationOfParts,
} from "../src/speech-text.ts";
import { downloadVoice, findVoice, onPath, SPEAKERS, type SpeakerName, type Voice } from "../src/voice.ts";

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
/**
 * Play order (S16, L135): a session's next waiting reading yields to an earlier one of another session while that
 * session's line was published (its heartbeat, every WATCH_MS while it has readings waiting) within FRESH_MS, so a
 * frozen or dead session stops holding the line about FRESH_MS after its last beat; 2 s leaves room for a loaded
 * machine's late timers. YIELD_CAP_MS bounds the wait for one reading even for a session that beats but never starts;
 * it counts only time the machine is free and the session yields, never time another reading plays (L138). A session
 * waiting on a human (the output question, a voice download confirm) publishes it and is never yielded to.
 */
const FRESH_MS = 2000;
const YIELD_CAP_MS = 10_000;
/** Seconds of silence before a reading that waited in the line, which then says which it is (S14). */
const GAP_SECONDS = 1.5;
/** What /read-pause, /read-stop and /read-next say (S1, S15, S16). */
const NOTHING_READ = "Nothing is being read.";
const PAUSED = "Reading paused.";
const RESUMED = "Reading resumed.";
const PROMPT_STOPPED = "Reading stopped: a prompt is not paused.";
const CANNOT_PAUSE = "The reading playing cannot be paused (it is not in a Pi session); /read-stop ends it.";
const NOTHING_WAITS = "Nothing waits to be read.";
const SKIPPED = "Skipped to the next reading.";
const NOTHING_NEXT = "Reading stopped; nothing else waits.";
/** What /read-music offers (S22). */
const MUSIC_CHOICES: Record<string, string> = {
	off: "leave the music as it is",
	pause: "pause gentle-stream while reading, play it again after",
	duck: "lower gentle-stream's volume while reading (duck 20: to 20 %)",
};

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
 * Reads replies aloud on request only (S1): `/read` speaks the latest reply or one by ID, a new reading or
 * `/read-stop` ends the one playing or paused; the pause key (Alt+M, or settings.json `pauseKey`) or `/read-pause`
 * pauses it and resumes it from the start of the fragment it was in (S15; a blocking prompt's reading is ended
 * instead); Esc is Pi's, never the reader's (L145, L147); `/read-queue` lists what waits on the
 * machine and `/read-next` ends the current reading so the next one waiting starts (S16); `/read-output` picks where it sounds (S4) and `/read-voice` picks the male
 * or female voice (S3), `/read-speed` the voice speed, saved in settings.json (S3). `/read <file.md>` reads a Markdown file the same way (S6). Nothing plays by itself.
 * One reading per machine (S1, T21): through `$XDG_RUNTIME_DIR/pi-reply-reader/`, a new reading in any session
 * stops the one playing in another, `/read-stop` stops it too, and the session stopped that way just clears its footer.
 * `/read <target>#<section>` reads only the section under a matching heading, or on to the end with `rest` (S9). `/read-auto` (S8) reads each new reply, or only its
 * "Needs your decision" section, as soon as it is stored, each once and in order (T42); its last choice, and the output's, are saved in settings.json
 * for new sessions (S24; none saved: off, the output asked), and the footer shows it while on (S23). Auto-read never
 * interrupts (S8 Queue, T32): a reply due while a reading plays here or in another session waits, in order, and is read
 * once the machine is free; an explicit /read (or read request) or /read-stop drops every reply waiting on the
 * machine (the pause key pauses instead, S15), and /read-auto off or the session's end drops this session's. A reading that waited in this line starts after
 * 1.5 s of silence by saying which reply or file it is, and the footer counts what waits (S14, T38). A reading whose
 * project (its Git root's folder name, src/project.ts) differs from the last reading's on the machine says it first (S19).
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
 * Music steps aside while the machine reads (S22, src/music.ts): `/read-music off|pause|duck [level]`, saved in
 * settings.json; once per machine, restored when nothing reads or waits, on a pause, and at a session start after a
 * reader died. A listener output's music is the listener's `--serve`'s to step aside.
 */
export function createReplyReader(
	deps: {
		env?: NodeJS.ProcessEnv;
		hostname?: string;
		loadSherpa?: (voice: Voice) => Promise<SherpaTts>;
		/** Test seam: while it returns true, this session's line starts nothing, as a session slow to claim (S16). */
		holdLine?: () => boolean;
		/** Test seam: replaces YIELD_CAP_MS (S16). */
		yieldCapMs?: number;
		/** Test seam: the project this process remembers at first, without XDG_RUNTIME_DIR (S19), as after a reading of it. */
		lastProject?: string;
	} = {},
) {
	const yieldCapMs = deps.yieldCapMs ?? YIELD_CAP_MS;
	const env = deps.env ?? process.env;
	const hostname = deps.hostname ?? osHostname();
	/** The last reading's project when there is no usable XDG_RUNTIME_DIR to share it through: this process's (S19). */
	const lastProject: { last?: string } = { last: deps.lastProject };

	return (pi: ExtensionAPI): void => {
		/** This session's reading, playing or paused (S15). */
		interface Current {
			/** Its player and synthesis; undefined while paused. */
			reading?: Reading;
			ctx: ExtensionContext;
			claim?: Claim;
			watch?: ReturnType<typeof setInterval>;
			/** What the footer names, and where it sounds. */
			name: string;
			output: string;
			/** It sounds through this machine (local or PULSE_SERVER), so the music steps aside here (S22); a listener's steps aside there. */
			here: boolean;
			/** A blocking prompt's reading (S18): its answer stops it, and a pause ends it instead (S15). */
			prompt?: string;
			/** The fragment `reading` started from; paused, the one it resumes from (S15). */
			from: number;
			/** Starts playing again from fragment `from`, with the same voice, speed and output (S15). */
			play: (from: number) => void;
		}
		let current: Current | undefined;
		/** The output chosen in this session, by name: the saved one (S24), else asked on the first reading. */
		let chosen: string | undefined;
		/** The voice for the next reading in this session (S3: male unless changed). */
		let speaker: SpeakerName = "male";
		/** Whether this session's first reading already reported problems in outputs.json. */
		let warned = false;
		/** A speed set with /read-speed in this session; otherwise each reading uses the saved one. */
		let sessionSpeed: number | undefined;
		/** Whether this session already reported a problem in settings.json. */
		let speedWarned = false;
		/** Whether this session already warned that a listener output read through its fallback (S20: once per session). */
		let fallbackWarned = false;
		/** A music mode (and level) set with /read-music in this session; otherwise each reading uses the saved one (S22). */
		let sessionMusic: Pick<MusicSettings, "mode"> & Partial<Pick<MusicSettings, "level">> | undefined;
		/** Whether this session already said that music settings were ignored, or that a music command failed (S22). */
		let musicProblemWarned = false;
		let musicWarned = false;
		/** The pause key (S15, L147): settings.json `pauseKey`, else Alt+M; read once, as Pi registers shortcuts at load. */
		const pauseKey = loadPauseKey(env);
		const pauseName = keyName(pauseKey.key);
		/** Whether the problem with `pauseKey` was told (once, at the first session start with a UI). */
		let pauseKeyWarned = false;
		/** This session's auto-read mode (S8: off at session start unless settings.json saved one, S24). */
		let auto: AutoMode = "off";
		/** The footer last shown (S14, S23): shown again only when it changed. */
		let shownFooter: string | undefined;
		/**
		 * The entry IDs of the replies auto-read already queued or must never read (S8 Timing, T42): those on the branch
		 * when auto-read was turned on or the branch changed under it. Every other final reply is queued once.
		 */
		let seen = new Set<string>();
		/** The context of the latest session_start or command; bus events carry none (S10). Unset outside a session. */
		let latest: ExtensionContext | undefined;
		/** Ends this session's subscriptions on `pi.events`. */
		let unsubscribeEvents: (() => void) | undefined;

		/** Counts session starts and ends: an answer given after the session it was asked in ended or restarted is dropped. */
		let generation = 0;
		/** How many of the reader's own prompts (output, voice, speed, download confirm, the cut question) are open (S18). */
		let ownPrompts = 0;
		/** Tool calls started and not yet ended, in start order (S18): an ask_user_* call, or the bash a confirm is about. */
		const pending = new Map<string, { toolName: string; args: unknown }>();
		/** The prompt readings the open ui_prompt span answers when it ends (S18). */
		let spanPrompts: string[] = [];
		/** The text the latest assistant message wrote, by the IDs of the tool calls it made (S18 Context, T48). */
		let writtenBefore = new Map<string, string>();
		/** The keys of the prompt readings queued and not yet answered (S18). */
		const prompts = new Set<string>();
		/** Numbers dialogs, so each gets its own prompt key. */
		let dialogs = 0;
		/** Names this session's published line on the machine (S16). */
		const lineToken = randomUUID();
		/**
		 * When the latest reading joined the line; each later one joins strictly after it. Sub-millisecond wall-clock time,
		 * so readings two sessions queue within the same millisecond still list in the order they came (S16).
		 */
		let lastJoined = 0;
		const joined = (): number => (lastJoined = Math.max(performance.timeOrigin + performance.now(), lastJoined + 0.001));

		/**
		 * A reply due for auto-read, or a manual request answered "Read after it" (T33), with the machine's waiting mark
		 * when it was queued (S8 Queue). `name` and `label` are as for readAloud.
		 */
		interface Waiting {
			ctx: ExtensionContext;
			name: string;
			label: string;
			/** One document, or parts cleaned apart and read in order (a prompt's text, then its questions: T48). */
			markdown: string | readonly string[];
			language: Language | undefined;
			mark: string | undefined;
			manual?: true;
			/** A Markdown file rather than a reply: announced by its name (S14). */
			file?: true;
			/** A blocking prompt (S18): the key its answer drops it by. It says what it is, so it gets no announcement. */
			prompt?: string;
			/** When it joined the line (S16: the machine's list is in this order). */
			at: number;
		}
		/** Whether a reading plays (or is starting) in this session or anywhere on the machine. */
		const playing = (): boolean => current !== undefined || (openReadingLock(env)?.busy() ?? false);
		/**
		 * The first reading of this line while it yields to an earlier one elsewhere (S16): the free time spent yielding
		 * so far, and the check that last counted (unset while another reading plays, so that time is not counted, L138).
		 */
		let yielding: { at: number; spent: number; last?: number } | undefined;
		/**
		 * Whether this line's first reading lets an earlier one of another session go first, so readings play in
		 * /read-queue's order (S16, L135): while that session still beats (FRESH_MS) and is not waiting on a human, and
		 * for at most the yield cap of free time per reading (L138).
		 */
		const yields = (): boolean => {
			const head = queue.items[0];
			const lock = head ? openReadingLock(env) : undefined;
			const now = Date.now();
			const earlier =
				head !== undefined &&
				(lock?.waitingList() ?? []).some(
					(item) => item.token !== lineToken && item.at < head.at && !item.asking && item.beat !== undefined && now - item.beat < FRESH_MS,
				);
			if (!head || !earlier) {
				yielding = undefined;
				return false;
			}
			if (yielding?.at !== head.at) yielding = { at: head.at, spent: 0 };
			if (yielding.last !== undefined) yielding.spent += now - yielding.last;
			yielding.last = now;
			return yielding.spent < yieldCapMs;
		};
		/** Whether this line must wait: a reading plays (its time does not count toward the yield cap), or it yields. */
		const lineBusy = (): boolean => {
			if (playing()) {
				if (yielding) yielding.last = undefined;
				return true;
			}
			return (deps.holdLine?.() ?? false) || yields();
		};
		/** How many of this session's questions to a human (output, voice download) are open before a reading (S16, L138). */
		let humanWait = 0;
		const human = async <T>(prompt: () => Promise<T>): Promise<T> => {
			humanWait++;
			publish();
			try {
				return await prompt();
			} finally {
				humanWait--;
				publish();
			}
		};
		/** Republishes this session's line every WATCH_MS while it has readings waiting: its heartbeat (S16). */
		let beating: ReturnType<typeof setInterval> | undefined;
		const heartbeat = (): void => {
			if (queue.size === 0 && !queue.starting) {
				clearInterval(beating);
				beating = undefined;
				return;
			}
			if (beating) return;
			// Each beat also checks whether the line emptied meanwhile (a start dropped while it waited on a human, L138).
			beating = setInterval(() => {
				publish();
				heartbeat();
			}, WATCH_MS);
			beating.unref?.();
		};
		/** This session's waiting auto-reads; without a usable XDG_RUNTIME_DIR it only waits for this session's readings. */
		const queue = createAutoQueue<Waiting>({
			busy: lineBusy,
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
			// The footer follows at each place that changes the line, as before, and other sessions' lines on its checks.
			onChange: () => {
				publish();
				heartbeat();
			},
		});

		/** The music settings for the next step aside (S22): this session's /read-music, over the saved ones. */
		const musicSettings = (): MusicSettings => {
			const { music } = loadMusic(env);
			return sessionMusic ? { ...music, ...sessionMusic } : music;
		};
		/**
		 * Music steps aside while the machine reads (S22): when this session takes the machine's reading turn, and back
		 * once nothing reads or waits on the machine (any session's end of the line, a pause, a session start after a
		 * reader died). Commands run in the background; a failure is said once per session.
		 */
		const music = createMusic({
			env,
			settings: musicSettings,
			idle: () => current === undefined && queue.starting === undefined && !(openReadingLock(env)?.busy() ?? false) && waitingCount() === 0,
			warn: (message) => {
				const ctx = current?.ctx ?? latest;
				if (musicWarned || !ctx) return;
				musicWarned = true;
				ctx.ui.notify(message, "warning");
			},
		});
		/** Steps the music aside for a reading that sounds here, telling once per session about ignored settings. */
		const stepAside = (ctx: ExtensionContext): void => {
			const { problem } = loadMusic(env);
			if (problem && !sessionMusic && !musicProblemWarned) {
				musicProblemWarned = true;
				ctx.ui.notify(problem, "warning");
			}
			music.stepAside();
		};

		/** This session as /read-queue names it: its name (Pi's /name), else its working folder. */
		const sessionLabel = (): string => {
			const ctx = latest;
			if (!ctx) return "a Pi session";
			const named = (ctx.sessionManager as Partial<ExtensionContext["sessionManager"]>).getSessionName?.();
			return named || basename(ctx.cwd) || ctx.cwd;
		};
		/**
		 * What tells this session apart from another with the same label in /read-queue (S16): the last four characters of
		 * Pi's session id (its random part), else of this line's token.
		 */
		const sessionTag = (): string | undefined => {
			const id = (latest?.sessionManager as Partial<ExtensionContext["sessionManager"]> | undefined)?.getSessionId?.();
			return typeof id === "string" && id ? id.replace(/-/g, "").slice(-4) : undefined;
		};
		/** Publishes this session's line next to the reading lock, so every session sees the machine's (S16). */
		const publish = (): void => {
			// The one being started stays listed until it claims the machine, so no other session takes its turn meanwhile.
			const line = queue.starting && !current ? [queue.starting, ...queue.items] : queue.items;
			const items: WaitingItem[] = line.map((item) => ({ name: item.name, at: item.at, mark: item.mark }));
			openReadingLock(env)?.publishLine(lineToken, sessionLabel(), items, sessionTag(), humanWait > 0);
			// The line emptied with nothing read (dropped, /read-auto off): music left aside comes back (S22).
			if (items.length === 0) music.settle();
		};
		/** How many readings wait: on the machine, or in this session's line without a usable XDG_RUNTIME_DIR (S16). */
		const waitingCount = (): number => {
			const lock = openReadingLock(env);
			return lock ? lock.waitingList().length : queue.size;
		};

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
		 * Shows this session's reading in the footer, with how many readings wait on the machine (S14, S16):
		 * `Reading P12.R2 on local · 2 waiting · Alt+M pauses`, or paused (S15) `Paused P12.R2 · Alt+M resumes · /read-stop ends`.
		 * While auto-read is on (S23) it always shows it, with the chosen output while nothing is read here
		 * (`Auto-read on · desktop`, `Auto-read questions`) and before the reading's status while one is
		 * (`Auto-read on · Reading P12.R2 on desktop · Alt+M pauses`). Shown again only when it changed.
		 */
		const footer = (ctx: ExtensionContext | undefined = current?.ctx ?? latest): void => {
			let reading: string | undefined;
			if (current) {
				const waiting = waitingCount();
				const count = waiting > 0 ? `${waiting} waiting · ` : "";
				reading = current.reading
					? `Reading ${current.name} on ${current.output} · ${count}${pauseName} pauses`
					: `Paused ${current.name} · ${count}${pauseName} resumes · /read-stop ends`;
			}
			const mode = auto === "off" ? undefined : `Auto-read ${auto === "full" ? "on" : "questions"}`;
			const text = mode ? [mode, reading ?? chosen].filter(Boolean).join(" · ") : reading;
			if (text === shownFooter || !ctx) return;
			shownFooter = text;
			ctx.ui.setStatus(STATUS, text);
		};

		/** Saves `values` in settings.json for new sessions (S24); the reason it could not, else undefined. */
		const save = (values: Record<string, unknown>): string | undefined => {
			try {
				saveSettings(env, values);
				return undefined;
			} catch (error) {
				return (error as Error).message;
			}
		};

		/**
		 * Ends this session's reading, playing or paused, and clears its footer; another session's reading is left alone.
		 * `replacing`: a new reading of this session takes its place at once, so the music stays aside (S22: not idle).
		 */
		const stop = (replacing = false): void => {
			if (!current) return;
			const { reading, ctx, claim, watch } = current;
			current = undefined;
			clearInterval(watch);
			reading?.stop();
			claim?.release();
			// Nothing reads or waits on the machine any more: the music comes back (S22); between queued readings it stays aside.
			if (!replacing) music.settle();
			footer(ctx);
			// A reply waiting for this reading may start now.
			queue.kick();
		};

		/**
		 * Pauses this session's reading (S15): its player ends, and it keeps its turn on the machine with no player, so
		 * nothing waiting starts and the S13 watchdog has nothing to watch. It resumes from the start of the fragment
		 * being heard. A prompt's reading (S18) is ended instead: the prompt is still on screen, and what waits goes on.
		 */
		const pause = (): void => {
			const state = current;
			if (!state?.reading) return;
			if (state.prompt) return stop();
			const { reading } = state;
			state.from += reading.position();
			state.reading = undefined;
			state.claim?.setPaused(true);
			reading.stop();
			// Paused, the music comes back; resuming steps it aside again (S22).
			music.settle({ force: true });
			footer();
		};

		/** Resumes this session's paused reading from the fragment it was in (S15). */
		const resume = (): void => {
			const state = current;
			if (!state || state.reading) return;
			state.claim?.setPaused(false);
			// A listener reading that went to its fallback sounds here: it steps the music here aside again too (S20, S22).
			state.play(state.from);
			if (state.here) stepAside(state.ctx);
			footer();
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
			if (!output) return undefined;
			chosen = output.name;
			footer(ctx);
			// The pick is remembered for new sessions (S24).
			const unsaved = save({ output: output.name });
			if (unsaved) ctx.ui.notify(`Readings will sound on ${output.label} in this session, but ${unsaved}.`, "warning");
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
		 * session, the footer, the pause key, /read-stop and one reading per machine. Used by /read, read requests and auto-read.
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
			markdown: string | readonly string[],
			language?: Language,
			auto?: { mark: string | undefined; still: () => boolean; announce?: "reply" | "file" | "prompt"; prompt?: string },
		): Promise<StartResult> => {
			const narration = typeof markdown === "string" ? speechNarration(markdown, language) : speechNarrationOfParts(markdown, language ?? detectLanguage(markdown.join("\n\n")));
			if (!narration.text) {
				ctx.ui.notify(`${label} has nothing to read.`, "info");
				return "done";
			}

			let voice = findVoice(env);
			if (!voice) {
				try {
					voice = await downloadVoice({
						env,
						confirm: async (message) => ctx.hasUI && human(() => own(() => ctx.ui.confirm("Reply reader voice", message))),
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

			const output = await human(() => outputForReading(ctx));
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
				const taken = lock?.claimIfFree(auto.mark, { pausable: true, prompt: auto.prompt !== undefined });
				if (taken === "dropped") return "done";
				if (taken === "busy") return "busy";
				claim = taken;
			} else {
				queue.clear();
				// Replaced, not idle: the music stays aside for the new reading (S22).
				stop(true);
				claim = lock?.claim({ dropWaiting: true, pausable: true });
			}
			const speed = speedForReading(ctx);
			// An invalid REPLY_READER_PLAYER_TIMEOUT is reported once per process and the default used (S13 f).
			const timeoutMs = playerTimeoutMs(env, (message) => ctx.ui.notify(message, "warning"));
			// Resuming (S15) uses the voice, speed and output the reading started with.
			const voiceOf = SPEAKERS[speaker];
			// Started: a project other than the last reading's on the machine is said first (S19), then which it is (S14).
			const project = projectOf(ctx.cwd);
			const said = projectChanged(env, project, lastProject) ? projectAnnouncement(project, narration.language) : [];
			const fragments: readonly Fragment[] = [
				...said,
				...(auto?.announce && auto.announce !== "prompt" ? announcement(auto.announce, name, narration.language) : []),
				...narration.fragments,
			];
			const state: Current = { ctx, claim, name, output: output.name, here: !output.ssh, prompt: auto?.prompt, from: 0, play: () => {} };
			/** Stopped by another session: no message, just the footer. */
			const stoppedElsewhere = (): void => {
				if (current === state) stop();
			};
			/** Plays from fragment `from`; the gap before a reading that waited only comes before its very start (S14). */
			const play = (from: number, leadSilence?: number): void => {
				const reading = startOutputReading({
					voice,
					speaker: voiceOf,
					fragments: fragments.slice(from),
					leadSilence,
					output,
					env,
					loadSherpa: deps.loadSherpa,
					speed,
					timeoutMs,
					onPlayer: (pid) => {
						// A player of a reading paused meanwhile is already being ended; it must not stand for this one.
						if (state.reading !== reading) return;
						if (claim && !claim.setPlayer(pid)) stoppedElsewhere();
					},
					// A listener output that cannot read goes on through its fallback (S20), said once per session.
					onFallback: (message) => {
						// It sounds here after all: the music here steps aside (S22), and again at each resume (S15).
						state.here = true;
						if (current === state) stepAside(ctx);
						if (fallbackWarned) return;
						fallbackWarned = true;
						ctx.ui.notify(message, "warning");
					},
					lost: () => current !== state || state.reading !== reading || (claim?.lost() ?? false),
				});
				state.reading = reading;
				state.from = from;
				reading.done
					.catch((error: Error) => {
						// A player killed by a newer reading or /read-stop elsewhere fails; that is not an error here.
						if (current === state && state.reading === reading && !claim?.lost()) ctx.ui.notify(error.message, "error");
					})
					.finally(() => {
						// Paused (S15): this reading ended on purpose and the state waits to resume.
						if (current !== state || state.reading !== reading) return;
						stop();
					});
			};
			// Resuming never says the project again, even when paused while it was being said (S19).
			state.play = (from) => play(Math.max(from, said.length));
			play(0, auto?.announce ? GAP_SECONDS : undefined);
			// Another session's /read-stop, newer reading, /read-next or /read-pause (S1, S15, S16) reach this reading through
			// its entry; the footer also follows what waits on the machine.
			state.watch = claim
				? setInterval(() => {
						if (current !== state) return;
						if (claim.lost()) return stoppedElsewhere();
						const wanted = claim.paused();
						if (wanted === true && state.reading) pause();
						else if (wanted === false && !state.reading) resume();
						footer();
					}, WATCH_MS)
				: undefined;
			state.watch?.unref();
			current = state;
			// The machine's line went idle → reading: the music where it sounds steps aside, never delaying speech (S22).
			// A reading on a listener restores music left aside here (by the one it replaced, S22); a fallback steps it aside again.
			if (state.here) stepAside(ctx);
			else music.settle({ force: true });
			// Started: it no longer waits in the machine's list (S16).
			publish();
			footer();
			return "done";
		};

		/**
		 * Asks "Something is being read." (T33): as an overlay of its own in Pi's TUI, so it shows above another overlay
		 * (Alt+R); elsewhere (RPC, a host without overlays) through ctx.ui.select. Undefined when dismissed.
		 */
		const askCut = async (ctx: ExtensionContext): Promise<"now" | "after" | undefined> => {
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
					queue.push({ ctx, name, label, markdown, language, mark: openReadingLock(env)?.waitingMark(), manual: true, file, at: joined() });
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
			description: "End the reading, playing or paused, in this or another Pi session, and drop the ones waiting (a new /read ends it too)",
			handler: async (_args, ctx) => {
				const here = current !== undefined;
				queue.clear();
				stop();
				// Also drops every auto-read waiting on the machine (S8).
				const elsewhere = openReadingLock(env)?.stopOthers() ?? false;
				ctx.ui.notify(here || elsewhere ? "Reading stopped." : NOTHING_READ, "info");
			},
		});

		/** /read-pause and the pause key (S15, L147): pauses or resumes this session's reading, else another session's. */
		const togglePause = (ctx: ExtensionContext): void => {
			if (current) {
				if (current.prompt) {
					stop();
					ctx.ui.notify(PROMPT_STOPPED, "info");
				} else if (current.reading) {
					pause();
					ctx.ui.notify(PAUSED, "info");
				} else {
					resume();
					ctx.ui.notify(RESUMED, "info");
				}
				return;
			}
			// Another session's reading (S1): its own session pauses or resumes it on its next check.
			const result = openReadingLock(env)?.togglePause();
			const messages = { paused: PAUSED, resumed: RESUMED, stopped: PROMPT_STOPPED, unsupported: CANNOT_PAUSE };
			ctx.ui.notify(result ? messages[result] : NOTHING_READ, "info");
		};

		command("read-pause", {
			description: `Pause the reading playing, in this or another Pi session, or resume it from the sentence it was in (${pauseName} too)`,
			handler: async (_args, ctx) => togglePause(ctx),
		});

		// Esc is Pi's (it interrupts the agent, closes dialogs): the reader never takes it (L145, L147).
		pi.registerShortcut(pauseKey.key as KeyId, {
			description: "Pause the reading playing, in this or another Pi session, or resume it (as /read-pause)",
			handler: async (ctx) => {
				latest = ctx;
				togglePause(ctx);
			},
		});

		command("read-queue", {
			description: "List the readings waiting on this machine, in order, with their sessions",
			handler: async (_args, ctx) => {
				const lock = openReadingLock(env);
				if (!lock) {
					// No XDG_RUNTIME_DIR: no session can see another's line, so this one lists its own and says so.
					const items = queue.items;
					ctx.ui.notify(
						items.length === 0
							? NOTHING_WAITS
							: ["Waiting in this session (other sessions are not visible without XDG_RUNTIME_DIR):", ...items.map((item, at) => `${at + 1}. ${item.name}`)].join("\n"),
						"info",
					);
					return;
				}
				const list = lock.waitingList();
				ctx.ui.notify(
					list.length === 0
						? NOTHING_WAITS
						: [
								"Waiting on this machine:",
								...list.map((item, at) => `${at + 1}. ${item.name} · ${item.session}${item.token === lineToken ? " (this session)" : ""}`),
							].join("\n"),
					"info",
				);
			},
		});

		command("read-next", {
			description: "End the reading, playing or paused, in this or another Pi session, and go on with the next one waiting",
			handler: async (_args, ctx) => {
				const waiting = waitingCount() > 0;
				// Unlike /read-stop, what waits is kept: the next one starts once the machine is free, announced (S14).
				if (current) stop();
				else if (!(openReadingLock(env)?.skipOthers() ?? false)) {
					ctx.ui.notify(NOTHING_READ, "info");
					return;
				}
				ctx.ui.notify(waiting ? SKIPPED : NOTHING_NEXT, "info");
			},
		});

		command("read-output", {
			description: "Choose where readings sound: local or an output from outputs.json; saved for later sessions",
			getArgumentCompletions: (prefix) =>
				loadOutputs(env, hostname)
					.outputs.filter((output) => output.name.startsWith(prefix.trim()))
					.map((output) => ({
						value: output.name,
						label: output.name,
						description: output.ssh ? `listener ${output.ssh}` : (output.pulseServer ?? `this machine (${hostname})`),
					})),
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
					footer(ctx);
					const unsaved = save({ output: output.name });
					if (unsaved) {
						ctx.ui.notify(`Readings will sound on ${output.label} in this session, but ${unsaved}.`, "warning");
						return;
					}
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

		command("read-music", {
			description:
				"What music does while the reader speaks: off, pause, or duck [level] (lower gentle-stream to level %, default duck 20); no argument shows it; saved for later sessions",
			getArgumentCompletions: (prefix) =>
				MUSIC_MODES.filter((mode) => mode.startsWith(prefix.trim())).map((mode) => ({ value: mode, label: mode, description: MUSIC_CHOICES[mode] })),
			handler: async (args, ctx) => {
				const parsed = parseMusicArgs(args);
				if (parsed === "show") {
					const current = musicSettings();
					const hooks = [current.before && `before "${current.before}"`, current.after && `after "${current.after}"`].filter(Boolean);
					ctx.ui.notify(`${describeMusic(current)}${hooks.length > 0 ? ` Hooks: ${hooks.join("; ")}.` : ""}`, "info");
					return;
				}
				if ("problem" in parsed) {
					ctx.ui.notify(parsed.problem, "warning");
					return;
				}
				const level = parsed.level ?? musicSettings().level;
				sessionMusic = parsed.level === undefined ? { ...sessionMusic, mode: parsed.mode } : { mode: parsed.mode, level };
				const said = describeMusic({ mode: parsed.mode, level }, true);
				try {
					saveMusic(env, parsed);
				} catch (error) {
					ctx.ui.notify(`${said.slice(0, -1)} in this session, but ${(error as Error).message}.`, "warning");
					return;
				}
				ctx.ui.notify(said, "info");
			},
		});

		command("read-auto", {
			description:
				'Read each new reply aloud as soon as it is written, and each prompt that waits for you: on (in full), questions (only "Needs your decision"), off; no argument toggles; saved for later sessions',
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
				if (auto === "off") queue.clear((item) => item.manual === true);
				footer(ctx);
				// The choice is remembered for new sessions (S24).
				const unsaved = save({ autoRead: auto === "full" ? "on" : auto });
				if (unsaved) ctx.ui.notify(`${AUTO_MESSAGES[auto].slice(0, -1)} in this session, but ${unsaved}.`, "warning");
				else ctx.ui.notify(AUTO_MESSAGES[auto], "info");
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
				queue.push({ ctx, name: reply.id, label: reply.id, markdown, language: detectLanguage(reply.text), mark, at: joined() });
				footer();
			}
		};

		// Each final reply joins the line as soon as it is stored (S8 Timing, T42), even while the agent keeps working
		// (an injected user-role message can chain another turn into the same run). Pi stores the entry only after the
		// message_end handlers return, so the branch is read on the next turn of the event loop, as pi-reply-thread does.
		pi.on("message_end", (event, ctx) => {
			// What an assistant message wrote, kept for the calls it makes (S18 Context, T48): Pi runs a message's tool calls
			// after its message_end, so their tool_execution_start finds it here, from the event itself, not the branch.
			const written = writtenCalls(event.message);
			if (written) writtenBefore = new Map(written.calls.map((id) => [id, written.text]));
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
		const queuePrompt = (ctx: ExtensionContext, key: string, name: string, markdown: string | readonly string[], language: Language): void => {
			if (!(typeof markdown === "string" ? speechNarration(markdown, language) : speechNarrationOfParts(markdown, language)).text) return;
			prompts.add(key);
			queue.push({ ctx, name, label: name, markdown, language, mark: openReadingLock(env)?.waitingMark(), prompt: key, at: joined() });
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
			// The text written before the call, in the same message, is read first, in its own language when it tells (T48);
			// questions mode reads only the questions. Each is cleaned apart, so no Markdown block of the text swallows them.
			const context = auto === "questions" ? "" : (writtenBefore.get(event.toolCallId) ?? "");
			const language =
				(context ? languageOfWords(context) : undefined) ??
				promptLanguage(ctx, questions.map(({ question, labels }) => [question, ...labels].join("\n")).join("\n"));
			const markdown = questionsMarkdown(questions, language);
			queuePrompt(ctx, `tool:${event.toolCallId}`, "question", context ? [context, markdown] : markdown, language);
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
			// The one-time setpriv check runs in the background from here, so the first reading can already use it (S13 h).
			void checkDeathSignal(onPath("setpriv", env));
			musicWarned = false;
			musicProblemWarned = false;
			sessionMusic = undefined;
			// Music a reader that died left aside comes back, when nothing reads or waits on the machine (S22).
			music.settle();
			// The last choices of /read-auto and /read-output, as saved (S24); none saved: off, the output asked.
			const saved = loadSaved(env);
			auto = saved.autoRead === "on" ? "full" : saved.autoRead === "questions" ? "questions" : "off";
			queue.clear();
			// Saved on: what is already on the branch is never read (S8: no reply of earlier turns).
			seen = auto === "off" ? new Set() : replyIds(ctx);
			pending.clear();
			writtenBefore = new Map();
			prompts.clear();
			spanPrompts = [];
			chosen = undefined;
			if (saved.output) {
				// A saved output gone from outputs.json is not used: the first reading asks, as with none saved (S24).
				if (loadOutputs(env, hostname).outputs.some((output) => output.name === saved.output)) chosen = saved.output;
				else ctx.ui.notify(`Saved output "${saved.output}" is not in ${configFile(env, "outputs.json") ?? "outputs.json"}; choose one.`, "warning");
			}
			speaker = "male";
			warned = false;
			sessionSpeed = undefined;
			speedWarned = false;
			fallbackWarned = false;
			if (pauseKey.problem && ctx.hasUI && !pauseKeyWarned) {
				pauseKeyWarned = true;
				ctx.ui.notify(pauseKey.problem, "warning");
			}
			// The saved auto-read shows from the session's start (S23).
			footer(ctx);
			listen();
		});

		pi.on("session_shutdown", () => {
			generation++;
			// The session's end drops its waiting replies (S8), before its reading ends and would start one; its footer goes.
			auto = "off";
			queue.clear();
			stop();
			footer();
			openReadingLock(env)?.publishLine(lineToken, sessionLabel(), []);
			music.settle();
			unsubscribeEvents?.();
			unsubscribeEvents = undefined;
			latest = undefined;
		});
	};
}

export default createReplyReader();

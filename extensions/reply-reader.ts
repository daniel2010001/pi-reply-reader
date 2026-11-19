import { readFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { createAutoQueue, type StartResult } from "../src/auto-queue.ts";
import { loadOutputs, type Output } from "../src/outputs.ts";
import { type Reading, type SherpaTts, startReading } from "../src/playback.ts";
import { questionsSection } from "../src/questions.ts";
import { isPing, parseReadRequest, READER_EVENTS, READER_EVENTS_VERSION } from "../src/reader-events.ts";
import { type Claim, openReadingLock } from "../src/reading-lock.ts";
import { findReply, latestReply, listReplies } from "../src/replies.ts";
import { sectionFrom } from "../src/sections.ts";
import { formatSpeed, loadSpeed, parseSpeed, SPEED_CHOICES, SPEED_HINT, saveSpeed } from "../src/settings.ts";
import { detectLanguage, type Language, speechNarration } from "../src/speech-text.ts";
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
 * "Needs your decision" section, when the agent's turn ends; it is off at every session start. Auto-read never
 * interrupts (S8 Queue, T32): a reply due while a reading plays here or in another session waits, in order, and is read
 * once the machine is free; an explicit /read (or read request), /read-stop or Esc drops every reply waiting on the
 * machine, and /read-auto off or the session's end drops this session's.
 * Other extensions (pi-reply-thread's Alt+R view) reach it over `pi.events` (S10, src/reader-events.ts): a ping is
 * answered with ready, ready is also sent at each session start, and a read request reads its text like `/read`.
 */
export function createReplyReader(
	deps: { env?: NodeJS.ProcessEnv; hostname?: string; loadSherpa?: (voice: Voice) => Promise<SherpaTts> } = {},
) {
	const env = deps.env ?? process.env;
	const hostname = deps.hostname ?? osHostname();

	return (pi: ExtensionAPI): void => {
		let current: { reading: Reading; ctx: ExtensionContext; claim?: Claim; watch?: ReturnType<typeof setInterval> } | undefined;
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
		/** The entry ID of the latest reply when the current agent run started; a run's own reply differs from it. */
		let before: string | undefined;
		/** Whether an agent run is between its first agent_start and agent_settled. */
		let running = false;
		/** The context of the latest session_start or command; bus events carry none (S10). Unset outside a session. */
		let latest: ExtensionContext | undefined;
		/** Ends this session's subscriptions on `pi.events`. */
		let unsubscribeEvents: (() => void) | undefined;

		/** A reply due for auto-read, with the machine's waiting mark when it was queued (S8 Queue). */
		interface Waiting {
			ctx: ExtensionContext;
			id: string;
			markdown: string;
			language: Language;
			mark: string | undefined;
		}
		/** This session's waiting auto-reads; without a usable XDG_RUNTIME_DIR it only waits for this session's readings. */
		const queue = createAutoQueue<Waiting>({
			busy: () => current !== undefined || (openReadingLock(env)?.busy() ?? false),
			start: (item, still) =>
				readAloud(item.ctx, item.id, item.id, item.markdown, item.language, { mark: item.mark, still }).catch((error: Error) => {
					item.ctx.ui.notify(error.message, "error");
					return "done" as const;
				}),
			retryMs: WATCH_MS,
		});

		/** Registers a command whose context becomes the one bus events read with. */
		const command = (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]): void =>
			pi.registerCommand(name, {
				...options,
				handler: (args, ctx) => {
					latest = ctx;
					return options.handler(args, ctx);
				},
			});

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
			const label = await ctx.ui.select(ASK_OUTPUT, list.map((output) => output.label));
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
		 */
		const readAloud = async (
			ctx: ExtensionContext,
			name: string,
			label: string,
			markdown: string,
			language?: Language,
			auto?: { mark: string | undefined; still: () => boolean },
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
						confirm: async (message) => ctx.hasUI && ctx.ui.confirm("Reply reader voice", message),
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
			/** Stopped by another session: no message, just the footer. */
			const stoppedElsewhere = (): void => {
				if (current?.reading === reading) stop();
			};
			const reading = startReading({
				voice,
				speaker: SPEAKERS[speaker],
				fragments: narration.fragments,
				output,
				env,
				loadSherpa: deps.loadSherpa,
				speed,
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
			current = { reading, ctx, claim, watch };
			ctx.ui.setStatus(STATUS, `Reading ${name} on ${output.name} · Esc stops`);
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
				if (MARKDOWN_FILE.test(wanted)) {
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
				await readAloud(ctx, name, label, markdown, language);
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
					picked = await ctx.ui.select(ASK_SPEAKER, SPEAKER_NAMES);
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
					const picked = await ctx.ui.select(ASK_SPEED, SPEED_CHOICES);
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
				'Read each new reply aloud when the agent finishes, in this session: on (in full), questions (only "Needs your decision"), off; no argument toggles',
			getArgumentCompletions: (prefix) =>
				AUTO_CHOICES.filter((choice) => choice.value.startsWith(prefix.trim())).map((choice) => ({ ...choice, label: choice.value })),
			handler: async (args, ctx) => {
				const wanted = args.trim();
				const modes: Record<string, AutoMode> = { on: "full", questions: "questions", off: "off", "": auto === "off" ? "full" : "off" };
				if (!Object.hasOwn(modes, wanted)) {
					ctx.ui.notify("Use /read-auto on, questions or off.", "warning");
					return;
				}
				auto = modes[wanted];
				// Off drops this session's waiting replies (S8); other sessions' are theirs.
				if (auto === "off") queue.clear();
				ctx.ui.notify(AUTO_MESSAGES[auto], "info");
			},
		});

		const latestReplyId = (ctx: ExtensionContext): string | undefined => latestReply(listReplies(ctx.sessionManager.getBranch()))?.entryId;

		// A run can restart after agent_end (retries, compaction, queued messages); the first agent_start of a run takes
		// the snapshot and agent_settled, once nothing else will run, compares against it (S8: never an earlier reply).
		pi.on("agent_start", (_event, ctx) => {
			if (running) return;
			running = true;
			before = latestReplyId(ctx);
		});

		pi.on("agent_settled", (event, ctx) => {
			const started = running;
			running = false;
			if (!started || auto === "off" || event.aborted) return;
			const reply = latestReply(listReplies(ctx.sessionManager.getBranch()));
			if (!reply || reply.entryId === before) return;
			const markdown = auto === "questions" ? questionsSection(reply.text) : reply.text;
			if (markdown === undefined) return;
			// Queued, never awaited: it waits for any reading playing here or on the machine (S8 Queue), and a download
			// confirm or the output question must not hold Pi's settlement.
			queue.push({ ctx, id: reply.id, markdown, language: detectLanguage(reply.text), mark: openReadingLock(env)?.waitingMark() });
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
				// Not awaited: the sender gets no answer; a download confirm or the output question are the reader's.
				readAloud(ctx, request.id, request.id, request.text, detectLanguage(request.text)).catch((error: Error) =>
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
			latest = ctx;
			auto = "off";
			queue.clear();
			running = false;
			before = undefined;
			chosen = undefined;
			speaker = "male";
			warned = false;
			sessionSpeed = undefined;
			speedWarned = false;
			unsubscribe?.();
			unsubscribe = ctx.hasUI
				? ctx.ui.onTerminalInput((data) => {
						if (!current || !matchesKey(data, Key.escape)) return undefined;
						// Esc stops this session's reading and drops every auto-read waiting on the machine (S8).
						queue.clear();
						stop();
						openReadingLock(env)?.dropWaiting();
						return { consume: true };
					})
				: undefined;
			listen();
		});

		pi.on("session_shutdown", () => {
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

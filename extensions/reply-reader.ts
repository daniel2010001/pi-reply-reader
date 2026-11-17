import { readFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { loadOutputs, type Output } from "../src/outputs.ts";
import { type Reading, type SherpaTts, startReading } from "../src/playback.ts";
import { type Claim, openReadingLock } from "../src/reading-lock.ts";
import { findReply, latestReply, listReplies } from "../src/replies.ts";
import { formatSpeed, loadSpeed, parseSpeed, SPEED_CHOICES, SPEED_HINT, saveSpeed } from "../src/settings.ts";
import { speechText } from "../src/speech-text.ts";
import { downloadVoice, findVoice, SPEAKERS, type SpeakerName, type Voice } from "../src/voice.ts";

const STATUS = "reply-reader";
const ASK_OUTPUT = "Where should readings sound?";
const ASK_SPEAKER = "Which voice should read?";
const ASK_SPEED = "Which speed should readings use?";
const SPEAKER_NAMES = Object.keys(SPEAKERS) as SpeakerName[];
/** An argument naming a Markdown file rather than a reply (S6). */
const MARKDOWN_FILE = /\.(md|markdown)$/i;
/** How often a reading checks whether a newer one, or /read-stop, in another session took over (T21). */
const WATCH_MS = 250;

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

		/** Ends this session's reading and clears its footer; another session's reading is left alone. */
		const stop = (): void => {
			if (!current) return;
			const { reading, ctx, claim, watch } = current;
			current = undefined;
			clearInterval(watch);
			reading.stop();
			claim?.release();
			ctx.ui.setStatus(STATUS, undefined);
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

		pi.registerCommand("read", {
			description: "Read a reply aloud: the latest, or one by ID (P12.R1); or a Markdown file (notes.md)",
			handler: async (args, ctx) => {
				const wanted = args.trim();
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
				const text = speechText(markdown);
				if (!text) {
					ctx.ui.notify(`${label} has nothing to read.`, "info");
					return;
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
						return;
					}
					if (!voice) {
						ctx.ui.notify("Reading cancelled: the voice was not downloaded.", "info");
						return;
					}
				}

				const output = await outputForReading(ctx);
				if (!output) {
					ctx.ui.notify("Reading cancelled: no output chosen.", "info");
					return;
				}

				stop();
				const speed = speedForReading(ctx);
				// Without a usable XDG_RUNTIME_DIR there is no claim, and only this session's readings stop each other.
				const claim = openReadingLock(env)?.claim();
				/** Stopped by another session: no message, just the footer. */
				const stoppedElsewhere = (): void => {
					if (current?.reading === reading) stop();
				};
				const reading = startReading({
					voice,
					speaker: SPEAKERS[speaker],
					text,
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
			},
		});

		pi.registerCommand("read-stop", {
			description: "Stop the reading playing, in this or another Pi session (Esc or a new /read stop it too)",
			handler: async (_args, ctx) => {
				const here = current !== undefined;
				stop();
				const elsewhere = openReadingLock(env)?.stopOthers() ?? false;
				ctx.ui.notify(here || elsewhere ? "Reading stopped." : "Nothing is being read.", "info");
			},
		});

		pi.registerCommand("read-output", {
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

		pi.registerCommand("read-voice", {
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

		pi.registerCommand("read-speed", {
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

		pi.on("session_start", (_event, ctx) => {
			chosen = undefined;
			speaker = "male";
			warned = false;
			sessionSpeed = undefined;
			speedWarned = false;
			unsubscribe?.();
			unsubscribe = ctx.hasUI
				? ctx.ui.onTerminalInput((data) => {
						if (!current || !matchesKey(data, Key.escape)) return undefined;
						stop();
						return { consume: true };
					})
				: undefined;
		});

		pi.on("session_shutdown", () => {
			stop();
			unsubscribe?.();
			unsubscribe = undefined;
		});
	};
}

export default createReplyReader();

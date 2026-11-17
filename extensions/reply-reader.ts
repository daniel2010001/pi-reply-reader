import { readFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { loadOutputs, type Output } from "../src/outputs.ts";
import { type Reading, type SherpaTts, startReading } from "../src/playback.ts";
import { findReply, latestReply, listReplies } from "../src/replies.ts";
import { speechText } from "../src/speech-text.ts";
import { downloadVoice, findVoice, SPEAKERS, type SpeakerName, type Voice } from "../src/voice.ts";

const STATUS = "reply-reader";
const ASK_OUTPUT = "Where should readings sound?";
const ASK_SPEAKER = "Which voice should read?";
const SPEAKER_NAMES = Object.keys(SPEAKERS) as SpeakerName[];
/** An argument naming a Markdown file rather than a reply (S6). */
const MARKDOWN_FILE = /\.(md|markdown)$/i;

/** Why a Markdown file could not be read, in the user's words. */
function readProblem(error: NodeJS.ErrnoException): string {
	if (error.code === "ENOENT") return "file not found";
	if (error.code === "EISDIR") return "it is a folder";
	if (error.code === "EACCES" || error.code === "EPERM") return "permission denied";
	return error.message;
}

/**
 * Reads replies aloud on request only (S1): `/read` speaks the latest reply or one by ID, a new reading
 * or Esc stops the one playing, `/read-output` picks where it sounds (S4) and `/read-voice` picks the male
 * or female voice (S3). `/read <file.md>` reads a Markdown file the same way (S6). Nothing plays by itself.
 */
export function createReplyReader(
	deps: { env?: NodeJS.ProcessEnv; hostname?: string; loadSherpa?: (voice: Voice) => Promise<SherpaTts> } = {},
) {
	const env = deps.env ?? process.env;
	const hostname = deps.hostname ?? osHostname();

	return (pi: ExtensionAPI): void => {
		let current: { reading: Reading; ctx: ExtensionContext } | undefined;
		/** The output chosen in this session, by name; asked on the first reading. */
		let chosen: string | undefined;
		/** The voice for the next reading in this session (S3: male unless changed). */
		let speaker: SpeakerName = "male";
		/** Whether this session's first reading already reported problems in outputs.json. */
		let warned = false;
		let unsubscribe: (() => void) | undefined;

		const stop = (): void => {
			if (!current) return;
			current.reading.stop();
			current.ctx.ui.setStatus(STATUS, undefined);
			current = undefined;
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
				const reading = startReading({ voice, speaker: SPEAKERS[speaker], text, output, env, loadSherpa: deps.loadSherpa });
				current = { reading, ctx };
				ctx.ui.setStatus(STATUS, `Reading ${name} on ${output.name} · Esc stops`);
				reading.done
					.catch((error: Error) => {
						if (current?.reading === reading) ctx.ui.notify(error.message, "error");
					})
					.finally(() => {
						if (current?.reading !== reading) return;
						ctx.ui.setStatus(STATUS, undefined);
						current = undefined;
					});
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

		pi.on("session_start", (_event, ctx) => {
			chosen = undefined;
			speaker = "male";
			warned = false;
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

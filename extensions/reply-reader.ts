import { hostname as osHostname } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { loadOutputs, type Output } from "../src/outputs.ts";
import { type Reading, startReading } from "../src/playback.ts";
import { findReply, latestReply, listReplies } from "../src/replies.ts";
import { speechText } from "../src/speech-text.ts";
import { downloadVoice, findVoice } from "../src/voice.ts";

const STATUS = "reply-reader";
const ASK_OUTPUT = "Where should readings sound?";

/**
 * Reads replies aloud on request only (S1): `/read` speaks the latest reply or one by ID, a new reading
 * or Esc stops the one playing, and `/read-output` picks where it sounds (S4). Nothing plays by itself.
 */
export function createReplyReader(deps: { env?: NodeJS.ProcessEnv; hostname?: string } = {}) {
	const env = deps.env ?? process.env;
	const hostname = deps.hostname ?? osHostname();

	return (pi: ExtensionAPI): void => {
		let current: { reading: Reading; ctx: ExtensionContext } | undefined;
		/** The output chosen in this session, by name; asked on the first reading. */
		let chosen: string | undefined;
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
			const quiet = loadOutputs(env, hostname).outputs;
			const remembered = quiet.find((output) => output.name === chosen);
			if (remembered) return remembered;
			if (quiet.length === 1) return quiet[0];
			return askOutput(ctx, outputs(ctx));
		};

		pi.registerCommand("read", {
			description: "Read a reply aloud: the latest, or one by ID (P12.R1)",
			handler: async (args, ctx) => {
				const replies = listReplies(ctx.sessionManager.getBranch());
				const wanted = args.trim();
				const reply = wanted ? findReply(replies, wanted) : latestReply(replies);
				if (!reply) {
					ctx.ui.notify(wanted ? `No reply matches "${wanted}".` : "There is no reply to read yet.", "warning");
					return;
				}
				const text = speechText(reply.text);
				if (!text) {
					ctx.ui.notify(`${reply.id} has nothing to read.`, "info");
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
				const reading = startReading({ voice, text, output, env });
				current = { reading, ctx };
				ctx.ui.setStatus(STATUS, `Reading ${reply.id} on ${output.name} · Esc stops`);
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

		pi.on("session_start", (_event, ctx) => {
			chosen = undefined;
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

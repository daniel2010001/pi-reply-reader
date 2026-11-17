#!/usr/bin/env node
// `reply-reader <file.md>`: reads a Markdown file aloud from a terminal, without Pi (S6). The installed
// command runs the compiled dist/bin/reply-reader.js (`npm run build`, run before packing), since Node does not strip
// types under node_modules; from a checkout this file also runs directly with Node's type stripping.
import { createInterface } from "node:readline";
import { main } from "../src/cli.ts";

const interrupt = new AbortController();
// Ctrl+C, kill or a closed terminal stops the reading (or the download) instead of leaving the player playing;
// the exit code is 128 plus the signal number, as a shell reports it.
const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
let caught: keyof typeof SIGNAL_CODES | undefined;
for (const signal of Object.keys(SIGNAL_CODES) as (keyof typeof SIGNAL_CODES)[]) {
	process.on(signal, () => {
		caught ??= signal;
		interrupt.abort();
	});
}

/** The y/N download question on the terminal; anything but y or yes is no, and Ctrl+C at the prompt interrupts. */
function confirm(message: string): Promise<boolean> {
	return new Promise((done) => {
		const prompt = createInterface({ input: process.stdin, output: process.stderr });
		let answered = false;
		const finish = (yes: boolean): void => {
			if (answered) return;
			answered = true;
			prompt.close();
			done(yes);
		};
		prompt.on("SIGINT", () => {
			interrupt.abort();
			finish(false);
		});
		prompt.on("close", () => finish(false));
		prompt.question(`${message} [y/N] `, (answer) => finish(/^y(es)?$/i.test(answer.trim())));
	});
}

const code = await main(process.argv.slice(2), {
	env: process.env,
	stdin: process.stdin,
	stdout: process.stdout,
	stderr: process.stderr,
	isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
	confirm,
	signal: interrupt.signal,
});
process.exitCode = caught && code === SIGNAL_CODES.SIGINT ? SIGNAL_CODES[caught] : code;
// Nothing else is left to do; a native engine thread must not keep the command alive after the reading.
process.exit();

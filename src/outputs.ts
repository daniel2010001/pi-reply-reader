import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Where a reading sounds: this machine's default sink, a PulseAudio/PipeWire server elsewhere, or a listener that
 * synthesizes and plays it itself (S20), reached over SSH.
 */
export interface Output {
	name: string;
	label: string;
	/** PULSE_SERVER for the player; absent for this machine. */
	pulseServer?: string;
	/** The listener's SSH destination (`you@host`): the agent host sends it the fragments (S20). */
	ssh?: string;
	/** For a listener: the PULSE_SERVER that plays what the agent host synthesizes when the listener cannot (S20). */
	fallback?: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const VALUE_HINT = 'the value must be a PULSE_SERVER string such as "tcp:192.168.1.50:4713"';
const SSH_HINT = '"ssh" must be a host such as "you@host", without spaces or a leading "-"';
const FALLBACK_HINT = '"fallback" must be a PULSE_SERVER string such as "unix:/run/user/1000/reply-reader-pulse.sock"';
/**
 * An SSH destination that ssh cannot take for an option (S20): no leading "-", no whitespace or newline, no control
 * character (C0 with NUL, DEL, C1 with U+0085) and no Unicode line or paragraph separator.
 */
const SSH_HOST = /^[^-\s\p{Cc}\u2028\u2029][^\s\p{Cc}\u2028\u2029]*$/u;
const LISTENER_KEYS = ["ssh", "fallback"];

/**
 * `local` plus the outputs in `$XDG_CONFIG_HOME/pi-reply-reader/outputs.json`, an object mapping each
 * name to its PULSE_SERVER, or to `{ "ssh": "you@host", "fallback": "<PULSE_SERVER>" }` for a listener that
 * synthesizes (S20; `fallback` optional). Bad entries are skipped and reported in `problems`; nothing throws.
 */
export function loadOutputs(env: NodeJS.ProcessEnv, hostname: string): { outputs: Output[]; problems: string[] } {
	const outputs: Output[] = [{ name: "local", label: `local (${hostname})` }];
	const problems: string[] = [];
	const path = configFile(env, "outputs.json");
	if (!path) return { outputs, problems };

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { outputs, problems };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		problems.push(`Ignored ${path}: not valid JSON (${(error as Error).message}).`);
		return { outputs, problems };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		problems.push(`Ignored ${path}: expected an object mapping output names to PULSE_SERVER values.`);
		return { outputs, problems };
	}

	for (const [name, value] of Object.entries(parsed)) {
		const listener = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
		const unknown = listener && Object.keys(listener).find((key) => !LISTENER_KEYS.includes(key));
		const reason =
			name === "local"
				? "that name is built in"
				: !NAME.test(name)
					? 'names use letters, digits and "-"'
					: listener
						? unknown !== undefined
							? `unknown key "${unknown}" (use "ssh" and "fallback")`
							: typeof listener.ssh !== "string" || !SSH_HOST.test(listener.ssh)
								? SSH_HINT
								: listener.fallback !== undefined && (typeof listener.fallback !== "string" || listener.fallback.trim() === "")
									? FALLBACK_HINT
									: undefined
						: typeof value !== "string" || value.trim() === ""
							? VALUE_HINT
							: undefined;
		if (reason) {
			problems.push(`Ignored output "${name}" in ${path}: ${reason}.`);
			continue;
		}
		if (listener) {
			const ssh = listener.ssh as string;
			const fallback = listener.fallback as string | undefined;
			outputs.push({ name, label: `${name} (listener ${ssh})`, ssh, ...(fallback === undefined ? {} : { fallback }) });
			continue;
		}
		outputs.push({ name, label: `${name} (${value})`, pulseServer: value as string });
	}
	return { outputs, problems };
}

/**
 * `name` in this package's config folder: XDG_CONFIG_HOME, then ~/.config; relative values are ignored,
 * as the XDG spec says. Undefined when neither is usable.
 */
export function configFile(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const base =
		env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
			? env.XDG_CONFIG_HOME
			: env.HOME && isAbsolute(env.HOME)
				? join(env.HOME, ".config")
				: undefined;
	return base && join(base, "pi-reply-reader", name);
}

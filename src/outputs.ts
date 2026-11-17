import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Where a reading sounds: this machine's default sink, or a PulseAudio/PipeWire server elsewhere. */
export interface Output {
	name: string;
	label: string;
	/** PULSE_SERVER for the player; absent for this machine. */
	pulseServer?: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const VALUE_HINT = 'the value must be a PULSE_SERVER string such as "tcp:192.168.1.22:4713"';

/**
 * `local` plus the outputs in `$XDG_CONFIG_HOME/pi-reply-reader/outputs.json`, an object mapping each
 * name to its PULSE_SERVER. Bad entries are skipped and reported in `problems`; nothing throws.
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
		const reason =
			name === "local"
				? "that name is built in"
				: !NAME.test(name)
					? 'names use letters, digits and "-"'
					: typeof value !== "string" || value.trim() === ""
						? VALUE_HINT
						: undefined;
		if (reason) {
			problems.push(`Ignored output "${name}" in ${path}: ${reason}.`);
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

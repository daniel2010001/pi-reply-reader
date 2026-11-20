import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOutputs } from "../src/outputs.ts";

let root: string;
let env: NodeJS.ProcessEnv;
const local = { name: "local", label: "local (hs-node)" };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reply-reader-outputs-"));
	env = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = () => join(root, "config", "pi-reply-reader", "outputs.json");
function configure(content: string, path = file()): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

describe("loadOutputs", () => {
	it("offers only this machine when there is no config", () => {
		expect(loadOutputs(env, "hs-node")).toEqual({ outputs: [local], problems: [] });
	});

	it("adds each configured output after local, in file order", () => {
		configure('{ "desktop": "tcp:192.168.1.50:4713", "laptop": "tcp:192.168.1.30" }');
		expect(loadOutputs(env, "hs-node")).toEqual({
			outputs: [
				local,
				{ name: "desktop", label: "desktop (tcp:192.168.1.50:4713)", pulseServer: "tcp:192.168.1.50:4713" },
				{ name: "laptop", label: "laptop (tcp:192.168.1.30)", pulseServer: "tcp:192.168.1.30" },
			],
			problems: [],
		});
	});

	it("reads ~/.config when XDG_CONFIG_HOME is unset or relative", () => {
		const home = join(root, "home", ".config", "pi-reply-reader", "outputs.json");
		configure('{ "desktop": "tcp:a" }', home);
		env.XDG_CONFIG_HOME = "relative";
		expect(loadOutputs(env, "hs-node").outputs.map((o) => o.name)).toEqual(["local", "desktop"]);
		delete env.XDG_CONFIG_HOME;
		expect(loadOutputs(env, "hs-node").outputs.map((o) => o.name)).toEqual(["local", "desktop"]);
	});

	it("ignores a file that is not JSON and says why", () => {
		configure("{ desktop: tcp }");
		const { outputs, problems } = loadOutputs(env, "hs-node");
		expect(outputs).toEqual([local]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(new RegExp(`^Ignored ${file()}: not valid JSON \\(.+\\)\\.$`));
	});

	it("ignores a file that is not an object of names", () => {
		configure('["tcp:a"]');
		expect(loadOutputs(env, "hs-node")).toEqual({
			outputs: [local],
			problems: [`Ignored ${file()}: expected an object mapping output names to PULSE_SERVER values.`],
		});
	});

	it("skips bad entries, keeps good ones, and names each problem", () => {
		configure('{ "local": "tcp:x", "bad name": "tcp:y", "empty": "", "number": 4713, "desktop": "tcp:z" }');
		expect(loadOutputs(env, "hs-node")).toEqual({
			outputs: [local, { name: "desktop", label: "desktop (tcp:z)", pulseServer: "tcp:z" }],
			problems: [
				`Ignored output "local" in ${file()}: that name is built in.`,
				`Ignored output "bad name" in ${file()}: names use letters, digits and "-".`,
				`Ignored output "empty" in ${file()}: the value must be a PULSE_SERVER string such as "tcp:192.168.1.50:4713".`,
				`Ignored output "number" in ${file()}: the value must be a PULSE_SERVER string such as "tcp:192.168.1.50:4713".`,
			],
		});
	});
});

const SSH_HINT = '"ssh" must be a host such as "you@host", without spaces or a leading "-"';
const FALLBACK_HINT = '"fallback" must be a PULSE_SERVER string such as "unix:/run/user/1000/reply-reader-pulse.sock"';

describe("loadOutputs: a listener that synthesizes (S20)", () => {
	it("accepts { ssh, fallback } and { ssh } beside string values, labelled with the listener", () => {
		configure(
			'{ "desktop": { "ssh": "you@host", "fallback": "unix:/run/user/1000/reply-reader-pulse.sock" }, "phone": { "ssh": "phone.lan" }, "tunnel": "tcp:z" }',
		);
		expect(loadOutputs(env, "hs-node")).toEqual({
			outputs: [
				local,
				{
					name: "desktop",
					label: "desktop (listener you@host)",
					ssh: "you@host",
					fallback: "unix:/run/user/1000/reply-reader-pulse.sock",
				},
				{ name: "phone", label: "phone (listener phone.lan)", ssh: "phone.lan" },
				{ name: "tunnel", label: "tunnel (tcp:z)", pulseServer: "tcp:z" },
			],
			problems: [],
		});
	});

	it("skips an object whose ssh is missing, empty, starts with -, or holds whitespace or a newline, and names why", () => {
		configure(
			JSON.stringify({
				none: {},
				empty: { ssh: "" },
				option: { ssh: "-oProxyCommand=touch x" },
				space: { ssh: "you@host other" },
				newline: { ssh: "you@host\nother" },
				tab: { ssh: "you@host\t" },
				number: { ssh: 22 },
				good: { ssh: "you@host" },
			}),
		);
		const { outputs, problems } = loadOutputs(env, "hs-node");
		expect(outputs.map((o) => o.name)).toEqual(["local", "good"]);
		expect(problems).toEqual(
			["none", "empty", "option", "space", "newline", "tab", "number"].map((name) => `Ignored output "${name}" in ${file()}: ${SSH_HINT}.`),
		);
	});

	it("skips an object with an unknown key or a fallback that is not a non-empty string, and names why", () => {
		configure(
			JSON.stringify({
				extra: { ssh: "you@host", fallbak: "tcp:x" },
				empty: { ssh: "you@host", fallback: "" },
				number: { ssh: "you@host", fallback: 4713 },
				array: ["you@host"],
			}),
		);
		expect(loadOutputs(env, "hs-node")).toEqual({
			outputs: [local],
			problems: [
				`Ignored output "extra" in ${file()}: unknown key "fallbak" (use "ssh" and "fallback").`,
				`Ignored output "empty" in ${file()}: ${FALLBACK_HINT}.`,
				`Ignored output "number" in ${file()}: ${FALLBACK_HINT}.`,
				`Ignored output "array" in ${file()}: the value must be a PULSE_SERVER string such as "tcp:192.168.1.50:4713".`,
			],
		});
	});
});

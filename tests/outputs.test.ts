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

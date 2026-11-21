import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USAGE } from "../src/cli.ts";

/**
 * T28 (S11, first release): the package runs from node_modules, where Node does not strip types, so the
 * `reply-reader` bin is compiled JavaScript built before packing, and the tarball holds only what users need.
 */

const ROOT = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const buildConfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.build.json"), "utf8"));
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

/** The package entry of `npm pack --json`: an array of entries up to npm 11, an object (keyed by package, or the entry itself) from npm 12. */
function packResult(json: string): { files: { path: string }[] } {
	const parsed = JSON.parse(json);
	if (Array.isArray(parsed)) return parsed[0];
	return Array.isArray(parsed?.files) ? parsed : (Object.values(parsed)[0] as { files: { path: string }[] });
}

describe("package metadata", () => {
	it("is version 0.2.0 and names the public GitHub repository", () => {
		expect(pkg.version).toBe("0.2.0");
		expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/daniel2010001/pi-reply-reader.git" });
		expect(pkg.homepage).toBe("https://github.com/daniel2010001/pi-reply-reader#readme");
		expect(pkg.bugs).toEqual({ url: "https://github.com/daniel2010001/pi-reply-reader/issues" });
		expect(pkg.keywords).toContain("pi-package");
	});

	it("points the bin at the compiled file that the build emits, and builds before packing", () => {
		expect(buildConfig.compilerOptions.outDir).toBe("dist");
		expect(pkg.bin).toEqual({ "reply-reader": "./dist/bin/reply-reader.js" });
		expect(pkg.scripts.build).toBe("npm run clean && tsc -p tsconfig.build.json");
		expect(pkg.scripts.prepack).toBe("npm run build");
	});

	it("keeps loading the Pi extension from its TypeScript source", () => {
		expect(pkg.pi).toEqual({ extensions: ["./extensions/reply-reader.ts"] });
	});

	it("does not make `npm i -g` install Pi: the Pi packages are optional peers, supplied by Pi", () => {
		expect(Object.keys(pkg.peerDependencies).sort()).toEqual(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]);
		expect(pkg.peerDependenciesMeta).toEqual({
			"@earendil-works/pi-coding-agent": { optional: true },
			"@earendil-works/pi-tui": { optional: true },
		});
		expect(Object.keys(pkg.dependencies)).toEqual(["sherpa-onnx-node"]);
	});

	it("packs only what users need", () => {
		expect(pkg.files).toEqual(["dist", "extensions", "src", "examples", "README.md", "CHANGELOG.md", "LICENSE"]);
		// What npm would pack without building first (dist/ is checked by the build test and the release proof).
		const packed = packResult(
			execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
		);
		const paths: string[] = packed.files.map((file: { path: string }) => file.path);
		expect(paths).toEqual(expect.arrayContaining(["package.json", "README.md", "CHANGELOG.md", "LICENSE", "extensions/reply-reader.ts", "src/cli.ts"]));
		expect(paths).toContain("examples/reply-reader-desktop-audio.service");
		expect(paths).toContain("examples/reply-reader-vps-audio.service");
		const unwanted = paths.filter((path) => /^(odd|tests|bin|node_modules|\.atl)\/|^\.|\.tgz$|^pnpm-|^tsconfig/.test(path));
		expect(unwanted).toEqual([]);
	});
});

/** (S12) `build` starts from an empty dist/, so a file the sources no longer emit never reaches the tarball. */
describe("build in a copy of the package", () => {
	let copy: string;
	const stale = () => {
		mkdirSync(join(copy, "dist", "old"), { recursive: true });
		writeFileSync(join(copy, "dist", "old", "stale.js"), "export {};\n");
	};

	beforeAll(() => {
		copy = mkdtempSync(join(tmpdir(), "reply-reader-pack-"));
		for (const entry of ["package.json", "tsconfig.json", "tsconfig.build.json", "README.md", "CHANGELOG.md", "LICENSE", "bin", "src", "extensions", "examples"]) {
			cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
		}
		symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"), "dir");
	});

	afterAll(() => rmSync(copy, { recursive: true, force: true }));

	it("`npm run build` removes what an earlier build left in dist/ and emits the bin", () => {
		stale();
		execFileSync("npm", ["run", "build"], { cwd: copy, stdio: "pipe" });
		expect(existsSync(join(copy, "dist", "old", "stale.js"))).toBe(false);
		expect(existsSync(join(copy, "dist", "bin", "reply-reader.js"))).toBe(true);
	}, 120_000);

	it("`npm pack` builds first and packs dist/ without stale files", () => {
		stale();
		const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: copy, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		// Lifecycle scripts may print to stdout before npm's JSON.
		const packed = packResult(stdout.slice(stdout.search(/^[[{]$/m)));
		const paths: string[] = packed.files.map((file: { path: string }) => file.path);
		expect(paths).toEqual(expect.arrayContaining(["dist/bin/reply-reader.js", "dist/src/cli.js", "dist/src/speech-text.js"]));
		expect(paths.filter((path) => path.includes("stale"))).toEqual([]);
	}, 120_000);
});

describe("compiled reply-reader bin", () => {
	let out: string;
	let work: string;
	let bin: string;

	beforeAll(() => {
		out = mkdtempSync(join(tmpdir(), "reply-reader-build-"));
		work = mkdtempSync(join(tmpdir(), "reply-reader-work-"));
		// The same build as `npm run build`, written to a temp folder instead of dist/.
		execFileSync(process.execPath, [TSC, "-p", "tsconfig.build.json", "--outDir", out], { cwd: ROOT, stdio: "pipe" });
		bin = join(out, pkg.bin["reply-reader"].replace(/^\.\/dist\//, ""));
	}, 120_000);

	afterAll(() => {
		rmSync(out, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	});

	const run = (args: string[]) =>
		spawnSync(process.execPath, [bin, ...args], {
			cwd: work,
			encoding: "utf8",
			env: { PATH: work, HOME: join(work, "home"), XDG_CONFIG_HOME: join(work, "config"), XDG_DATA_HOME: join(work, "data") },
		});

	it("is JavaScript with a node shebang and no TypeScript imports", () => {
		expect(existsSync(bin)).toBe(true);
		const source = readFileSync(bin, "utf8");
		expect(source.split("\n")[0]).toBe("#!/usr/bin/env node");
		expect(source).toContain('from "../src/cli.js"');
		expect(readFileSync(join(out, "src", "cli.js"), "utf8")).not.toMatch(/from "\.[^"]*\.ts"/);
	});

	it("--help prints the usage and exits 0", () => {
		const result = run(["--help"]);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe(USAGE);
		expect(result.status).toBe(0);
	});

	it("a missing file prints why and exits 1", () => {
		const result = run(["nope.md"]);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe('Cannot read "nope.md": file not found.\n');
		expect(result.status).toBe(1);
	});

	it("bad arguments exit 2", () => {
		writeFileSync(join(work, "notes.md"), "Hola.");
		const result = run(["--speed", "9", "notes.md"]);
		expect(result.stderr).toBe("Speed must be a number from 0.5 to 2.0.\n");
		expect(result.status).toBe(2);
	});
});

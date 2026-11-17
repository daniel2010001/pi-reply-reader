import { describe, expect, it } from "vitest";
import { sectionFrom } from "../src/sections.ts";

const doc = [
	"# Reply reader",
	"",
	"Intro.",
	"",
	"## Install",
	"",
	"Run it.",
	"",
	"## Installation notes",
	"",
	"More.",
	"",
	"## Markdown files",
	"",
	"Read them.",
	"",
	"## One reading per machine",
	"",
	"Last wins.",
].join("\n");

describe("sectionFrom (S9)", () => {
	it("reads only the matching section: it stops at the next heading of the same level", () => {
		expect(sectionFrom(doc, "Markdown files")).toBe("## Markdown files\n\nRead them.");
	});

	it("includes deeper subheadings in the section", () => {
		expect(sectionFrom("## Uso\n\nA.\n\n### Detalle\n\nB.\n\n#### Más\n\nC.\n\n## Otra\n\nD.", "uso")).toBe(
			"## Uso\n\nA.\n\n### Detalle\n\nB.\n\n#### Más\n\nC.",
		);
	});

	it("stops at a heading of a higher level", () => {
		expect(sectionFrom("# Guía\n\n## Uso\n\nA.\n\n### Detalle\n\nB.\n\n# Apéndice\n\nC.", "detalle")).toBe("### Detalle\n\nB.");
	});

	it("the last section runs to the end", () => {
		expect(sectionFrom(doc, "one reading per machine")).toBe("## One reading per machine\n\nLast wins.");
	});

	it("a heading inside a code block does not end the section", () => {
		expect(sectionFrom("## Uso\n\n```md\n## Falso\n```\n\nA.\n\n## Otra\n\nB.", "uso")).toBe("## Uso\n\n```md\n## Falso\n```\n\nA.");
	});

	it("with rest, reads from the matching heading to the end", () => {
		expect(sectionFrom(doc, "Markdown files", { rest: true })).toBe(
			"## Markdown files\n\nRead them.\n\n## One reading per machine\n\nLast wins.",
		);
		expect(sectionFrom("# Guía\n\n## Uso\n\nA.\n\n# Apéndice\n\nC.", "uso", { rest: true })).toBe("## Uso\n\nA.\n\n# Apéndice\n\nC.");
	});

	it("an exact match wins over a prefix match of an earlier heading", () => {
		expect(sectionFrom("## Install guide\n\nA.\n\n## Install\n\nB.", "install")).toBe("## Install\n\nB.");
		expect(sectionFrom(doc, "install")?.split("\n")[0]).toBe("## Install");
	});

	it("accepts a prefix match when it is the only one", () => {
		expect(sectionFrom(doc, "markdown")?.split("\n")[0]).toBe("## Markdown files");
		expect(sectionFrom(doc, "installation")?.split("\n")[0]).toBe("## Installation notes");
	});

	it("rejects a prefix that matches more than one heading", () => {
		expect(sectionFrom("## Install guide\n\nA.\n\n## Install notes\n\nB.", "install")).toBeUndefined();
	});

	it("takes the first of several exact matches", () => {
		expect(sectionFrom("## Uso\n\nA.\n\n## Uso\n\nB.", "uso")).toBe("## Uso\n\nA.");
	});

	it("ignores case and accents, on both sides", () => {
		expect(sectionFrom("## Instalación\n\nPaso.", "INSTALACION")).toBe("## Instalación\n\nPaso.");
		expect(sectionFrom("## Instalacion\n\nPaso.", "instalación")).toBe("## Instalacion\n\nPaso.");
	});

	it("ignores leading numbering such as 2. or 5.2. or 3)", () => {
		expect(sectionFrom("## 2. Engram\n\nA.", "engram")).toBe("## 2. Engram\n\nA.");
		expect(sectionFrom("### 5.2. Título\n\nA.", "titulo")).toBe("### 5.2. Título\n\nA.");
		expect(sectionFrom("## 3) Uso\n\nA.", "uso")).toBe("## 3) Uso\n\nA.");
	});

	it("takes - as a space and ignores punctuation", () => {
		expect(sectionFrom(doc, "one-reading-per-machine")?.split("\n")[0]).toBe("## One reading per machine");
		expect(sectionFrom("## `/read-auto`: switch!\n\nA.", "read-auto switch")).toBe("## `/read-auto`: switch!\n\nA.");
		expect(sectionFrom("## **Qué cambió**\n\nA.", "que cambio")).toBe("## **Qué cambió**\n\nA.");
	});

	it("finds nothing when no heading matches, and ignores headings inside code blocks", () => {
		expect(sectionFrom(doc, "usage")).toBeUndefined();
		expect(sectionFrom("Text.\n\n```md\n## Usage\n```\n", "usage")).toBeUndefined();
		expect(sectionFrom("Usage is plain text.", "usage")).toBeUndefined();
	});
});

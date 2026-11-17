import { describe, expect, it } from "vitest";
import { questionsSection } from "../src/questions.ts";

describe("questionsSection (S8)", () => {
	it("returns the closing Needs your decision heading and what follows it", () => {
		expect(questionsSection("Hecho.\n\n## Needs your decision\n\n1. ¿Seguimos?\n2. ¿Publicamos?\n")).toBe(
			"## Needs your decision\n\n1. ¿Seguimos?\n2. ¿Publicamos?",
		);
	});

	it("accepts a bold-only line, with or without a colon, in any case", () => {
		expect(questionsSection("Hecho.\n\n**Needs your decision:**\n- ¿A o B?")).toBe("**Needs your decision:**\n- ¿A o B?");
		expect(questionsSection("Hecho.\n\n__needs your decision__\n- ¿A?")).toBe("__needs your decision__\n- ¿A?");
		expect(questionsSection("Hecho.\n\n### NEEDS YOUR DECISION:\n- ¿A?")).toBe("### NEEDS YOUR DECISION:\n- ¿A?");
	});

	it("takes the last such section when there are several", () => {
		expect(questionsSection("## Needs your decision\n\n1. ¿Viejo?\n\nMás.\n\n## Needs your decision\n\n1. ¿Nuevo?")).toBe(
			"## Needs your decision\n\n1. ¿Nuevo?",
		);
	});

	it("finds nothing without the section, in prose, or inside a code block", () => {
		expect(questionsSection("Hecho.\n\n## Siguiente\n\nNada.")).toBeUndefined();
		expect(questionsSection("This Needs your decision soon.")).toBeUndefined();
		expect(questionsSection("Hecho.\n\n```md\n## Needs your decision\n1. ¿A?\n```")).toBeUndefined();
	});
});

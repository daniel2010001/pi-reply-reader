import { describe, expect, it } from "vitest";
import { speechText } from "../src/speech-text.ts";

describe("speechText", () => {
	it("leaves plain prose untouched", () => {
		expect(speechText("Hola, esto es texto normal. 2 * 3 * 4 = 24.")).toBe(
			"Hola, esto es texto normal. 2 * 3 * 4 = 24.",
		);
	});

	it("drops emphasis markers and keeps the words", () => {
		expect(speechText("Esto es **negrilla**, __también__, *cursiva*, _esta_ y ~~tachado~~.")).toBe(
			"Esto es negrilla, también, cursiva, esta y tachado.",
		);
	});

	it("speaks a heading as its text, closed as a sentence", () => {
		expect(speechText("## Needs your decision\n\nTexto.")).toBe("Needs your decision.\n\nTexto.");
	});

	it("drops bullet, number punctuation and checkbox markers", () => {
		expect(speechText("- uno\n* dos\n+ tres\n1) cuatro\n- [x] hecho\n- [ ] pendiente")).toBe(
			"uno.\ndos.\ntres.\n1. cuatro.\nhecho.\npendiente.",
		);
	});

	it("speaks a table row by row, without pipes or the separator", () => {
		expect(speechText("| Col 1 | Col 2 | Col 3 |\n|---|:---:|---|\n| a | **b** | c |\n| d | | f |")).toBe(
			"Col 1, Col 2, Col 3.\na, b, c.\nd, f.",
		);
	});

	it("speaks inline code without backticks and with identifier underscores as spaces", () => {
		expect(speechText("Usá `speechText` y `auto_read` en `src/speech-text.ts`.")).toBe(
			"Usá speechText y auto read en src/speech-text.ts.",
		);
	});

	it("keeps emphasis markers inside inline code out of the emphasis rule", () => {
		expect(speechText("Probá `a*b*c` ahora.")).toBe("Probá a*b*c ahora.");
	});

	it("unwraps emphasis that contains inline code", () => {
		expect(speechText("**El `SESSION_SECRET` no hace falta.** Listo, *usá `main`*.")).toBe(
			"El SESSION SECRET no hace falta. Listo, usá main.",
		);
	});

	it("announces a fenced code block instead of reading it", () => {
		expect(speechText("Corré esto:\n\n```bash\npnpm test -- --run\n```\n\nListo.\n\n~~~\nx\n~~~\nY sin cerrar:\n```\ny")).toBe(
			"Corré esto:\n\nBloque de código.\n\nListo.\n\nBloque de código.\nY sin cerrar:\nBloque de código.",
		);
	});

	it("speaks a link as its text and a bare or angle URL as its host", () => {
		expect(
			speechText(
				"Ver [la guía](https://pi.dev/docs \"t\"), ![logo](a.png), <https://www.github.com/x> y https://npmjs.com/package/pi-reply-reader.",
			),
		).toBe("Ver la guía, logo, github.com y npmjs.com.");
	});

	it("keeps emphasis markers out of a bold URL", () => {
		expect(speechText("Abrí **https://github.com/x/y/pull/1**.")).toBe("Abrí github.com.");
	});

	it("speaks identifier underscores in prose as spaces", () => {
		expect(speechText("Que ckan_admin vea __esto__.")).toBe("Que ckan admin vea esto.");
	});

	it("drops reference link definitions and keeps reference link text", () => {
		expect(speechText("Leé [el issue][1].\n\n[1]: https://github.com/x/y/issues/1")).toBe("Leé el issue.");
	});

	it("drops blockquote markers and horizontal rules", () => {
		expect(speechText("> citado\n> > anidado\n\n---\n\n***\nfin")).toBe("citado\nanidado\n\nfin");
	});

	it("unescapes backslash-escaped characters", () => {
		expect(speechText("Un \\*literal\\* y un \\_guion\\_.")).toBe("Un *literal* y un _guion_.");
	});

	it("is deterministic and collapses blank runs", () => {
		const input = "# A\n\n\n\nB\n\n";
		expect(speechText(input)).toBe("A.\n\nB");
		expect(speechText(input)).toBe(speechText(input));
	});
});

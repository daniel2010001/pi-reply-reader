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
			"Usá speechText y auto read en src speech text punto ts.",
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

	it("collapses runs of spaces and tabs left by removed markers", () => {
		expect(speechText("Hola  **mundo**\t\ty  `x`   chau")).toBe("Hola mundo y x chau");
	});

	it("speaks dotted reply IDs as their parts", () => {
		expect(speechText("Citó P11.R1.Q1 a Q5, ver P11.R1 y `P12.R3.Q2`.")).toBe(
			"Citó P 11, R 1, Q 1 a Q5, ver P 11, R 1 y P 12, R 3, Q 2.",
		);
	});

	it("speaks symbols as words", () => {
		expect(speechText("s llena R: Sí. o → Sí. según el formato (→).")).toBe("s llena R: Sí. o a Sí. según el formato (a).");
		expect(speechText("a ⇒ b ➜ c ← d, la sugerencia ≈.")).toBe("a a b a c desde d, la sugerencia aproximadamente.");
		expect(speechText("x ≠ y, n ≥ 2, n ≤ 5, ± 3, 1920×1080, 3 × 4, R&D y `a && b`.")).toBe(
			"x distinto de y, n mayor o igual a 2, n menor o igual a 5, más o menos 3, 1920 por 1080, 3 por 4, R y D y a y b.",
		);
	});

	it("drops emoji and pictographs", () => {
		expect(speechText("- ✅ Hecho 🎉.\nListo 👍🏽, `ok ✨` y 🇦🇷 fin")).toBe("Hecho.\nListo, ok y fin");
	});

	it("speaks paths and branches as words, in prose and inline code", () => {
		expect(speechText("Creé ~/.gentle-shell/agent/AGENTS.md, en la rama feat/pending-central.")).toBe(
			"Creé gentle shell agent AGENTS punto md, en la rama feat pending central.",
		);
		expect(speechText("Abrí `~/.gentle-shell/agent/AGENTS.md`, `feat/pending-central`, `./src/auto_read.ts` y luego /replies.")).toBe(
			"Abrí gentle shell agent AGENTS punto md, feat pending central, src auto read punto ts y luego replies.",
		);
	});

	it("keeps fractions and y/o-style words as they are", () => {
		expect(speechText("Leé 1/2 o `3/4` y/o and/or.")).toBe("Leé 1/2 o 3/4 y/o and/or.");
	});

	it("keeps URL hosts unchanged next to the path rule", () => {
		expect(speechText("Ver https://github.com/x/y/pull/1 y <https://pi.dev/docs/a>.")).toBe("Ver github.com y pi.dev.");
		expect(speechText("Abrí `http://localhost:8082/dev/sticky?barra=columna&alto=bajo` → listo.")).toBe(
			"Abrí http://localhost:8082/dev/sticky?barra=columna&alto=bajo a listo.",
		);
	});

	it("keeps plain numbers, dates and versions unchanged", () => {
		expect(speechText("Son 1,044 respuestas, 42 tests y 3.5 s.")).toBe("Son 1,044 respuestas, 42 tests y 3.5 s.");
		expect(speechText("El 2026-10-27 y `2026-10-27`.")).toBe("El 2026-10-27 y 2026-10-27.");
		expect(speechText("Versiones 1.13.8, v2.0.1 y `sherpa-onnx-node@2.0.1`.")).toBe(
			"Versiones 1.13.8, v2.0.1 y sherpa-onnx-node@2.0.1.",
		);
	});

	it("still announces a fenced block that holds paths and symbols", () => {
		expect(speechText("Así:\n```\ncat ~/.x/y.md → ✅\n```")).toBe("Así:\nBloque de código.");
	});

	it("is deterministic and collapses blank runs", () => {
		const input = "# A\n\n\n\nB\n\n";
		expect(speechText(input)).toBe("A.\n\nB");
		expect(speechText(input)).toBe(speechText(input));
	});
});

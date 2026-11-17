import { describe, expect, it } from "vitest";
import { detectLanguage, speechReading, speechText } from "../src/speech-text.ts";

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
		expect(speechText("## Qué cambió\n\nTexto.")).toBe("Qué cambió.\n\nTexto.");
	});

	it("drops bullet, number punctuation and checkbox markers", () => {
		expect(speechText("- uno\n* dos\n+ tres\n1) cuatro\n- [x] hecho\n- [ ] pendiente")).toBe(
			"uno.\ndos.\ntres.\n1: cuatro.\nhecho.\npendiente.",
		);
	});

	it("speaks a table row by row, without pipes or the separator", () => {
		expect(speechText("| Col 1 | Col 2 | Col 3 |\n|---|:---:|---|\n| a | **b** | c |\n| d | | f |")).toBe(
			"Col 1, Col 2, Col 3.\na, b, c.\nd, f.",
		);
	});

	it("speaks inline code without backticks and with identifier underscores as spaces", () => {
		expect(speechText("Usá `speechText` y `auto_read` en `src/speech-text.ts`.")).toBe(
			"Usá speechText y auto read en speech text punto ts, en src.",
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

	it("speaks paths and branches by class, in prose and inline code", () => {
		expect(speechText("Creé ~/.gentle-shell/agent/AGENTS.md, en la rama feat/pending-central.")).toBe(
			"Creé AGENTS punto md, en agent, en la rama feat pending central.",
		);
		expect(speechText("Abrí `~/.gentle-shell/agent/AGENTS.md`, `feat/pending-central`, `./src/auto_read.ts` y luego /replies.")).toBe(
			"Abrí AGENTS punto md, en agent, la rama feat pending central, auto read punto ts, en src y luego el comando replies.",
		);
	});

	it("(e2) speaks a branch as its name words, adding 'la rama' only when it is not said already", () => {
		expect(speechText("Estoy en la rama `feat/pending-central`.")).toBe("Estoy en la rama feat pending central.");
		expect(speechText("Mergeé `origin/main` y la rama `origin/main` en el branch fix/x.")).toBe(
			"Mergeé la rama origin main y la rama origin main en el branch fix x.",
		);
	});

	it("(e3) speaks path:N as the file reading plus its line", () => {
		expect(speechText("Mirá `src/speech-text.ts:42`.")).toBe("Mirá speech text punto ts, en src, línea 42.");
	});

	it("(e4) speaks a path as its last part plus its folder", () => {
		expect(speechText("`~/.gentle-shell/agent/AGENTS.md`")).toBe("AGENTS punto md, en agent");
		expect(speechText("Los WAV están en `/tmp/reply-reader-bakeoff/wav/hs/`.")).toBe(
			"Los WAV están en la carpeta hs, en wav.",
		);
		expect(speechText("Revisé `~/.gentle-shell`.")).toBe("Revisé la carpeta gentle shell.");
		expect(speechText("Borrá la carpeta `~/.cache/ms-playwright`.")).toBe("Borrá la carpeta ms playwright, en cache.");
	});

	it("(e5) speaks two letter-only parts as alternatives", () => {
		expect(speechText("Elegí `light/dark`, y/o km/h.")).toBe("Elegí light o dark, y/o km/h.");
	});

	it("(e6) speaks a single /word as a command", () => {
		expect(speechText("Corré `/reload`")).toBe("Corré el comando reload");
		expect(speechText("Usá el comando `/usage`.")).toBe("Usá el comando usage.");
	});

	it("(e7) speaks a bare file name with 'punto', leaving versions, numbers and URL hosts", () => {
		expect(speechText("`README.md`")).toBe("README punto md");
		expect(speechText("Leé `README.md`. Y CHANGELOG.md, v2.0.1, 3.5 y https://pi.dev/docs.")).toBe(
			"Leé README punto md. Y CHANGELOG punto md, v2.0.1, 3 punto 5 y pi.dev.",
		);
		expect(speechText("Desde `422773f..HEAD`.")).toBe("Desde 422773f..HEAD.");
	});

	it("(e8) drops a commit hash after 'commit' and calls it 'un commit' elsewhere", () => {
		expect(speechText("commit `0e8bb95`")).toBe("commit");
		expect(speechText("Quedó en el commit `0e8bb95`. Revertí `12a88a0` y los commits 4cf2cac.")).toBe(
			"Quedó en el commit. Revertí un commit y los commits.",
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

	it("keeps plain numbers, dates and tagged versions unchanged; (h1) reads dotted numbers with 'punto'", () => {
		expect(speechText("Son 1,044 respuestas, 42 tests y 3.5 s.")).toBe("Son 1,044 respuestas, 42 tests y 3 punto 5 segundos.");
		expect(speechText("El 2026-10-27 y `2026-10-27`.")).toBe("El 2026-10-27 y 2026-10-27.");
		expect(speechText("Versiones 1.13.8, v2.0.1 y `sherpa-onnx-node@2.0.1`.")).toBe(
			"Versiones 1 punto 13 punto 8, v2.0.1 y sherpa-onnx-node@2.0.1.",
		);
	});

	it("still announces a fenced block that holds paths and symbols", () => {
		expect(speechText("Así:\n```\ncat ~/.x/y.md → ✅\n```")).toBe("Así:\nBloque de código.");
	});

	it("contracts de el and a el, but not before él", () => {
		expect(speechText("Después de `/reload` vuelve a `/read`.")).toBe("Después del comando reload vuelve al comando read.");
		expect(speechText("Hablale a él o de él.")).toBe("Hablale a él o de él.");
	});

	it("reads top-level system folders as folders, not commands", () => {
		expect(speechText("Está en `/tmp`, no en /home ni en la carpeta `/etc`.")).toBe(
			"Está en la carpeta tmp, no en la carpeta home ni en la carpeta etc.",
		);
	});

	it("(f1) speaks ~ right before a number as 'aproximadamente', whatever the noun's gender", () => {
		expect(speechText("~1,2 s")).toBe("aproximadamente 1,2 segundos");
		expect(speechText("~99%")).toBe("aproximadamente 99 por ciento");
		expect(speechText("Pasa las ~400 líneas en ~1 ms.")).toBe("Pasa las aproximadamente 400 líneas en aproximadamente 1 milisegundo.");
		expect(speechText("| Pausa | ~0,33 s |\n|---|---|\n| Total | ~24 s (~5 min) |")).toBe(
			"Pausa, aproximadamente 0,33 segundos.\nTotal, aproximadamente 24 segundos (aproximadamente 5 minutos).",
		);
	});

	it("(f2) speaks units right after a number as words", () => {
		expect(speechText("Tarda 1 s, 2,5 s, 250 ms, 3 min, 12 KB, 4,5 MB, 2 GB, 80%, -16 dB y -1 dBFS.")).toBe(
			"Tarda 1 segundo, 2,5 segundos, 250 milisegundos, 3 minutos, 12 kilobytes, 4,5 megabytes, 2 gigabytes, 80 por ciento, -16 decibeles y -1 decibel.",
		);
		expect(speechText("En `1.5s` y 30ms.")).toBe("En 1 punto 5 segundos y 30 milisegundos.");
		expect(speechText("1 ms, 1 min, 1 KB, 1 MB, 1 GB, 1 dB, 1% y 1,0 s.")).toBe(
			"1 milisegundo, 1 minuto, 1 kilobyte, 1 megabyte, 1 gigabyte, 1 decibel, 1 por ciento y 1,0 segundos.",
		);
	});

	it("(f1)/(f2) leave versions, dates, ~/ paths, URLs and unit-like words without a number alone", () => {
		expect(speechText("Versión 1.13.8, el 2026-10-28, en `~/.gentle-shell` y ~/x/y.md.")).toBe(
			"Versión 1 punto 13 punto 8, el 2026-10-28, en la carpeta gentle shell y y punto md, en x.",
		);
		expect(speechText("Ver https://x.dev/a?b=~1&c=5%20s y los s, 3 semanas, 2 minas, v2 s, R1 ms.")).toBe(
			"Ver x.dev y los s, 3 semanas, 2 minas, v2 s, R1 ms.",
		);
		expect(speechText("Usá `%d`, `printf(\"%s\")` y a~1.")).toBe('Usá %d, printf("%s") y a~1.');
	});

	it("(f3) speaks inline code holding a single punctuation mark by name", () => {
		expect(speechText("solo en `.`, `!`, `?` y saltos")).toBe("solo en punto, signo de exclamación, signo de pregunta y saltos");
		expect(speechText("`,` `;` `:` `~` `/` `-` `_` `*` `#` ` . `")).toBe(
			"coma punto y coma dos puntos virgulilla barra guion guion bajo asterisco numeral punto",
		);
		expect(speechText("Una | barra: `|`.")).toBe("Una | barra: barra vertical.");
		expect(speechText("Pero `..` y `a.` quedan.")).toBe("Pero .. y a. quedan.");
	});

	it("(f4) reads a line made entirely of emphasis like a heading", () => {
		expect(speechText("**Qué cambió**\n- uno")).toBe("Qué cambió.\n\nuno.");
		expect(speechText("*Nota*\nTexto.")).toBe("Nota.\n\nTexto.");
		expect(speechText("__X__\nY")).toBe("X.\n\nY");
		expect(speechText("**a** y **b**\nc")).toBe("a y b\nc");
	});

	it("(f5) follows headings and bold-only lines with a section break, never after the last line", () => {
		expect(speechText("## Título\nTexto.")).toBe("Título.\n\nTexto.");
		expect(speechText("# A\n**B**\nC")).toBe("A.\n\nB.\n\nC");
		expect(speechText("Texto.\n## Fin")).toBe("Texto.\nFin.");
		expect(speechText("Texto.\n**Fin**")).toBe("Texto.\nFin.");
	});

	it("(g1) speaks an ordered list marker as \"N:\" so playback does not cut after the number", () => {
		expect(speechText("1. Después\n2) Luego")).toBe("1: Después.\n2: Luego.");
		expect(speechText("Versión 2. Luego sigue.")).toBe("Versión 2. Luego sigue.");
		expect(speechText("## 1. Estado de gsh\n**2. Engram listo.** Bajé todo.")).toBe("1: Estado de gsh.\n\n2: Engram listo. Bajé todo.");
	});

	it("(g2) undoes a contraction before an article a reading inserts", () => {
		expect(speechText("Después del `/reload`, listo.")).toBe("Después del comando reload, listo.");
		expect(speechText("Volvé al `/read`.")).toBe("Volvé al comando read.");
		expect(speechText("Viene del `feat/pending-central`.")).toBe("Viene de la rama feat pending central.");
		expect(speechText("Del `origin/main` sale.")).toBe("De la rama origin main sale.");
		expect(speechText("Pasá al `/tmp/a/b/`.")).toBe("Pasá a la carpeta b, en a.");
		expect(speechText("Es del `4141c6d`.")).toBe("Es de un commit.");
		expect(speechText("Corré de `/reload`.")).toBe("Corré del comando reload.");
		expect(speechText("Lo dijo de él.")).toBe("Lo dijo de él.");
	});

	it("(g3) speaks the closing \"Needs your decision\" heading in Spanish", () => {
		expect(speechText("## Needs your decision\n1. ¿Seguimos?")).toBe("Decisiones pendientes.\n\n1: ¿Seguimos?");
		expect(speechText("**Needs your decision:**\n1. ¿Sí?")).toBe("Decisiones pendientes.\n\n1: ¿Sí?");
		expect(speechText("Needs your decision")).toBe("Needs your decision");
	});

	it("(h1) reads a number with dots with 'punto'", () => {
		expect(speechText("Versión 1.1 y 0.8.0, con 3.5 s y ~1.5 MB.")).toBe(
			"Versión 1 punto 1 y 0 punto 8 punto 0, con 3 punto 5 segundos y aproximadamente 1 punto 5 megabytes.",
		);
		expect(speechText("Usá `1.13.8` (o 2.1).")).toBe("Usá 1 punto 13 punto 8 (o 2 punto 1).");
		expect(speechText("Un contraste de 4.5:1, a las 22:48.")).toBe("Un contraste de 4 punto 5:1, a las 22:48.");
	});

	it("(h1) turns the period after a dotted number ending a numbered heading, bold line or item into ':'", () => {
		expect(speechText("## 5.2. Título\nTexto.")).toBe("5 punto 2: Título.\n\nTexto.");
		expect(speechText("**1.1. Engram**\n5.2. Después")).toBe("1 punto 1: Engram.\n\n5 punto 2: Después");
		expect(speechText("## 5.2 Título")).toBe("5 punto 2 Título.");
	});

	it("(h1) keeps Spanish thousands as they are", () => {
		expect(speechText("Son 2.750 respuestas y 1.500.000 bytes, no 0.750 ni 2.75.")).toBe(
			"Son 2.750 respuestas y 1.500.000 bytes, no 0 punto 750 ni 2 punto 75.",
		);
	});

	it("(h1) leaves reply IDs to their own reading", () => {
		expect(speechText("En P11.R1.Q1 y `P2.R10`, versión 1.1.")).toBe("En P 11, R 1, Q 1 y P 2, R 10, versión 1 punto 1.");
	});

	it("(h1) leaves URLs to their own reading", () => {
		expect(speechText("Ver https://10.0.0.1:8080/v/1.2 y `https://x.dev/r/1.2.3`, en 1.2.")).toBe("Ver 10.0.0.1:8080 y https://x.dev/r/1.2.3, en 1 punto 2.");
	});

	it("(h1) leaves file names to their own reading", () => {
		expect(speechText("Abrí `1.2.md`, `notas-1.2.md` y 2.0.1.tgz de la 2.0.1.")).toBe("Abrí 1.2.md, notas 1 punto 2 punto md y 2.0.1.tgz de la 2 punto 0 punto 1.");
	});

	it("(h1) leaves paths to their own reading", () => {
		expect(speechText("Está en `src/1.2/a.ts` y en `~/v/1.2.3/` desde la 1.2.")).toBe("Está en a punto ts, en 1.2 y en la carpeta 1.2.3, en v desde la 1 punto 2.");
	});

	it("(h1) keeps IP addresses as they are", () => {
		expect(speechText("El hs es 192.168.1.22 y el desktop `tcp:10.42.0.145:4713`, no 1.2.3 ni 300.1.1.1.")).toBe(
			"El hs es 192.168.1.22 y el desktop tcp:10.42.0.145:4713, no 1 punto 2 punto 3 ni 300 punto 1 punto 1 punto 1.",
		);
	});

	it("(h1) keeps the period of a number ending a sentence", () => {
		expect(speechText("Ahora son 1.1. Luego 2.0.")).toBe("Ahora son 1 punto 1. Luego 2 punto 0.");
	});

	it("is deterministic and collapses blank runs", () => {
		const input = "# A\n\n\n\nB\n\n";
		expect(speechText(input)).toBe("A.\n\nB");
		expect(speechText(input)).toBe(speechText(input));
	});
});

describe("S7: language of the added words", () => {
	it("classifies a Spanish reply, an English README and a tie as Spanish unless English words win", () => {
		expect(detectLanguage("## Qué cambió\n\nEl comando `/read` lee la última respuesta y se detiene con Esc.")).toBe("es");
		expect(
			detectLanguage(
				"# pi-reply-reader\n\nRead a Pi reply aloud, only when you ask. The output can be this machine's speakers.\n\n```sh\nla de el que y en los\n```",
			),
		).toBe("en");
		// One function word of each language ("the", "la"): Spanish wins ties.
		expect(detectLanguage("the casa la house")).toBe("es");
		// Code, URLs and paths do not count: only "el" and "the" are left, a tie.
		expect(detectLanguage("El `the and of to is` the https://x.dev/the/and/of ~/the/and/of.md")).toBe("es");
		expect(detectLanguage("")).toBe("es");
		// The closing "Needs your decision" heading of every reply here does not count either.
		expect(detectLanguage("## Needs your decision\n1. ¿Seguimos?")).toBe("es");
		expect(detectLanguage("**Needs your decision:**\nOk.")).toBe("es");
	});

	it("returns the cleaned text with its language; speechText still returns the text", () => {
		const markdown = "Run `/reload` and then read the reply again.";
		expect(speechReading(markdown)).toEqual({ text: "Run the command reload and then read the reply again.", language: "en" });
		expect(speechText(markdown)).toBe(speechReading(markdown).text);
		expect(speechReading("Corré `/reload` y leé la respuesta.")).toEqual({ text: "Corré el comando reload y leé la respuesta.", language: "es" });
	});

	it("announces a fenced code block in English", () => {
		expect(speechText("Run this in the terminal:\n\n```bash\npnpm test\n```\n\nThat is all.")).toBe(
			"Run this in the terminal:\n\nCode block.\n\nThat is all.",
		);
	});

	it("reads a command in English", () => {
		expect(speechText("Run `/reload` in the terminal, then use the command `/usage`.")).toBe(
			"Run the command reload in the terminal, then use the command usage.",
		);
	});

	it("reads folders and system folders in English", () => {
		expect(speechText("The WAV files are in `/tmp/reply-reader-bakeoff/wav/hs/`, not in `/tmp`.")).toBe(
			"The WAV files are in the folder hs, in wav, not in the folder tmp.",
		);
		expect(speechText("Remove the folder `~/.cache/ms-playwright` and `~/.gentle-shell` from the disk.")).toBe(
			"Remove the folder ms playwright, in cache and the folder gentle shell from the disk.",
		);
	});

	it("reads files and paths in English", () => {
		expect(speechText("Edit `~/.gentle-shell/agent/AGENTS.md` and the `README.md` for this.")).toBe(
			"Edit AGENTS dot md, in agent and the README dot md for this.",
		);
	});

	it("reads branches in English", () => {
		expect(speechText("Merge `origin/main` into the branch `feat/pending-central`.")).toBe(
			"Merge the branch origin main into the branch feat pending central.",
		);
	});

	it("reads commit hashes in English", () => {
		expect(speechText("It is in the commit `0e8bb95`, and I reverted `12a88a0` with that.")).toBe(
			"It is in the commit, and I reverted a commit with that.",
		);
	});

	it("reads a path with a line in English", () => {
		expect(speechText("See `src/speech-text.ts:42` for the rule.")).toBe("See speech text dot ts, in src, line 42 for the rule.");
	});

	it("reads approximations in English", () => {
		expect(speechText("It takes ~400 lines and the ~ is kept in `a~1` for the path.")).toBe(
			"It takes approximately 400 lines and the ~ is kept in a~1 for the path.",
		);
	});

	it("reads units in English, singular after 1", () => {
		expect(speechText("It takes 2,5 s, 250 ms, 3 min, 12 KB, 4 MB, 2 GB, 80%, -16 dB and -3 dBFS for the run.")).toBe(
			"It takes 2,5 seconds, 250 milliseconds, 3 minutes, 12 kilobytes, 4 megabytes, 2 gigabytes, 80 percent, -16 decibels and -3 decibels for the run.",
		);
		expect(speechText("It is 1 s, 1 ms, 1 min, 1 KB, 1 MB, 1 GB, 1% and 1 dB for the run.")).toBe(
			"It is 1 second, 1 millisecond, 1 minute, 1 kilobyte, 1 megabyte, 1 gigabyte, 1 percent and 1 decibel for the run.",
		);
	});

	it("reads punctuation marks by name in English", () => {
		expect(speechText("The marks are `.` `,` `;` `:` `!` `?` `~` `/` `-` `_` `*` `#` `|` in the text.")).toBe(
			"The marks are period comma semicolon colon exclamation mark question mark tilde slash hyphen underscore asterisk hash pipe in the text.",
		);
	});

	it("reads symbols in English", () => {
		expect(speechText("The flow is a → b ← c, and x ≈ y, x ≠ y, n ≥ 2, n ≤ 5, ± 3, 3 × 4, R&D with the rest.")).toBe(
			"The flow is a to b from c, and x approximately y, x not equal to y, n greater than or equal to 2, n less than or equal to 5, plus or minus 3, 3 times 4, R and D with the rest.",
		);
	});

	it("reads alternatives in English", () => {
		expect(speechText("Pick the `light/dark` theme, and/or the km/h unit.")).toBe("Pick the light or dark theme, and/or the km/h unit.");
	});

	it("reads dotted numbers with 'point' in English, numbered headings with ':'", () => {
		expect(speechText("The version is 1.1 and the next is 0.8.0, with the 2.750 rate.")).toBe(
			"The version is 1 point 1 and the next is 0 point 8 point 0, with the 2 point 750 rate.",
		);
		expect(speechText("## 5.2. The title\nThis is the text.")).toBe("5 point 2: The title.\n\nThis is the text.");
	});

	it("reads Spanish thousands as a decimal in English", () => {
		expect(speechText("The rate is 2.750 and the total is 1.500.000 for the run.")).toBe(
			"The rate is 2 point 750 and the total is 1 point 500 point 000 for the run.",
		);
	});

	it("does not double a command's noun when it follows the token in English", () => {
		expect(speechText("Use the `/read` command, then the **`/reload`** command and /usage command in the terminal.")).toBe(
			"Use the read command, then the reload command and usage command in the terminal.",
		);
		// Only the noun right after the token counts, not one after a comma.
		expect(speechText("Run `/read`, and the command for the rest.")).toBe("Run the command read, and the command for the rest.");
	});

	it("does not double a branch's noun when it follows the token in English", () => {
		expect(speechText("Merge the `feat/x` branch and the origin/main branch into the release.")).toBe(
			"Merge the feat x branch and the origin main branch into the release.",
		);
	});

	it("does not double a folder's noun when it follows the token in English", () => {
		expect(speechText("Open the `src/` folder, the `/tmp` folder and the `/tmp/a/b/` folder for the files.")).toBe(
			"Open the src folder, the tmp folder and the b folder for the files.",
		);
	});

	it("keeps the commit drop rule in English", () => {
		expect(speechText("It is the commit `abc1234`, and the `abc1234` commit is the same.")).toBe(
			"It is the commit, and the a commit commit is the same.",
		);
	});

	it("keeps the Spanish noun-before readings, with no doubling", () => {
		expect(speechText("Usá el comando `/read`, la rama `feat/x` y la carpeta `/tmp/a/b/` con el commit `abc1234`.")).toBe(
			"Usá el comando read, la rama feat x y la carpeta b, en a con el commit.",
		);
	});

	it("keeps reply IDs as in Spanish", () => {
		expect(speechText("This is in P11.R1.Q1 and the `P2.R10` reply.")).toBe("This is in P 11, R 1, Q 1 and the P 2, R 10 reply.");
	});

	it("does not apply Spanish-only rules to English text", () => {
		expect(speechText("Then go back to `/read` from the menu, and to `/tmp/a/b/` for the files.")).toBe(
			"Then go back to the command read from the menu, and to the folder b, in a for the files.",
		);
		expect(speechText("## Needs your decision\n1. Do you want the change?")).toBe("Needs your decision.\n\n1: Do you want the change?");
		expect(speechText("I said a el and de el in the text of the page for the user.")).toBe(
			"I said a el and de el in the text of the page for the user.",
		);
	});
});

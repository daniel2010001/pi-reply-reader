import { describe, expect, it } from "vitest";
import { detectLanguage, narrationPlan, renderNarration, speechNarration, speechReading, speechText, spokenFragments } from "../src/speech-text.ts";

describe("speechText", () => {
	it("leaves plain prose untouched", () => {
		expect(speechText("Hola, esto es texto normal. 2 * 3 * 4 = 24.")).toBe(
			"Hola, esto es texto normal. dos * tres * cuatro = veinticuatro.",
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
			"uno.\ndos.\ntres.\nuno: cuatro.\nhecho.\npendiente.",
		);
	});

	it("speaks a table row by row, without pipes or the separator", () => {
		expect(speechText("| Col 1 | Col 2 | Col 3 |\n|---|:---:|---|\n| a | **b** | c |\n| d | | f |")).toBe(
			"Col uno, Col dos, Col tres.\na, b, c.\nd, f.",
		);
	});

	it("speaks inline code without backticks and with identifier underscores as spaces", () => {
		expect(speechText("Usá `speechText` y `auto_read` en `src/speech-text.ts`.")).toBe(
			"Usá speechText y auto read en speech text punto ts, en src.",
		);
	});

	it("keeps emphasis markers inside inline code out of the emphasis rule", () => {
		expect(speechText("Probá `a*b*c` ahora.")).toBe("Probá a algo b algo c ahora.");
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
			"Citó P once, R uno, Q uno a Q cinco, ver P once, R uno y P doce, R tres, Q dos.",
		);
	});

	it("speaks symbols as words", () => {
		expect(speechText("s llena R: Sí. o → Sí. según el formato (→).")).toBe("s llena R: Sí. o a Sí. según el formato (a).");
		expect(speechText("a ⇒ b ➜ c ← d, la sugerencia ≈.")).toBe("a a b a c desde d, la sugerencia aproximadamente.");
		expect(speechText("x ≠ y, n ≥ 2, n ≤ 5, ± 3, 1920×1080, 3 × 4, R&D y `a && b`.")).toBe(
			"x distinto de y, n mayor o igual a dos, n menor o igual a cinco, más o menos tres, mil novecientos veinte por mil ochenta, tres por cuatro, R y D y a y b.",
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
		expect(speechText("Mirá `src/speech-text.ts:42`.")).toBe("Mirá speech text punto ts, en src, línea cuarenta y dos.");
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
			"Leé README punto md. Y CHANGELOG punto md, v dos punto cero punto uno, tres punto cinco y pi.dev.",
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
		expect(speechText("Leé 1/2 o `3/4` y/o and/or.")).toBe("Leé uno/dos o tres/cuatro y/o and/or.");
	});

	it("keeps URL hosts unchanged next to the path rule", () => {
		expect(speechText("Ver https://github.com/x/y/pull/1 y <https://pi.dev/docs/a>.")).toBe("Ver github.com y pi.dev.");
		expect(speechText("Abrí `http://localhost:8082/dev/sticky?barra=columna&alto=bajo` → listo.")).toBe(
			"Abrí http://localhost:8082/dev/sticky?barra=columna&alto=bajo a listo.",
		);
	});

	it("keeps plain numbers, dates and tagged versions unchanged; (h1) reads dotted numbers with 'punto'", () => {
		expect(speechText("Son 1,044 respuestas, 42 tests y 3.5 s.")).toBe("Son uno coma cero cuatro cuatro respuestas, cuarenta y dos tests y tres punto cinco segundos.");
		expect(speechText("El 2026-10-27 y `2026-10-27`.")).toBe("El veintisiete de octubre de dos mil veintiséis y veintisiete de octubre de dos mil veintiséis.");
		expect(speechText("Versiones 1.13.8, v2.0.1 y `sherpa-onnx-node@2.0.1`.")).toBe(
			"Versiones uno punto trece punto ocho, v dos punto cero punto uno y sherpa-onnx-node@2.0.1.",
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
		expect(speechText("~1,2 s")).toBe("aproximadamente uno coma dos segundos");
		expect(speechText("~99%")).toBe("aproximadamente noventa y nueve por ciento");
		expect(speechText("Pasa las ~400 líneas en ~1 ms.")).toBe("Pasa las aproximadamente cuatrocientas líneas en aproximadamente un milisegundo.");
		expect(speechText("| Pausa | ~0,33 s |\n|---|---|\n| Total | ~24 s (~5 min) |")).toBe(
			"Pausa, aproximadamente cero coma treinta y tres segundos.\nTotal, aproximadamente veinticuatro segundos (aproximadamente cinco minutos).",
		);
	});

	it("(f2) speaks units right after a number as words", () => {
		expect(speechText("Tarda 1 s, 2,5 s, 250 ms, 3 min, 12 KB, 4,5 MB, 2 GB, 80%, -16 dB y -1 dBFS.")).toBe(
			"Tarda un segundo, dos coma cinco segundos, doscientos cincuenta milisegundos, tres minutos, doce kilobytes, cuatro coma cinco megabytes, dos gigabytes, ochenta por ciento, menos dieciséis decibeles y menos un decibel.",
		);
		expect(speechText("En `1.5s` y 30ms.")).toBe("En uno punto cinco segundos y treinta milisegundos.");
		expect(speechText("1 ms, 1 min, 1 KB, 1 MB, 1 GB, 1 dB, 1% y 1,0 s.")).toBe(
			"un milisegundo, un minuto, un kilobyte, un megabyte, un gigabyte, un decibel, uno por ciento y uno coma cero segundos.",
		);
	});

	it("(f1)/(f2) leave versions, dates, ~/ paths, URLs and unit-like words without a number alone", () => {
		expect(speechText("Versión 1.13.8, el 2026-10-28, en `~/.gentle-shell` y ~/x/y.md.")).toBe(
			"Versión uno punto trece punto ocho, el veintiocho de octubre de dos mil veintiséis, en la carpeta gentle shell y y punto md, en x.",
		);
		expect(speechText("Ver https://x.dev/a?b=~1&c=5%20s y los s, 3 semanas, 2 minas, v2 s, R1 ms.")).toBe(
			"Ver x.dev y los s, tres semanas, dos minas, v dos s, R uno ms.",
		);
		expect(speechText("Usá `%d`, `printf(\"%s\")` y a~1.")).toBe('Usá %d, printf("%s") y a~uno.');
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
		expect(speechText("1. Después\n2) Luego")).toBe("uno: Después.\ndos: Luego.");
		expect(speechText("Versión 2. Luego sigue.")).toBe("Versión dos. Luego sigue.");
		expect(speechText("## 1. Estado de gsh\n**2. Engram listo.** Bajé todo.")).toBe("uno: Estado de gsh.\n\ndos: Engram listo. Bajé todo.");
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
		expect(speechText("## Needs your decision\n1. ¿Seguimos?")).toBe("Decisiones pendientes.\n\nuno: ¿Seguimos?");
		expect(speechText("**Needs your decision:**\n1. ¿Sí?")).toBe("Decisiones pendientes.\n\nuno: ¿Sí?");
		expect(speechText("Needs your decision")).toBe("Needs your decision");
	});

	it("(h1) reads a number with dots with 'punto'", () => {
		expect(speechText("Versión 1.1 y 0.8.0, con 3.5 s y ~1.5 MB.")).toBe(
			"Versión uno punto uno y cero punto ocho punto cero, con tres punto cinco segundos y aproximadamente uno punto cinco megabytes.",
		);
		expect(speechText("Usá `1.13.8` (o 2.1).")).toBe("Usá uno punto trece punto ocho (o dos punto uno).");
		expect(speechText("Un contraste de 4.5:1, a las 22:48.")).toBe("Un contraste de cuatro punto cinco:uno, a las veintidós cuarenta y ocho.");
	});

	it("(h1) turns the period after a dotted number ending a numbered heading, bold line or item into ':'", () => {
		expect(speechText("## 5.2. Título\nTexto.")).toBe("cinco punto dos: Título.\n\nTexto.");
		expect(speechText("**1.1. Engram**\n5.2. Después")).toBe("uno punto uno: Engram.\n\ncinco punto dos: Después");
		expect(speechText("## 5.2 Título")).toBe("cinco punto dos Título.");
	});

	it("(h1) keeps Spanish thousands as they are", () => {
		expect(speechText("Son 2.750 respuestas y 1.500.000 bytes, no 0.750 ni 2.75.")).toBe(
			"Son dos mil setecientas cincuenta respuestas y un millón quinientos mil bytes, no cero punto setecientos cincuenta ni dos punto setenta y cinco.",
		);
	});

	it("(h1) leaves reply IDs to their own reading", () => {
		expect(speechText("En P11.R1.Q1 y `P2.R10`, versión 1.1.")).toBe("En P once, R uno, Q uno y P dos, R diez, versión uno punto uno.");
	});

	it("(h1) leaves URLs to their own reading", () => {
		expect(speechText("Ver https://10.0.0.1:8080/v/1.2 y `https://x.dev/r/1.2.3`, en 1.2.")).toBe("Ver 10.0.0.1:8080 y https://x.dev/r/1.2.3, en uno punto dos.");
	});

	it("(h1) leaves file names to their own reading", () => {
		expect(speechText("Abrí `1.2.md`, `notas-1.2.md` y 2.0.1.tgz de la 2.0.1.")).toBe("Abrí uno punto dos.md, notas uno punto dos punto md y dos punto cero punto uno.tgz de la dos punto cero punto uno.");
	});

	it("(h1) leaves paths to their own reading", () => {
		expect(speechText("Está en `src/1.2/a.ts` y en `~/v/1.2.3/` desde la 1.2.")).toBe("Está en a punto ts, en uno punto dos y en la carpeta uno punto dos punto tres, en v desde la uno punto dos.");
	});

	it("(h1) keeps IP addresses as they are", () => {
		expect(speechText("El hs es 192.168.1.50 y el desktop `tcp:10.0.0.5:4713`, no 1.2.3 ni 300.1.1.1.")).toBe(
			"El hs es ciento noventa y dos punto ciento sesenta y ocho punto uno punto cincuenta y el desktop tcp:diez punto cero punto cero punto cinco:cuatro mil setecientos trece, no uno punto dos punto tres ni trescientos punto uno punto uno punto uno.",
		);
	});

	it("(h1) keeps the period of a number ending a sentence", () => {
		expect(speechText("Ahora son 1.1. Luego 2.0.")).toBe("Ahora son uno punto uno. Luego dos punto cero.");
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
		expect(speechText("See `src/speech-text.ts:42` for the rule.")).toBe("See speech text dot ts, in src, line forty two for the rule.");
	});

	it("reads approximations in English", () => {
		expect(speechText("It takes ~400 lines and the ~ is kept in `a~1` for the path.")).toBe(
			"It takes approximately four hundred lines and the ~ is kept in a~one for the path.",
		);
	});

	it("reads units in English, singular after 1", () => {
		expect(speechText("It takes 2,5 s, 250 ms, 3 min, 12 KB, 4 MB, 2 GB, 80%, -16 dB and -3 dBFS for the run.")).toBe(
			"It takes two comma five seconds, two hundred fifty milliseconds, three minutes, twelve kilobytes, four megabytes, two gigabytes, eighty percent, minus sixteen decibels and minus three decibels for the run.",
		);
		expect(speechText("It is 1 s, 1 ms, 1 min, 1 KB, 1 MB, 1 GB, 1% and 1 dB for the run.")).toBe(
			"It is one second, one millisecond, one minute, one kilobyte, one megabyte, one gigabyte, one percent and one decibel for the run.",
		);
	});

	it("reads punctuation marks by name in English", () => {
		expect(speechText("The marks are `.` `,` `;` `:` `!` `?` `~` `/` `-` `_` `*` `#` `|` in the text.")).toBe(
			"The marks are period comma semicolon colon exclamation mark question mark tilde slash hyphen underscore asterisk hash pipe in the text.",
		);
	});

	it("reads symbols in English", () => {
		expect(speechText("The flow is a → b ← c, and x ≈ y, x ≠ y, n ≥ 2, n ≤ 5, ± 3, 3 × 4, R&D with the rest.")).toBe(
			"The flow is a to b from c, and x approximately y, x not equal to y, n greater than or equal to two, n less than or equal to five, plus or minus three, three times four, R and D with the rest.",
		);
	});

	it("reads alternatives in English", () => {
		expect(speechText("Pick the `light/dark` theme, and/or the km/h unit.")).toBe("Pick the light or dark theme, and/or the km/h unit.");
	});

	it("reads dotted numbers with 'point' in English, numbered headings with ':'", () => {
		expect(speechText("The version is 1.1 and the next is 0.8.0, with the 2.750 rate.")).toBe(
			"The version is one point one and the next is zero point eight point zero, with the two point seven hundred fifty rate.",
		);
		expect(speechText("## 5.2. The title\nThis is the text.")).toBe("five point two: The title.\n\nThis is the text.");
	});

	it("reads Spanish thousands as a decimal in English", () => {
		expect(speechText("The rate is 2.750 and the total is 1.500.000 for the run.")).toBe(
			"The rate is two point seven hundred fifty and the total is one point five hundred point zero zero zero for the run.",
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
		expect(speechText("This is in P11.R1.Q1 and the `P2.R10` reply.")).toBe("This is in P eleven, R one, Q one and the P two, R ten reply.");
	});

	it("does not apply Spanish-only rules to English text", () => {
		expect(speechText("Then go back to `/read` from the menu, and to `/tmp/a/b/` for the files.")).toBe(
			"Then go back to the command read from the menu, and to the folder b, in a for the files.",
		);
		expect(speechText("## Needs your decision\n1. Do you want the change?")).toBe("Needs your decision.\n\none: Do you want the change?");
		expect(speechText("I said a el and de el in the text of the page for the user.")).toBe(
			"I said a el and de el in the text of the page for the user.",
		);
	});
});

describe("S2 (i1)-(i4): pending readings, round 1", () => {
	it("(i1) reads a relative one-part folder like any other folder, only its name right after carpeta/folder", () => {
		expect(speechText("Mirá `src/` y odd/.")).toBe("Mirá la carpeta src y la carpeta odd.");
		expect(speechText("Mirá la carpeta `src/`.")).toBe("Mirá la carpeta src.");
		expect(speechText("Pasá al `src/`.")).toBe("Pasá a la carpeta src.");
		expect(speechText("Revisá `ckan-docker/` y `.github/`.")).toBe("Revisá la carpeta ckan docker y la carpeta github.");
		expect(speechText("Look at `src/` for the code.", "en")).toBe("Look at the folder src for the code.");
		expect(speechText("Look at the folder `src/`.", "en")).toBe("Look at the folder src.");
	});

	it("(i1) reads a path whose last part starts with a dot like any other (e4) file or folder", () => {
		expect(speechText("Copiá `ckan-docker/.prettierrc.json`.")).toBe("Copiá prettierrc punto json, en ckan docker.");
		expect(speechText("Copy `ckan-docker/.prettierrc.json` to the root.", "en")).toBe("Copy prettierrc dot json, in ckan docker to the root.");
		expect(speechText("Mirá `ckan-docker/src/.github/`.")).toBe("Mirá la carpeta github, en src.");
	});

	it("(i2) reads a standalone # before digits as número/number, keeping trailing punctuation", () => {
		expect(speechText("Se mergeó el PR #43, y el issue #7 (ver #12).")).toBe("Se mergeó el PR número cuarenta y tres, y el issue número siete (ver número doce).");
		expect(speechText("Merged the PR #43, closing issue #7.", "en")).toBe("Merged the PR number forty three, closing issue number seven.");
		expect(speechText("El `#43` está listo.")).toBe("El número cuarenta y tres está listo.");
	});

	it("(i2) leaves headings and a # inside a word alone", () => {
		expect(speechText("# 43\n\nTexto.")).toBe("cuarenta y tres.\n\nTexto.");
		expect(speechText("## Estado\nel PR #43")).toBe("Estado.\n\nel PR número cuarenta y tres");
		expect(speechText("Ver issue#43 y C#.")).toBe("Ver issue#43 y C#.");
	});

	it("(i3) reads key combinations with más/plus, Ctrl as Control, modifiers in any case", () => {
		expect(speechText("Usá `Ctrl+Shift+P`, después Alt+R.")).toBe("Usá Control más Shift más P, después Alt más R.");
		expect(speechText("Press `Ctrl+Shift+P`, then Alt+R.", "en")).toBe("Press Control plus Shift plus P, then Alt plus R.");
		expect(speechText("Probá ctrl+c, CTRL+SHIFT+t, cmd+Enter y Control+Tab.")).toBe(
			"Probá Control más c, Control más SHIFT más t, cmd más Enter y Control más Tab.",
		);
		expect(speechText("Probá Fn+F12, Super+Space, Meta+Esc, Win+Left, Option+Backspace y Command+1.")).toBe(
			"Probá Fn más F doce, Super más Space, Meta más Esc, Win más Left, Option más Backspace y Command más uno.",
		);
	});

	it("(i3) leaves a + between non-modifiers, or before a non-key, as written", () => {
		expect(speechText("Sumá a+b, C++ y Ctrl+Foo.")).toBe("Sumá a+b, C++ y Ctrl+Foo.");
	});

	it("(i4) reads a minimum version as o superior/or later, with and without v, its dots as in (h1)", () => {
		expect(speechText("Requiere `v1+`, `v2.0+` y Node 1.4+.")).toBe("Requiere v uno o superior, v dos punto cero o superior y Node uno punto cuatro o superior.");
		expect(speechText("Needs `v1+`, `v2.0+` and Node 1.4+.", "en")).toBe("Needs v one or later, v two point zero or later and Node one point four or later.");
		expect(speechText("Con 2.11.0+ basta.")).toBe("Con dos punto once punto cero o superior basta.");
	});

	it("(i1) reads a dot-leading last part with no extension in a path as a file named without the dot (L102)", () => {
		expect(speechText("Copiá `ckan-docker/.gitignore`.")).toBe("Copiá gitignore, en ckan docker.");
		expect(speechText("Copy `ckan-docker/.gitignore` to the root.", "en")).toBe("Copy gitignore, in ckan docker to the root.");
		expect(speechText("Mirá `./ckan-docker/.gitignore` y `~/projects/odp-docker/.demo-users`.")).toBe(
			"Mirá gitignore, en ckan docker y demo users, en odp docker.",
		);
		expect(speechText("Ver `ckan-docker/.gitignore:3`.")).toBe("Ver gitignore, en ckan docker, línea tres.");
		expect(speechText("Revisá `ckan-docker/.github/`.")).toBe("Revisá la carpeta github, en ckan docker.");
	});

	it("(i4) reads a whole number with no v followed by + as a count: o más/or more (L102)", () => {
		expect(speechText("Hay `100+` respuestas, 300+ líneas y 6.000+ casos.")).toBe("Hay cien o más respuestas, trescientos o más líneas y seis mil o más casos.");
		expect(speechText("There are `100+` replies and 300+ lines.", "en")).toBe("There are one hundred or more replies and three hundred or more lines.");
		expect(speechText("Sumá +4 y C++, con `v1+`.")).toBe("Sumá +4 y C++, con v uno o superior.");
	});

	it("(i1)-(i4) tokens are read, so diagnostics no longer report them", () => {
		const narration = speechNarration("Mirá `src/`, `ckan-docker/.prettierrc.json`, el PR #43, `Ctrl+Shift+P` y `v1+`.\nY `a+b`.");
		expect(narration.diagnostics).toEqual([{ line: 2, token: "a+b" }]);
	});

	it("(e4) paths, commands, fractions and short pairs keep their readings (preserved by i1)", () => {
		expect(speechText("Ver `odd/tasks/reply-reader.md`, `~/.gentle-shell`, `/reload`, `/tmp/`, 1/2, y/o y `light/dark`.")).toBe(
			"Ver reply reader punto md, en tasks, la carpeta gentle shell, el comando reload, la carpeta tmp, uno/dos, y/o y light o dark.",
		);
	});
});

describe("S2 (j1): numbers in words", () => {
	it("(j1) reads integers and Spanish thousands as words", () => {
		expect(speechText("Hay 51 en 2026 y 11.457 respuestas.")).toBe(
			"Hay cincuenta y uno en dos mil veintiséis y once mil cuatrocientas cincuenta y siete respuestas.",
		);
		expect(speechText("Son 15, 16, 22, 100, 101, 115, 500, 999, 1000, 1001, 21000, 100000, 1000000, 2500000 y 999999999.")).toBe(
			"Son quince, dieciséis, veintidós, cien, ciento uno, ciento quince, quinientos, novecientos noventa y nueve, mil, mil uno, veintiún mil, cien mil, un millón, dos millones quinientos mil y novecientos noventa y nueve millones novecientos noventa y nueve mil novecientos noventa y nueve.",
		);
		expect(speechText("There are 51 tests in 2026, then 101, 115, 1000000 and 2500000 for the run.", "en")).toBe(
			"There are fifty one tests in two thousand twenty six, then one hundred one, one hundred fifteen, one million and two million five hundred thousand for the run.",
		);
	});

	it("(j1) reads 0 as cero/zero", () => {
		expect(speechText("Quedan 0 errores.")).toBe("Quedan cero errores.");
		expect(speechText("There are 0 errors.", "en")).toBe("There are zero errors.");
	});

	it("(j1) reads decimals with coma/comma, and English three-digit comma groups as thousands", () => {
		expect(speechText("Tarda 1,2 y 0,05, con 1.234,5 en total.")).toBe("Tarda uno coma dos y cero coma cero cinco, con mil doscientos treinta y cuatro coma cinco en total.");
		expect(speechText("It takes 2,5 and 1,234 for the run.", "en")).toBe("It takes two comma five and one thousand two hundred thirty four for the run.");
	});

	it("(j1) reads the digit groups of punto readings one by one: dotted numbers, versions and IP addresses", () => {
		expect(speechText("Versión 1.4, 1.13.8, v2.0.1 y la IP 192.168.1.50.")).toBe(
			"Versión uno punto cuatro, uno punto trece punto ocho, v dos punto cero punto uno y la IP ciento noventa y dos punto ciento sesenta y ocho punto uno punto cincuenta.",
		);
		expect(speechText("The version is 1.4, then v2.0.1 and the IP 10.0.0.1.", "en")).toBe(
			"The version is one point four, then v two point zero point one and the IP ten point zero point zero point one.",
		);
	});

	it("(j1) reads a leading minus as menos/minus, not a hyphen between numbers", () => {
		expect(speechText("Bajá a -16 dB y -3, el 2026-10-27.")).toBe("Bajá a menos dieciséis decibeles y menos tres, el veintisiete de octubre de dos mil veintiséis.");
		expect(speechText("Set -16 dB and -3 for the run.", "en")).toBe("Set minus sixteen decibels and minus three for the run.");
	});

	it("(j1) Spanish agreement: un/veintiún before a word, una/veintiuna/y una before a listed feminine noun, singular or plural", () => {
		expect(speechText("En 1 segundo, 21 días y 51 tests.")).toBe("En un segundo, veintiún días y cincuenta y un tests.");
		expect(speechText("Queda 1 respuesta, 21 líneas, 31 preguntas, 101 veces y 1 Sesión.")).toBe(
			"Queda una respuesta, veintiuna líneas, treinta y una preguntas, ciento una veces y una Sesión.",
		);
		expect(speechText("1 hora, 21 horas, 1 vez, 41 personas y 1 versión.")).toBe("una hora, veintiuna horas, una vez, cuarenta y una personas y una versión.");
	});

	it("(j1) Spanish agreement: uno stays before punctuation, at the end, before a function word and in decimal parts", () => {
		expect(speechText("Quedó 1. Y 21, luego 1")).toBe("Quedó uno. Y veintiuno, luego uno");
		expect(speechText("Van de 1 a 5, 1 de 3 y 1 o 2.")).toBe("Van de uno a cinco, uno de tres y uno o dos.");
		expect(speechText("Citó P11.R1.Q1 a Q5.")).toBe("Citó P once, R uno, Q uno a Q cinco.");
		expect(speechText("Tarda 2.1 s y 1,1 s.")).toBe("Tarda dos punto uno segundos y uno coma uno segundos.");
	});

	it("(j1) English has no agreement", () => {
		expect(speechText("It took 1 s and 21 lines for the run.", "en")).toBe("It took one second and twenty one lines for the run.");
	});

	it("(j1) reads long numbers and numbers starting with 0 digit by digit", () => {
		expect(speechText("El 007, el 5551234567 y 123456789.")).toBe(
			"El cero cero siete, el cinco cinco cinco uno dos tres cuatro cinco seis siete y ciento veintitrés millones cuatrocientos cincuenta y seis mil setecientos ochenta y nueve.",
		);
		expect(speechText("Call 007 at 5551234567 for the run.", "en")).toBe("Call zero zero seven at five five five one two three four five six seven for the run.");
	});

	it("(j1) separates digits glued to letters", () => {
		expect(speechText("Probá F12, sha256 y R2D2.")).toBe("Probá F doce, sha doscientos cincuenta y seis y R dos D dos.");
		// A number glued to a name keeps "uno": it is not counting the word after it.
		expect(speechText("Así T1 está cumplido y L21 queda.")).toBe("Así T uno está cumplido y L veintiuno queda.");
	});

	it("(j1) keeps digits as written in URLs, hosts and technical tokens no class claimed", () => {
		expect(speechText("Ver https://10.0.0.1:8080/x, `http://localhost:8082/a?b=1`, `sherpa-onnx-node@2.0.1` y `422773f..HEAD` 2 veces.")).toBe(
			"Ver 10.0.0.1:8080, http://localhost:8082/a?b=1, sherpa-onnx-node@2.0.1 y 422773f..HEAD dos veces.",
		);
	});

	it("(j1) a technical token another rule split into words keeps only its technical parts as written", () => {
		expect(speechText("Requiere `>=1.2.0`, `time=0.0003` y $1,500.50.")).toBe("Requiere >=1 punto dos punto cero, time=0 punto cero cero cero tres y $1,500 punto cincuenta.");
	});

	it("(j1) runs last: numbering, (h1) headings, (i2), (i4), units and reply IDs keep their structure and only digits change", () => {
		expect(speechText("## 5.2. Título\n1. Después\n2) Luego")).toBe("cinco punto dos: Título.\n\nuno: Después.\ndos: Luego.");
		expect(speechText("Hay 300+ líneas, `v1+`, el PR #43, 1 MB, ~2 min y P2.R10.")).toBe(
			"Hay trescientos o más líneas, v uno o superior, el PR número cuarenta y tres, un megabyte, aproximadamente dos minutos y P dos, R diez.",
		);
	});

	it("(j1) a number in words creates or removes no fragment split", () => {
		expect(speechNarration("Son 1.5 s y 2.0.1. Luego 3.", "es").fragments.map((fragment) => fragment.text)).toEqual([
			"Son uno punto cinco segundos y dos punto cero punto uno.",
			"Luego tres.",
		]);
	});
});

describe("S12: narration plan, renderer and diagnostics", () => {
	const markdown = [
		"# Estado",
		"Hola, mundo. ¿Seguimos?",
		"",
		"- Un ítem",
		"2. Segundo",
		"> Citado.",
		"",
		"| A | B |",
		"|---|---|",
		"| 1 | 2 |",
		"```sh",
		"ls",
		"```",
		"**Nota**",
		"---",
		"Fin.",
	].join("\n");

	it("plans roles and the Markdown each block holds, with no words of any language added", () => {
		expect(narrationPlan(markdown).blocks).toEqual([
			{ role: "heading", source: "Estado", line: 1 },
			{ role: "paragraph", source: "Hola, mundo. ¿Seguimos?", line: 2 },
			{ role: "break", line: 3 },
			{ role: "item", source: "Un ítem", line: 4 },
			{ role: "item", number: "2", source: "Segundo", line: 5 },
			{ role: "paragraph", source: "Citado.", line: 6 },
			{ role: "break", line: 7 },
			{ role: "row", cells: ["A", "B"], line: 8 },
			{ role: "row", cells: ["1", "2"], line: 10 },
			{ role: "codeBlock", line: 11 },
			{ role: "heading", source: "**Nota**", line: 14 },
			{ role: "break", line: 15 },
			{ role: "paragraph", source: "Fin.", line: 16 },
		]);
	});

	it("renders one plan in either language, each fragment with its role and the boundary after it", () => {
		const plan = narrationPlan(markdown);
		const spanish = renderNarration(plan, "es");
		expect(spanish.fragments).toEqual([
			{ text: "Estado.", role: "heading", after: "paragraph" },
			{ text: "Hola, mundo.", role: "paragraph", after: "sentence" },
			{ text: "¿Seguimos?", role: "paragraph", after: "paragraph" },
			{ text: "Un ítem.", role: "item", after: "line" },
			{ text: "dos: Segundo.", role: "item", after: "line" },
			{ text: "Citado.", role: "paragraph", after: "paragraph" },
			{ text: "A, B.", role: "row", after: "line" },
			{ text: "uno, dos.", role: "row", after: "line" },
			{ text: "Bloque de código.", role: "codeBlock", after: "line" },
			{ text: "Nota.", role: "heading", after: "paragraph" },
			{ text: "Fin.", role: "paragraph", after: "sentence" },
		]);
		expect(spanish.language).toBe("es");
		expect(spanish.text).toBe(speechText(markdown, "es"));
		const english = renderNarration(plan, "en");
		expect(english.fragments.find((fragment) => fragment.role === "codeBlock")?.text).toBe("Code block.");
		expect(english.text).toBe(speechText(markdown, "en"));
	});

	it("speechNarration follows the text's own language unless one is given, as speechReading does", () => {
		const english = "The tests pass and the build is clean.\n```\nls\n```";
		expect(speechNarration(english).language).toBe("en");
		expect(speechNarration(english).text).toBe(speechText(english));
		expect(speechNarration(english, "es").text).toBe(speechText(english, "es"));
	});

	it("an emoji-only line ends a paragraph, as a blank line does", () => {
		expect(speechNarration("Uno.\n🎉\nDos.", "es").fragments).toEqual([
			{ text: "Uno.", role: "paragraph", after: "paragraph" },
			{ text: "Dos.", role: "paragraph", after: "sentence" },
		]);
	});

	it("spokenFragments splits text already meant for speech at . ! ? … and line breaks, never at : or ;", () => {
		expect(spokenFragments("Hola, mundo. ¿Qué tal?  Bien!\n\nSigue: uno; dos… tres\n \n")).toEqual([
			{ text: "Hola, mundo.", role: "paragraph", after: "sentence" },
			{ text: "¿Qué tal?", role: "paragraph", after: "sentence" },
			{ text: "Bien!", role: "paragraph", after: "paragraph" },
			{ text: "Sigue: uno; dos…", role: "paragraph", after: "sentence" },
			{ text: "tres", role: "paragraph", after: "sentence" },
		]);
	});

	it("reports each token no reading class claimed, with its line (per line, code spans before prose)", () => {
		const text = [
			"Mirá a+b, `foo=bar` y #122.",
			"Leé `src/x.ts`, `/reload`, README.md, 1.1, P1.R1, `1/2`, `y/o`, snake_case y https://a.com/x?y=1.",
			"`jd-*` y a..HEAD",
		].join("\n");
		expect(speechNarration(text, "es").diagnostics).toEqual([
			{ line: 1, token: "foo=bar" },
			{ line: 1, token: "a+b" },
			{ line: 3, token: "a..HEAD" },
		]);
		expect(speechNarration("Todo claro: `README.md` en la rama `feat/x`.", "es").diagnostics).toEqual([]);
	});
});

describe("S12: plan and renderer invariants (regression pins from the T30 verify)", () => {
	const samples = [
		"## 1. Estado\n**2. Engram**\n- item `/reload`.\n| a | `x/y` |\n|-|-|\n| 1.1 | 2 |\n```\nx\n",
		"\r\n# T\r\nUno.\rDos.",
		"Usa `foo=bar`. Fin\n\n\n\nOtro! `README.md`",
	];

	it("keeps the plan language-free: every source and cell comes from its own line", () => {
		for (const markdown of samples) {
			const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
			for (const block of narrationPlan(markdown).blocks) {
				const pieces = block.role === "row" ? block.cells : "source" in block ? [block.source] : [];
				for (const piece of pieces) expect(lines[block.line - 1]).toContain(piece);
			}
		}
	});

	it("gives playback the fragments the spoken text splits into, as v0.1.0 cut them", () => {
		for (const markdown of samples) {
			for (const language of [undefined, "es", "en"] as const) {
				const narration = speechNarration(markdown, language);
				expect(narration.fragments.map((f) => [f.text, f.after])).toEqual(spokenFragments(narration.text).map((f) => [f.text, f.after]));
			}
		}
	});
});

describe("S2 (j1): agreement lists tuned from real replies (L109)", () => {
	it("reads una before imagen, corrida and fila, and uno before pronouns, articles and frequent verbs", () => {
		expect(speechText("Queda 1 corrida, 1 imagen, 21 imágenes y 1 fila.", "es")).toBe("Queda una corrida, una imagen, veintiuna imágenes y una fila.");
		expect(speechText("El paso 1 no corre, el 1 ya está, el 1 se borra, el 1 lo usa, el 1 está listo y el 1 sigue.", "es")).toBe(
			"El paso uno no corre, el uno ya está, el uno se borra, el uno lo usa, el uno está listo y el uno sigue.",
		);
	});
});

describe("S2 (k1)-(k5): readings, round 3 (L112)", () => {
	it("(k1) hundreds agree with a listed feminine noun right after the number or after mil, Spanish only", () => {
		expect(speechText("Son 400 líneas, 500 respuestas, 221 líneas y 200.000 líneas.")).toBe(
			"Son cuatrocientas líneas, quinientas respuestas, doscientas veintiuna líneas y doscientas mil líneas.",
		);
		expect(speechText("Hay 2.750 respuestas, 1.200.000 líneas, 300 mil preguntas y 901 horas.")).toBe(
			"Hay dos mil setecientas cincuenta respuestas, un millón doscientas mil líneas, trescientas mil preguntas y novecientas una horas.",
		);
		// Masculine nouns, function words and the end keep the masculine.
		expect(speechText("Son 400 tests, 200.000 bytes, 400 de las líneas y 500.")).toBe(
			"Son cuatrocientos tests, doscientos mil bytes, cuatrocientos de las líneas y quinientos.",
		);
		expect(speechText("There are 400 lines and 221 lines for the run.", "en")).toBe(
			"There are four hundred lines and two hundred twenty one lines for the run.",
		);
	});

	it("(k2) reads a standalone H:MM or HH:MM[:SS] time like a digital clock, minutes 00 as en punto/o'clock", () => {
		expect(speechText("A las `21:02`, `07:30` y `21:02:15`; luego `07:00`.")).toBe(
			"A las veintiuno cero dos, siete treinta y veintiuno cero dos quince; luego siete en punto.",
		);
		expect(speechText("Entre 9:05, 0:00, 23:59 y (10:30).")).toBe("Entre nueve cero cinco, cero en punto, veintitrés cincuenta y nueve y (diez treinta).");
		// With seconds, minutes 00 read as written (my call).
		expect(speechText("A las 07:00:15.")).toBe("A las siete cero cero quince.");
		expect(speechText("It starts at `07:30` and ends at 21:02, or 07:00 for the run.", "en")).toBe(
			"It starts at seven thirty and ends at twenty one zero two, or seven o'clock for the run.",
		);
		// Anything else with ":" between digits keeps today's reading.
		expect(speechText("Un contraste de 4.5:1, el 25:61, el 24:00 y `tcp:10.0.0.5:4713`.")).toBe(
			"Un contraste de cuatro punto cinco:uno, el veinticinco:sesenta y uno, el veinticuatro:cero cero y tcp:diez punto cero punto cero punto cinco:cuatro mil setecientos trece.",
		);
	});

	it("(k3) reads ISO and day-first dates with a year as '27 de octubre de 2026' / 'October 27, 2026'", () => {
		expect(speechText("El 2026-10-27, el `27/10/2026`, el 2026-01-01 y el 1/1/2026.")).toBe(
			"El veintisiete de octubre de dos mil veintiséis, el veintisiete de octubre de dos mil veintiséis, el uno de enero de dos mil veintiséis y el uno de enero de dos mil veintiséis.",
		);
		expect(speechText("It shipped on 2026-10-27 and 1/1/2026 for the run.", "en")).toBe(
			"It shipped on October twenty seven, two thousand twenty six and January one, two thousand twenty six for the run.",
		);
		// Invalid months and days, and dates without a year, keep today's reading.
		expect(speechText("El 2026-13-01, el 2026-02-30, el 31/04/2026, el 17/10 y 1/2.")).toBe(
			"El dos mil veintiséis-trece-cero uno, el dos mil veintiséis-cero dos-treinta, el treinta y uno/cero cuatro/dos mil veintiséis, el diecisiete/diez y uno/dos.",
		);
		expect(speechText("Es el 2024-02-29.")).toBe("Es el veintinueve de febrero de dos mil veinticuatro.");
	});

	it("(k3) every month has its name in both languages", () => {
		const spanish = "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre".split(" ");
		const english = "January February March April May June July August September October November December".split(" ");
		for (let month = 1; month <= 12; month++) {
			const iso = `2026-${String(month).padStart(2, "0")}-15`;
			expect(speechText(`El ${iso}.`, "es")).toBe(`El quince de ${spanish[month - 1]} de dos mil veintiséis.`);
			expect(speechText(`On ${iso}.`, "en")).toBe(`On ${english[month - 1]} fifteen, two thousand twenty six.`);
		}
	});

	it("(k4) reads globs: a leading * as cualquier/any, a trailing /* as todo lo de/everything in, any other * as algo/something", () => {
		expect(speechText("Usá `*.hs.lan`, `bin/*`, `lab-*` y `TEST_CKAN_*`.")).toBe("Usá cualquier hs punto lan, todo lo de bin, lab algo y TEST CKAN algo.");
		expect(speechText("Match `*.hs.lan`, `bin/*`, `lab-*` and `TEST_CKAN_*` in the list.", "en")).toBe(
			"Match any hs dot lan, everything in bin, lab something and TEST CKAN something in the list.",
		);
		// A product with no letters and a lone mark are not globs (my call for the first).
		expect(speechText("Probá `2*3`, 2 * 3 y `*`.")).toBe("Probá 2*3, dos * tres y asterisco.");
		const narration = speechNarration("Usá `*.hs.lan`, `bin/*`, `lab-*`, `TEST_CKAN_*` y `a+b`.", "es");
		expect(narration.diagnostics).toEqual([{ line: 1, token: "a+b" }]);
	});

	it("(k5) reads an HTML tag as 'la etiqueta name' / 'the name tag', only the name right after etiqueta/tag", () => {
		expect(speechText("Usá `<iframe>`, `</a>` y `<br/>`, y la etiqueta `<div>`.")).toBe(
			"Usá la etiqueta iframe, la etiqueta a y la etiqueta br, y la etiqueta div.",
		);
		expect(speechText("Dentro del `<iframe>` va <my-el>.")).toBe("Dentro de la etiqueta iframe va la etiqueta my el.");
		expect(speechText("Use the `<iframe>` tag, then `</a>` and the tag `<h1>` in the page.", "en")).toBe(
			"Use the iframe tag, then the a tag and the tag h one in the page.",
		);
		// Autolinks and markup glued to other text are not tags.
		expect(speechText("Ver <https://x.dev/a> y `a<b>c`.")).toBe("Ver x.dev y a<b>c.");
		expect(speechNarration("Usá `<iframe>` y `</a>`.", "es").diagnostics).toEqual([]);
	});
});

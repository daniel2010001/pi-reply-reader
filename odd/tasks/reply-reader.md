# reply-reader — read a Pi / Gentle Shell reply aloud, on request

A Pi package (`pi-reply-reader`), separate from `pi-reply-thread` (its S6), that reads a reply aloud
with local text-to-speech after cleaning its Markdown for listening. Nothing plays by itself.

## Specs

- S1 — On request only. Owner (verbatim, pi-reply-thread L3): "que el lector NO se ejecute automáticamente, a menos que se lo diga, algo como defautl=false, esto porque puede que los audios se pisen" → `autoRead` false by default; `/read` reads the latest reply, `/read P12.R1` a given one; a new reading stops the one playing.
- S2 — Markdown cleaned for speech. Owner (verbatim, L3): "como las respuestas son en markdown algunas cosas se leen raro, esto ya lo vi, algo como "asterisco asterisco negrilla asterisco asterisco", o también el formato de las tablas: "or col 1 or col 2 or col 3 or", o "guión" o "guión bajo" muchas veces. también está la parte del código: "comilla simpmle" muchas veces, así con las salidas del markdown." → deterministic cleanup (no model): emphasis, headings, bullets, tables, inline code, code blocks, links.
- S3 — Local engine. Decision (pi-reply-thread L64): "sherpa-onnx + Piper (recomendado)": local, no API key, optional pinned download after a confirm (the gsh dictation pattern).
- S4 — Where it sounds. Owner (verbatim, L64): "yo iria por la segunda opción, esto ya que normalmente uso el hs como "servidor" y la desktop como "cliente" de ssh, pero la duda es qué tanto será así, puede que el dia de mañana quiera usar el hs como cliente mismo o cambiar a otro dispositivo para que sea el nuevo cliente en lugar de la desktop, entiendes?" → the package always plays on the default PipeWire/Pulse sink and knows nothing about SSH; the README documents forwarding (`ssh -R` + `PULSE_SERVER`), so a new client changes how you connect, not the package.

## Tasks

| ID | Specs | Task | Route | Commit |
|---|---|---|---|---|
| T1 | S1-S4 | [x] Scaffold: package.json (`pi-package`), TypeScript, vitest, MIT, empty extension that loads | inline | — |
| T2 | S2 | [ ] `speechText(markdown)`: deterministic cleanup, one test per Markdown construct, run over real replies | test-first | — |
| T3 | S3 | [ ] Pinned voice + runtime download behind a confirm; Spanish Piper voice (choice open) | test-first | — |
| T4 | S1, S4 | [ ] Synthesis and playback on the default sink, `/read [id]`, a new reading or Esc stops the previous | test-first | — |
| T5 | S1-S4 | [ ] README (incl. SSH audio forwarding), CHANGELOG, help | inline | — |
| T6 | S1-S4 | [ ] Live check in gsh and plain Pi, over SSH from the desktop | owner | — |

Open: which Spanish voice; how `/read P12.R1` finds replies (rebuild from the branch here, or reuse `pi-reply-thread`'s IDs); how IDs and code are spoken.

## Log

- L1 (2026-10-26, owner, verbatim): "respecto a lo del lector: me gusta el nombre, usemos ese, crea otro proyecto." → repo `/home/danielblc/projects/pi-reply-reader` (`git init -b main`, repo-local identity as in pi-reply-thread); npm name `pi-reply-reader` free (404). T1: 1/1 test, typecheck clean.

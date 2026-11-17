# Changelog

## Unreleased

- Internal: the cleanup now builds a narration plan (blocks with a role: heading, paragraph, item, row, code
  block) and renders it in the reading's language; playback speaks the rendered fragments with each one's own
  pause instead of splitting the text again. `speechNarration(markdown, language?)` returns the text, the
  fragments and diagnostics: technical tokens no reading rule claimed, with their line. What is spoken and
  played is byte-identical to 0.1.0.
- `npm run build` removes `dist/` before compiling, so a packed tarball never carries stale files.

## 0.1.0 — 2026-11-17

First release.

- Event contract v1 for other extensions over `pi.events`, for `pi-reply-thread`'s Alt+R `s` key:
  `reply-reader:ping` `{ v: 1 }` is answered at once with `reply-reader:ready` `{ v: 1 }` (also sent at every
  session start), and `reply-reader:read` `{ v: 1, id, text }` reads `text` aloud like `/read`, naming `id`
  in the footer. Invalid payloads are ignored.
- `/read-auto on|questions|off` (bare toggles): read each new reply, or only its "Needs your decision"
  section, when the agent's turn ends; off at every session start.
- `/read <file|ID|empty>#<section>`: read only that section; add `rest` to read on to the end.
- `reply-reader <file.md>` command: reads a Markdown file (or `-` for standard input) aloud outside Pi, with
  `--output`, `--speed` (this run only), `--voice` and `--help`. Exit codes 0/1/2, and 129/130/143 when a
  signal stops it. It shares the one-reading-per-machine rule with `/read`. `npm i -g pi-reply-reader`
  installs it as compiled JavaScript, without installing Pi.
- English replies and files are read with English connecting words ("the command", "Code block.", "1 point 1",
  units and marks), detected from the text itself; Spanish text reads as before.
- `/read` reads a reply aloud on request only: the latest reply of the branch, or one by ID with
  `/read P12.R1` (any case, a `.Q<n>` suffix accepted, numbered like `pi-reply-thread`'s `/replies`) or by
  its entry ID. Nothing plays by itself. A new reading stops the one playing, and Esc stops it; the footer
  shows `Reading P12.R1 on local · Esc stops` meanwhile.
- `/read-stop` stops the reading playing and says "Reading stopped."; with nothing playing it says
  "Nothing is being read." and changes nothing.
- One reading per machine: a new `/read` in any Pi session or process of your user stops a reading playing in
  another, and `/read-stop` stops it too; the session whose reading was stopped clears its footer with no
  error. Coordinated through `$XDG_RUNTIME_DIR/pi-reply-reader/reading.json`; an entry whose process is gone
  is ignored, only a player started by the reader is ever signalled, and without a usable `XDG_RUNTIME_DIR`
  each session stops only its own readings, as before.
- `/read <file.md>` reads a Markdown file aloud (`.md` or `.markdown`, any case), resolved against the
  session's working directory (absolute and `~/` paths work too), with the same cleanup, voice, output,
  Esc and footer as a reply. A missing or unreadable file gets one warning naming it, and nothing plays.
- Local Spanish voice, Supertonic 3 through sherpa-onnx-node 2.0.1, on the CPU with no API key. The first
  `/read` asks before downloading it once (129 MB, pinned size and sha256) into
  `$XDG_DATA_HOME/pi-reply-reader/voices`; a failed download keeps nothing. Text is synthesized sentence by
  sentence, so audio starts after the first sentence, and the next sentence is synthesized while one plays;
  both voices are brought to the same loudness.
- `/read-voice [male|female]` picks the voice for the next readings: male (default) or female.
- Configurable voice speed, 1.1 by default. `/read-speed <n>` sets any speed from 0.5 to 2.0 (`1,15` works
  too, and so does `.9` without the leading zero); `/read-speed` alone offers 0.8 to 1.5. It is saved in `$XDG_CONFIG_HOME/pi-reply-reader/settings.json`
  as `{ "speed": … }`, keeping other keys, for every later reading and session; a reading already playing
  keeps its speed, and the pauses do not change. An invalid file or speed warns once per session and uses
  1.1; if saving fails, the speed applies to the session with a warning.
- Replies are cleaned for listening: Markdown syntax is removed, table rows become sentences, code blocks
  are announced as "Bloque de código.", URLs are read as their host, reply IDs as "P 11, R 1, Q 1",
  symbols such as `→` and `≈` as words, and emoji are dropped. Technical names are read by kind: a path as
  its file or folder plus where it is, a branch, a command, a file name, a commit hash, a pair of words.
  Approximations and units are spelled out, numbered items read "1:" instead of stopping after the number,
  and bold-only lines and headings are read as titles. Numbers with dots read "punto" (`1.1` "1 punto 1",
  `## 5.2. Título` "5 punto 2: Título"), while Spanish thousands such as `2.750` and IP addresses stay.
- Named outputs: `local` (this machine's default sink) plus the names in
  `$XDG_CONFIG_HOME/pi-reply-reader/outputs.json`, each mapped to a `PULSE_SERVER`. The first `/read` of a
  session asks which one when there is more than `local`; `/read-output [name]` switches. Bad entries are
  skipped with a warning.
- `examples/reply-reader-desktop-audio.service`: a systemd user unit that tunnels the audio over SSH to the
  machine you sit at, which needs only PipeWire or PulseAudio, with no port opened on it.

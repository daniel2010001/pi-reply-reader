# Changelog

## Unreleased

- Readings say their project when it changes: a reading whose project (the folder name of its Git root, or of
  its working folder outside a repository) differs from the last reading's on the machine, or the first one,
  starts with the project's name, then its announcement if it waited ("pi-reply-reader. Respuesta P tres, R
  dos."). Readings of the same project say none. Every Pi session and the `reply-reader` command share the
  memory under `$XDG_RUNTIME_DIR/pi-reply-reader/`; resuming does not repeat it.
- `pauseKey` refuses `ctrl` with a digit and any `super` key (one warning, Alt+M is used): terminals without
  the Kitty keyboard protocol never send them, so they silently never fired.
- Esc is Pi's again: the reader never takes it. Esc interrupts the agent and closes dialogs and screens
  (pi-reply-thread's Alt+R view, `ask_user_question`) even while a reading plays or is paused. Before, a reading
  took every Esc and paused or resumed instead, so a view could not be closed and the agent could not be
  interrupted. Readings stop with Esc no longer: Alt+M pauses and resumes them. Set `"pauseKey"` in
  `settings.json` (as `"alt+o"`) to use another key. A key that is not valid or that Pi, gentle-pi,
  pi-reply-thread or the terminal already uses gets one warning, and Alt+M is used instead.
- Pause and resume: `/read-pause` pauses the reading playing, in this or any other Pi session on the machine
  (`Reading paused.`), and run again resumes it (`Reading resumed.`); with nothing playing it says `Nothing is
  being read.`. The pause key, Alt+M, does the same with the same messages (`pauseKey` in settings.json picks
  another one). Pausing drops nothing that waits. A paused reading's player is ended (so the player timeout never fires on it) but it keeps
  its turn on the machine: nothing waiting starts. Resuming starts again from the sentence, item or row that was
  being heard, with the same voice and speed. The footer reads `Reading P12.R1 on local · Alt+M pauses`, and
  while paused `Paused P12.R1 · Alt+M resumes · /read-stop ends`. `/read-stop` ends a reading, playing or paused,
  and drops what waits, as before. A prompt's reading is ended instead of paused (`Reading stopped: a prompt is
  not paused.`); a `reply-reader` command reading cannot be paused from Pi.
- See and skip the line: `/read-queue` lists the readings waiting on the machine, in order, with their session
  (`Waiting on this machine:` / `1. P12.R2 · api (this session)`), or says `Nothing waits to be read.`;
  `/read-next` ends the reading, playing or paused, here or in another session, and the next one waiting starts
  with its announcement (`Skipped to the next reading.`; `Reading stopped; nothing else waits.` when nothing
  does). Each session publishes its line under `$XDG_RUNTIME_DIR/pi-reply-reader/`, and the footer's
  `· N waiting ·` now counts every session's; without a usable `XDG_RUNTIME_DIR` both stay per session.
  Readings play in the listed order: a session with readings waiting refreshes its line every 250 ms, and a
  session whose next reading has an earlier one of another session before it yields to it while that
  session's line is under 2 s old (10 s at most per reading, counting only time the machine is free, never
  time another reading plays), so a frozen session holds the others about 2 s. A session waiting for you (the
  output question, the voice download confirm) says so in its line and is not waited for, and a session that
  ends or drops its line stops beating at once, even mid-start. Two sessions with the
  same label are listed with a tag from their session ID (`api #3f9c`).
- Auto-read also reads the prompts that wait for you, through the same line: an `ask_user_question` /
  `ask_user_choice` call reads each question with its option labels only ("Pregunta 1 de 2: ¿Cómo suena?
  Opciones: uno, Bien; dos, Mal."), a command confirmation reads only the program ("Confirmación de comando:
  git." / "Command confirmation: git."), and any other dialog its title. Once answered, a prompt's reading is
  dropped, or stopped if it plays. The reader's own questions are not read.
- Auto-read reads every new reply, each once and in order, as soon as it is written, even while the agent keeps
  working. Before, only the last reply of a run was read: a reply followed by a background-job or subagent
  notice that started another turn was skipped.
- Between queued readings (auto-reads and **Read after it**): about 1.5 s of silence, then the next reading
  says which it is, in its language (`Respuesta P12.R2.` / `Reply P12.R2.`, `Archivo notas.md.` / `File
  notes.md.`). A reading with nothing before it starts as before. While readings wait, the footer counts them:
  `Reading P12.R2 on local · 2 waiting · Alt+M pauses`.
- A player that hangs no longer piles up: when `paplay` takes no audio for 15 s (say, a Pulse server behind an
  SSH tunnel whose far side does not answer), or does not finish within the audio's length plus 15 s, the
  reading fails with `Playback on "<output>" failed: timed out`. `REPLY_READER_PLAYER_TIMEOUT` sets the 15 s
  (5 to 86400 seconds; any other value warns once and uses 15). Every stop sends SIGTERM, then SIGKILL 2 s
  later if the player is still there, also from `reply-reader` before it exits. Players left by a Pi that
  died are ended when a Pi session or a reading starts, and with `setpriv` installed a player dies with its
  reader even when that is killed outright. Only this package's own players, in the same PID namespace, are
  touched.
- Numbers are spoken as words in the text's language (Supertonic mispronounced digits): "51" "cincuenta y
  uno", with Spanish "un"/"una" agreement by the next word, decimals, versions and IP addresses group by group,
  and numbers over 9 digits or starting with 0 digit by digit.
- More readings: Spanish hundreds agree with a feminine noun (`400 líneas` "cuatrocientas líneas", `200.000
  líneas` "doscientas mil líneas"); times read like a clock (`21:02` "veintiuno cero dos", `07:00` "siete en
  punto"); dates with a year read in full (`2026-10-27` and `27/10/2026` "veintisiete de octubre de dos mil
  veintiséis", "October twenty seven, two thousand twenty six"); globs (`*.hs.lan` "cualquier hs punto lan",
  `bin/*` "todo lo de bin", `lab-*` "lab algo"); HTML tags (`<iframe>` "la etiqueta iframe", "the iframe
  tag"). Diagnostics no longer report globs and tags.
- Internal: the cleanup now builds a narration plan (blocks with a role: heading, paragraph, item, row, code
  block) and renders it in the reading's language; playback speaks the rendered fragments with each one's own
  pause instead of splitting the text again. `speechNarration(markdown, language?)` returns the text, the
  fragments and diagnostics: technical tokens no reading rule claimed, with their line. What is spoken and
  played is byte-identical to 0.1.0.
- New readings: a bare folder (`src/` "la carpeta src") and a path ending in a dot file
  (`ckan-docker/.prettierrc.json` "prettierrc punto json, en ckan docker"), issue and PR numbers (`#43`
  "número 43"), key combinations (`Ctrl+Shift+P` "Control más Shift más P") and minimum versions (`v1+` "v1 o
  superior", `1.4+` "1 punto 4 o superior"), with "number", "plus" and "or later" in English. Diagnostics no
  longer report these tokens.
- Counts such as `100+` read "100 o más" ("100 or more"); a dot file with no extension inside a path reads as
  a file: `ckan-docker/.gitignore` "gitignore, en ckan docker".
- `npm run build` removes `dist/` before compiling, so a packed tarball never carries stale files.
- Auto-read no longer interrupts: a reply due while a reading plays, in this or any other session on the
  machine, waits and is read once nothing plays, one session's replies in order. A manual `/read` (or a read
  request from another extension) and `/read-stop` stop the reading playing and drop every auto-read
  waiting on the machine; `/read-auto off` and the session's end drop that session's. Sessions coordinate
  through `$XDG_RUNTIME_DIR/pi-reply-reader/` as before (`waiting.json` and a short `reading.lock` mutex);
  without it a reply only waits for its own session.
- A manual `/read` or a read request (pi-reply-thread's Alt+R `s`) while something is being read anywhere on
  the machine asks first: `Something is being read.` with **Stop it and read now** (as before: stop, drop the
  waiting auto-reads, read) and **Read after it** (it waits like an auto-read, after the session's waiting
  replies; `/read-stop` and another manual reading drop it, `/read-auto off` keeps it). Dismissing the
  question changes nothing. In Pi's TUI the question is a small overlay of its own, so it shows above the Alt+R
  view; elsewhere it uses the host's selector. With nothing playing, or without a UI, it reads at once as
  before. `/read-stop` and the pause key never ask.
- The `reply-reader` command now drops the auto-reads waiting in Pi sessions when it starts reading, as a
  manual `/read` does; it never asks.

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

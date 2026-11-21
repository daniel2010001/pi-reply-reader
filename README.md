# pi-reply-reader

Read a [Pi](https://github.com/earendil-works/pi) or Gentle Shell reply aloud, only when you ask.

`/read` takes the latest reply (or one by ID), cleans its Markdown so it sounds like prose instead of
"asterisco asterisco", and speaks it with a local Spanish voice. The output can be this machine's speakers or
another machine you reach over SSH. `/read notes.md` reads a Markdown file the same way.

- **Nothing plays by itself.** A reading starts only with `/read`. A new reading stops the one playing, even
  in another Pi session on the same machine, so two never overlap. Alt+M or `/read-pause` pauses it and
  resumes it; `/read-stop` ends it. Esc stays Pi's: the reader never takes it.
- **Local and offline after setup.** Speech is synthesized on the machine that runs Pi, on the CPU, with no
  API key. Your replies never leave the machine (except as audio to an output you configured).
- **Nothing enters the model context.**

## Install

```sh
pi install npm:pi-reply-reader
```

Or try it for one session from a clone:

```sh
pnpm install
pi -e ./extensions/reply-reader.ts
gsh -- -e ./extensions/reply-reader.ts   # Gentle Shell
```

## First reading: the voice download

The voice is not bundled. The first `/read` asks before downloading it:

```
Reply reader voice
Download the Spanish voice Supertonic 3 (129 MB) from github.com into /home/you/.local/share/pi-reply-reader/voices?
```

- It is sherpa-onnx's `sherpa-onnx-supertonic-3-tts-int8-2026-05-11` bundle, pinned by size
  (128,774,318 bytes) and sha256 (`82fa96f9…c427`). Both are checked before anything is extracted.
- It goes to `$XDG_DATA_HOME/pi-reply-reader/voices` (`~/.local/share/pi-reply-reader/voices` when
  `XDG_DATA_HOME` is unset), once per machine.
- A failed download keeps nothing; the next `/read` asks again. Declining cancels the reading:
  `Reading cancelled: the voice was not downloaded.`
- Outside the interactive TUI (print or RPC mode) there is nobody to confirm, so nothing is downloaded.

Loading the model takes about a second, once per Pi process. After that, a reading starts after its first
sentence is synthesized, about 1-2 s.

## Use

| Command | Description in Pi | What it does |
|---|---|---|
| `/read` | Read a reply aloud: the latest, or one by ID (P12.R1); or a Markdown file (notes.md) | Reads the latest reply of the current branch. |
| `/read <id>` | | Reads one reply by ID (see below). |
| `/read <file.md>` | | Reads a Markdown file (see below). |
| `/read <target>#<section> [rest]` | | Reads one section of a file or reply (see [Reading one section](#reading-one-section)). |
| `/read-stop` | End the reading, playing or paused, in this or another Pi session, and drop the ones waiting (a new /read ends it too) | Ends the reading playing or paused, in any Pi session of yours on this machine, drops every reading waiting on the machine, and says `Reading stopped.`; with nothing playing anywhere, says `Nothing is being read.` |
| `/read-pause` | Pause the reading playing, in this or another Pi session, or resume it from the sentence it was in (Alt+M too) | See [Pause and resume](#pause-and-resume). |
| `/read-queue` | List the readings waiting on this machine, in order, with their sessions | See [The line](#the-line). |
| `/read-next` | End the reading, playing or paused, in this or another Pi session, and go on with the next one waiting | See [The line](#the-line). |
| `/read-auto [on\|questions\|off]` | Read each new reply aloud as soon as it is written, and each prompt that waits for you: on (in full), questions (only "Needs your decision"), off; no argument toggles; saved for later sessions | See [Auto-read](#auto-read). |
| `/read-output [name]` | Choose where readings sound: local or an output from outputs.json; saved for later sessions | With a name, switches to that output; without one, asks. See [Outputs](#outputs). |
| `/read-voice [male\|female]` | Choose the voice for the next readings: male (default) or female | With a name, switches the voice; without one, asks. |
| `/read-speed [n]` | Choose the voice speed for the next readings, 0.5 to 2.0 (default 1.1); saved for later sessions | With a number, sets that speed; without one, offers 0.8 to 1.5. See [Speed](#speed). |
| `/read-music [off\|pause\|duck] [level]` | What music does while the reader speaks: off, pause, or duck [level] (lower gentle-stream to level %, default duck 20); no argument shows it; saved for later sessions | See [Music while reading](#music-while-reading). |

While a reading plays, the footer shows `Reading P12.R1 on local · Alt+M pauses` (or the file name, as in
`Reading notes.md on local · Alt+M pauses`); while it is paused, `Paused P12.R1 · Alt+M resumes · /read-stop ends`.
The footer names the pause key in use (see [Pause and resume](#pause-and-resume)).
While readings wait on the machine (auto-reads, **Read after it** and prompts, in any session, see
[Auto-read](#auto-read)), it adds how many: `Reading P12.R2 on local · 2 waiting · Alt+M pauses`.
While auto-read is on, the footer always says so, also with nothing playing: `Auto-read on · desktop` or
`Auto-read questions · desktop` (the output chosen, or just `Auto-read on` before one is), and before a
reading's status: `Auto-read on · Reading P12.R1 on desktop · Alt+M pauses`. With auto-read off it shows only
the reading, as above.

- **Alt+M** pauses the reading, and resumes it when paused, like `/read-pause` (see
  [Pause and resume](#pause-and-resume)).
- **Esc is Pi's.** The reader never takes it, whether a reading plays, is paused or not: Esc interrupts the
  agent, closes dialogs and screens (pi-reply-thread's Alt+R view, `ask_user_question`) and dismisses the
  reader's own `Something is being read.` question, as usual.
- **`/read-stop`** ends the reading, playing or paused, and says `Reading stopped.`; with nothing playing it says
  `Nothing is being read.` and changes nothing.
- **A new `/read`** while something is being read, here or in another session, first asks
  `Something is being read.`: **Stop it and read now** stops the reading playing and starts the new one;
  **Read after it** waits like an auto-read (see [Auto-read](#auto-read)) and plays once nothing does; Esc
  dismisses the question and changes nothing. With nothing playing, or without a UI, `/read` reads at once.
  `/read-stop`, `/read-pause`, `/read-next` and Alt+M never ask.
- **One reading per machine.** The last reading wins across every Pi or Gentle Shell session of your user on
  the machine: a new `/read` in one session (answered **Stop it and read now**) stops a reading playing in
  another, and `/read-stop` stops it too. The session whose reading was stopped just clears its footer, with no error. Sessions find each other
  through a small file in `$XDG_RUNTIME_DIR/pi-reply-reader/` (an entry left by a session that is gone is
  ignored). Without a usable `XDG_RUNTIME_DIR`, each session only stops its own readings. Alt+M and
  `/read-pause` reach any session's reading.
- The output and the voice last for the session. A new session starts with the male voice and asks for the
  output again on its first reading (only when there is more than `local` to choose from).
- **A player that hangs is ended.** When `paplay` takes no audio for 15 s while audio waits for it (say, its
  Pulse server sits behind an SSH tunnel whose far side does not answer), or does not finish within the
  audio's length plus 15 s once it has all of it, the reading stops with
  `Playback on "<output>" failed: timed out`. Set `REPLY_READER_PLAYER_TIMEOUT` (seconds, whole or
  fractional, from 5 to 86400, in the environment Pi or `reply-reader` runs in) to change the 15 s; any other
  value warns `REPLY_READER_PLAYER_TIMEOUT must be a number of seconds from 5 to 86400; using 15.` once and
  uses 15. A player that keeps taking audio, however slowly, is never cut. Every stop, a new reading, a failed
  reading and a timeout send `paplay` SIGTERM, then SIGKILL 2 s later if it is still there; `reply-reader`
  waits for that before it exits. A player is also killed when Pi or `reply-reader` exits (even when killed
  outright, where `setpriv` is installed), and one left behind by a Pi that died is ended when a Pi session
  starts or the next reading starts. Only players started by this package (marked with
  `--client-name=pi-reply-reader` and the `PI_REPLY_READER_OWNER` variable naming a process that is gone, in
  the same PID namespace) are touched.

### Pause and resume

`/read-pause` pauses the reading playing, in this or any other Pi session of yours on the machine, and says
`Reading paused.`; run again, it resumes it and says `Reading resumed.`. With nothing playing or paused it
says `Nothing is being read.`. Alt+M does exactly the same, with the same messages.

The pause key is Alt+M unless `settings.json` (the file `/read-speed` saves to, see [Speed](#speed)) names
another as `"pauseKey"`, for example `{ "speed": 1.1, "pauseKey": "alt+o" }`. It is read when Pi loads the
extension, so a change applies the next time Pi starts. A key is `ctrl` or `alt`, maybe with `shift`, plus a
letter, digit or F1-F12 (`alt+o`, `alt+5`, `ctrl+shift+e`, `ctrl+f5`). `ctrl` with a digit and any `super` key are
refused: terminals without the Kitty keyboard protocol never send them, so they would never fire. A key that is
not like that, or that Pi (on any platform), gentle-pi, pi-reply-thread (Alt+R) or the terminal (as `ctrl+s`) already
uses, gets one warning when the session starts, such as
`Ignored pauseKey "alt+r" in …/settings.json: pi-reply-thread already uses it. Alt+M pauses and resumes readings.`,
and Alt+M is used. Alt+M is the default because it is free in all of them, and terminals send it reliably.
Esc is never the pause key: it is Pi's.

Pausing ends the player (`paplay` cannot be paused cleanly), so the timeout above never fires on a paused
reading. The reading keeps its turn on the machine: nothing waiting starts while it is paused. Resuming
synthesizes again from the start of the sentence, list item or table row that was being heard, with the same
voice, speed and output, so it repeats a few words rather than skipping any (the position is estimated from
the time each part was handed to the player, half a second early). `/read-stop` ends a paused reading as it
ends a playing one, and drops what waits.

A prompt's reading (see [Prompts that wait for you](#prompts-that-wait-for-you)) is not paused: `/read-pause`
or Alt+M ends it, says `Reading stopped: a prompt is not paused.`, and the next reading
waiting starts. A reading of the standalone `reply-reader` command (or of a Pi running an older version of
this package) cannot be paused from Pi: `/read-pause` says `The reading playing cannot be paused (it is not in
a Pi session); /read-stop ends it.`.

### The line

`/read-queue` lists what waits on the machine, in the order each joined its line: the reply ID, file name or
prompt kind (`question`, `command confirmation`, `dialog`), and the session (its `/name`, else its working
folder; yours is marked). Two sessions with the same label are told apart by the last four characters of their
Pi session ID (`api #3f9c`, `api #a1d0`):

```text
Waiting on this machine:
1. P12.R2 · api (this session)
2. notes.md · docs
3. question · api (this session)
```

With nothing waiting it says `Nothing waits to be read.`. Each session publishes its line next to the
reading entry in `$XDG_RUNTIME_DIR/pi-reply-reader/` (`line-<id>.json`, removed when the line empties or the
session ends, `/reload` included; a dead session's is ignored and removed). Readings play in the listed order:
while a session has readings waiting it republishes its line every 250 ms (a heartbeat), and a session whose
next reading has an earlier one of another session before it lets that one go first for as long as that
session's heartbeat is under 2 seconds old, for at most 10 seconds per reading. Those 10 seconds count only
time the machine is free and the session waits for that one: time another reading plays is not counted. A
reading being started keeps its place until it plays, except while its session waits for you (the output
question, the voice download confirm): the line file says so, and the other sessions do not wait for it. A
session that ends, or drops its line, stops beating at once, even if a reading was being started. A frozen, hung or dead session stops beating, so it holds the others about 2 seconds at
most; then the next reading plays. Without a usable `XDG_RUNTIME_DIR` no session can see
another's line, so `/read-queue` lists this session's only and says so (`Waiting in this session (other
sessions are not visible without XDG_RUNTIME_DIR):`), and the footer counts this session's.

`/read-next` ends the reading, playing or paused, in this or another session, without dropping the line: the
next reading waiting starts after the usual 1.5 s of silence, saying which it is. It says `Skipped to the next
reading.`, or `Reading stopped; nothing else waits.` when nothing waits, or `Nothing is being read.`.

### Reply IDs

`/read` numbers replies like [`pi-reply-thread`](https://github.com/daniel2010001/pi-reply-thread)'s
`/replies`, without needing that package. It accepts:

| Form | Example | Reads |
|---|---|---|
| Ordered ID, any case | `/read P12.R1`, `/read p12.r1` | The first reply to the twelfth prompt on the branch. |
| Ordered ID of a question | `/read P12.R1.Q2` | The reply that asks it (`P12.R1`). |
| Entry ID, exact | `/read a1b2c3d4` | The reply with that Pi session entry ID. |

Only final replies count (not tool calls or errors). Gentle Agents wake messages are not prompts, so replies
they trigger stay under the prompt that started them; replies before any prompt are `P0`. An ID that matches
nothing says `No reply matches "<id>".`

### Markdown files

An argument ending in `.md` or `.markdown` (any case) is a file, not a reply ID: `/read notes.md`,
`/read docs/guide.markdown`, `/read /tmp/plan.md` or `/read ~/notes/today.md`. A relative path is resolved
against the session's working directory. The file goes through the same cleanup, voice, output, pause key and
footer as a reply.

- A missing or unreadable file gets one warning naming the path as you typed it, such as
  `Cannot read "notes.md": file not found.`, and nothing plays (and no voice download is offered).
- A file with nothing to read says `notes.md has nothing to read.`

### Reading one section

Add `#section` to read only one section: `/read README.md#install`, `/read P3.R1#usage`, or `/read #usage`
for the latest reply. It reads from the first matching heading up to the next heading of the same or a
higher level, subsections included. Add `rest` to keep reading to the end: `/read README.md#install rest`.
Matching ignores case, accents, punctuation and leading numbers like `2.`, and you can write spaces as `-`
(`#one-reading-per-machine`). An exact heading wins over one that only starts with your text, which counts
only if exactly one heading starts with it. If no heading matches you get `No section "<section>" in <name>.`
and nothing plays. Only `#` headings count.

### Auto-read

`/read-auto on` reads each new reply aloud as soon as it is written, even while the agent keeps working (a
reply followed by a background-job or subagent notice that starts another turn is read too); every reply is
read once, in order. `/read-auto questions` reads only each reply's closing **Needs your decision** section
(nothing when a reply has none); `/read-auto off` stops.
`/read-auto` alone toggles (off → on in full, on → off). Each choice, the toggle included, is saved in
`settings.json` (see [Speed](#speed)) as `"autoRead": "on"`, `"questions"` or `"off"`, keeping the other keys, and
every new Pi session on this machine starts with it; with nothing saved, auto-read starts off. While it is on the
footer says so (`Auto-read on · desktop`, see [Use](#use)). Replies from before you turned it on, or already in a
session when it starts, are never read. If `settings.json` cannot be saved, the choice applies to this session
and a warning says it was not saved. Auto-readings use the same output, voice,
speed, footer and keys (Alt+M pauses, `/read-stop` ends) as `/read`, and still follow one reading per machine.

Auto-read never interrupts. A reply that is due while a reading plays, in this session or in any other Pi or
Gentle Shell session or `reply-reader` command on the machine, waits and is read once nothing plays; one
session's replies are read in order. While readings wait, the footer of the session reading counts every one
waiting on the machine (`· 2 waiting ·`), and `/read-queue` lists them (see [The line](#the-line)). When a reading ends and
another waits, there is about 1.5 s of silence, then the next one starts by saying which it is, in its own
language: `Respuesta P12.R2.` / `Reply P12.R2.` for a reply, `Archivo notas.md.` / `File notes.md.` for a
file. A reading with nothing before it starts at once, with no announcement. Explicit actions still win: a manual
`/read` (or a read from pi-reply-thread's Alt+R view) answered **Stop it and read now** and `/read-stop`
end the reading playing, as always, and also drop every auto-read waiting on the machine at that moment; replies due after that are read
as usual. The standalone `reply-reader` command drops them too when it starts reading. `/read-auto off` and the
end of the session drop that session's waiting replies. Without a usable `XDG_RUNTIME_DIR`, a reply only waits
for its own session's readings. Alt+M and `/read-pause` drop nothing: a paused reading keeps the machine, so what
waits keeps waiting; `/read-next` skips to it.

A manual `/read` (or a read from Alt+R) that you answer **Read after it** joins the same line: it is read after
the replies already waiting in its session, once nothing plays, and `/read-stop` or another manual reading
drops it, here or in any session. It is not an auto-read, so `/read-auto off` keeps it; the end of the session
drops it.

#### Prompts that wait for you

With auto-read on (in full or `questions`; prompts are questions too), when the agent stops to ask you
something, that prompt is read through the same line, in the conversation's language:

| Prompt | What is read |
|---|---|
| `ask_user_question` / `ask_user_choice` | With auto-read `on`, the text written before the question (in the same message, cleaned like a reply on its own, so none of its Markdown runs into the questions; its language decides the reading's when it tells), then each question with its option labels, never descriptions or values: "Pregunta 1 de 2: ¿Cómo suena? Opciones: uno, Bien; dos, Mal." ("Pregunta: …" for a single question; "Question 1 of 2: … Options: one, …" in English). With `questions`, only the questions are read. Text written before other tool calls, command confirmations included, is not read |
| A command confirmation (a confirm while a `bash` call waits to run) | "Confirmación de comando: git." / "Command confirmation: git.": the program only, never its arguments (they may hold private values); `NAME=value` assignments, a leading `sudo` or `env` and the program's folder are left out |
| Any other dialog (RDD consent, other confirms and selects) | Its title only; nothing when it has none (Pi does not give extensions a dialog's text or options) |

Once you answer (the dialog closes, or the tool finishes), its reading, the text before the question included,
is dropped if it still waits, or stopped if it plays; other waiting readings stay. A prompt that waited starts after the usual 1.5 s of
silence, without an announcement (it says what it is). The reader's own questions (output, voice, speed,
download, **Something is being read.**) are never read. With auto-read off, nothing of this plays.

#### Which project

A reading's project is the folder name of the Git root its session's working folder is in (the folder holding
`.git`; outside a repository, the working folder's own name). Two sessions of the same repository are the same
project, and so is a linked worktree of it (named by the main repository's folder); a submodule is a project of
its own, named by its own folder. The machine
remembers the project of the last reading that started, in any Pi session or `reply-reader` command (in
`$XDG_RUNTIME_DIR/pi-reply-reader/`). A reading of another project, or the first one when none is remembered,
starts by saying the project's name, read like any text in the reading's language, then its announcement if it
waited: `pi-reply-reader. Respuesta P tres, R dos.`. A reading of the same project says no project, so with
one project you never hear it again. This applies to replies, files, prompts and command readings alike; a
resumed reading does not say it again. Without a usable `XDG_RUNTIME_DIR`, each Pi process (and each command
run) remembers only its own.

### pi-reply-thread

Once [`pi-reply-thread`](https://github.com/daniel2010001/pi-reply-thread) supports it, `s` in its Alt+R view
reads the selected reply (Replies tab and the reply viewer) or only the selected question (Pending and
Answered tabs). The key and its hint appear only when this reader is loaded. A reading started there is the
same as `/read`: same cleanup, language, output question on first use, voice, speed, footer (naming the
reply or question ID), Alt+M, `/read-stop` and one reading per machine. Neither package depends on the other.
While something is being read, `s` asks the same `Something is being read.` question as `/read`. It opens
in a small box above the Alt+R view, and once it is answered or dismissed (Esc) the keys go back to the view.

#### Event contract for other extensions

Any extension can use the reader over Pi's shared event bus (`pi.events`). Contract v1:

| Channel | Payload | Meaning |
|---|---|---|
| `reply-reader:ping` | `{ v: 1 }` | Is a reader there? Answered with `reply-reader:ready` synchronously, before your `emit` returns. |
| `reply-reader:ready` | `{ v: 1 }` | The reader is there. Also sent at every session start. |
| `reply-reader:read` | `{ v: 1, id: string, text: string }` | Read `text` (Markdown) aloud like `/read`, naming `id` in the footer and in `<id> has nothing to read.`; while something is being read the reader asks first, as `/read` does. |

```ts
let readerReady = false;
pi.events.on("reply-reader:ready", () => (readerReady = true));
pi.events.emit("reply-reader:ping", { v: 1 }); // readerReady is already set here when the reader is loaded
if (readerReady) pi.events.emit("reply-reader:read", { v: 1, id: "P12.R1", text: "## Hello\n\nRead **this**." });
```

A payload that is not an object with `v: 1` and non-empty string `id` and `text` is ignored silently. There
is no reply to a read request: messages such as a cancelled download are shown by the reader, in the session.
The reader listens only while a session is running; after the session ends it ignores both requests.

### Standalone command

`reply-reader <file.md>` reads a Markdown file aloud from a terminal, without Pi, with the same cleanup,
voice, saved speed, outputs and one-reading-per-machine rule as `/read`. `-` reads standard input
(`cat notes.md | reply-reader -`).

| Option | Effect |
|---|---|
| `--output <name>` | where it sounds: `local` (default) or a name from `outputs.json` |
| `--speed <n>` | voice speed from 0.5 to 2.0 for this run only; settings.json is not changed |
| `--voice male\|female` | the voice (default male) |
| `--download-voice` | download the voice and exit; asks `[y/N]` first, so it needs a terminal |
| `--serve` | act as a listener: play what an agent host sends over SSH (see [Synthesize on the listener](#synthesize-on-the-listener)) |
| `-h`, `--help` | usage |

If the voice is missing, the command asks `[y/N]` before downloading it. Without a terminal, or when reading
standard input, it exits with an error instead of downloading. Ctrl+C, `kill` or closing the terminal stops
the reading. A new `/read` or `/read-stop` in any Pi session stops a command reading, and the command stops a
Pi reading without asking, dropping the auto-reads waiting in Pi sessions as a manual `/read` does. Ctrl+C
stops it; it has no pause, and `/read-pause` in Pi cannot pause it. Its project is that of the folder it runs
in, said first when it differs from the last reading's (see [Which project](#which-project)).

Exit codes: 0 read (or nothing to read, or stopped by another reading), 1 cannot read, download or play,
2 bad arguments, 129/130/143 stopped by SIGHUP, Ctrl+C or SIGTERM.

`pi install` does not put the command on your `PATH`. Install it with npm:

```sh
npm i -g pi-reply-reader
```

The installed command is compiled JavaScript (Node does not run TypeScript inside `node_modules`), and it does
not install Pi. From a checkout, build it and link it instead:

```sh
pnpm install && pnpm build && pnpm link --global   # or npm link instead of pnpm link --global
```

or link `bin/reply-reader.ts` into a folder on your `PATH`; Node runs that file directly, without a build.

### Speed

The voice reads at speed 1.1 by default (1.0 is Supertonic's own pace). `/read-speed 1.15` sets any speed
from 0.5 to 2.0, and a comma decimal or no leading zero works too (`/read-speed 1,15`, `/read-speed .9`); it
confirms with `Readings will use speed 1.15.` `/read-speed` alone offers 0.8, 0.9, 1.0, 1.1, 1.2, 1.3 and 1.5. Anything
else says `Speed must be a number from 0.5 to 2.0.` and changes nothing.

- The choice is saved in `$XDG_CONFIG_HOME/pi-reply-reader/settings.json` (`~/.config/…` when
  `XDG_CONFIG_HOME` is unset) as `{ "speed": 1.15 }`, keeping any other keys, and every later session and
  reading uses it. A reading already playing keeps its speed. The same file keeps `pauseKey`, the last
  `/read-auto` and output choices (`autoRead`, `output`; see [Auto-read](#auto-read) and [Outputs](#outputs)),
  and `music` (see [Music while reading](#music-while-reading)).
- Only the voice speed changes; the pauses between sentences, lines and sections stay the same.
- No file means 1.1. An invalid file, or a speed outside 0.5 to 2.0, is ignored with one warning per
  session, and readings use 1.1. `/read-speed` does not overwrite a file that is not valid JSON.
- If the file cannot be saved, the speed still applies to this session and a warning says it was not saved.

### Music while reading

While the reader speaks, music steps aside, and comes back when it is done. With nothing set, music played by
gentle-stream goes down to volume 20, on gentle-stream's own 0-100 volume scale (not 20 % of the volume it had).
`/read-music` chooses what happens:

- `/read-music duck 35` (or `/read-music 35`): sets the volume to 35 (0 to 100), and puts back the volume it
  had. A volume already at or below the level is never raised. `/read-music duck` keeps the saved level.
- `/read-music pause`: pauses the music, and plays it again after, only if it was playing before.
- `/read-music off`: leaves the music as it is.
- `/read-music` alone shows the setting (`Music goes down to 20 % while reading.`). Anything else says
  `Use /read-music off, pause, or duck with a level from 0 to 100.` or `Level must be a whole number from 0 to 100.`
  and changes nothing.

The choice is saved in `settings.json` as `"music": { "mode": "duck", "level": 35 }`, keeping the other keys
(the hooks too), and every later session and reading uses it. An invalid `music` value is ignored with one
warning per session, and the default is used.

**When.** Once per machine, by whoever holds the reading turn (a Pi session, the `reply-reader` command, or
`--serve` on a listener): the music steps aside when the machine goes from nothing read to a reading, and comes
back when the reading ends with nothing waiting. Between readings that wait in the line it stays aside, so it does
not go up and down. Pausing a reading (Alt+M, `/read-pause`) brings the music back; resuming steps it aside again.
The state before the step aside is kept in `$XDG_RUNTIME_DIR/pi-reply-reader/music.json`, so if a reader dies
while the music is aside, the next Pi session start (or the next reading's end) puts it back. A replacing reading
(a new `/read` or `/read-next` while one plays) keeps it aside. A `music.json` that is broken, empty or holds values
gentle-stream would not take (a volume that is not a whole number from 0 to 100) counts as no state: it is never
used, it is replaced at the next step aside and removed when the music comes back.

**What a restore never does.** It never starts music that was not playing: music already paused or stopped
when the reading started is not touched at all. If you changed the volume during the reading (it is no longer the
level the reader set), your volume stays. In pause mode, the music plays again only if it is still paused at the
volume it had; if you changed it, or played it yourself, it is left as it is.

**gentle-stream** is driven through `gentle-stream ctl status --json`, `ctl volume N`, `ctl pause` and `ctl play`.
Without `gentle-stream` on `PATH`, or with nothing playing (its `ctl` exits 1), nothing happens and nothing is
said.

**Hooks**, for any other player: settings.json `"music": { "before": "<command>", "after": "<command>" }` run
at the same moments (before: when the music steps aside; after: when it comes back), whatever the mode
(`"mode": "off"` with hooks uses only the hooks). For example:

```json
{ "music": { "mode": "off", "before": "playerctl pause", "after": "playerctl play" } }
```

Each hook runs through `/bin/sh -c`, as you, with your environment: it comes from your own settings file and
nothing from a reply is ever put in it, so treat it like a line of your shell profile.

**Never in the way of speech.** Every command (gentle-stream's or a hook) runs in the background, in its own
process group, and is ended after 3 s; speech never waits for it. A command that fails or hangs is said once per
session, for example `Music hook "before" timed out after 3 s; it was ended.` The limit ends the hook's process
group only: a hook that starts a child in the background (`cmd &`, `setsid`, a daemon) returns at once, and that
child keeps running past the 3 s.

**Where it runs.** Where the music plays: on the agent host for `local` and `PULSE_SERVER` outputs (and for a
listener output that reads through its fallback); on the listener for a listener output, where
`reply-reader --serve` steps the listener's music aside with the listener's own settings, and the agent host does
not touch its own. After a listener reading ends, `--serve` keeps the music aside for 4 s more, so the agent host's
next reading in its line finds it still aside; a stopped or paused reading brings it back at once.

## How replies are cleaned for listening

The cleanup is deterministic and needs no model, so the same reply always sounds the same.

The reader detects whether a reply or file is English or Spanish from its own words (no model; Spanish
wins ties), and every word the cleanup adds follows it. `/reload` reads as "the command reload" in English
text and "el comando reload" in Spanish; likewise "Code block." / "Bloque de código.", "AGENTS dot md, in
agent", "the branch origin main", "a commit", ", line 42", "1 point 1", "approximately", "seconds",
"percent", and marks by name ("period", "comma", "tilde"…). A token followed by its own noun is not doubled
("the `/read` command" reads "the read command"). The voice itself still speaks with Spanish pronunciation.

- **Markdown**: emphasis, headings, bullets, numbered items, blockquotes, links and rules lose their syntax
  and keep their words. Headings and list items end as sentences. Inline code is read without backticks.
  A heading or a line that is all bold is read like a title, followed by a longer pause. A numbered item or
  heading reads its number as "1:" so the voice does not stop after it, and the closing
  "Needs your decision" heading is read as "Decisiones pendientes".
- **Tables**: each row is read as one sentence, cells separated by commas.
- **Code blocks** are announced, not read: `Bloque de código.`
- **URLs** are read as their host name (`github.com`).
- **Reply IDs**: `P11.R1.Q1` is read as "P 11, R 1, Q 1".
- **Symbols** become words: `→` "a", `←` "desde", `≈` "aproximadamente", `≠` "distinto de", `≥` "mayor o igual
  a", `≤` "menor o igual a", `±` "más o menos", `&` "y", and `×` between numbers "por". Emoji are dropped.
- **Numbers**: `~` before a number reads "aproximadamente", and units after a number are spelled out (`1,2 s`
  "1,2 segundos", `ms`, `min`, `KB`/`MB`/`GB`, `%` "por ciento", `dB`/`dBFS` "decibeles"), singular after 1.
  Inline code holding a single punctuation mark reads its name: `` `.` `` "punto", `` `;` `` "punto y coma".
  Numbers with dots read "punto": `1.1` is "1 punto 1", `0.8.0` "0 punto 8 punto 0", and a numbered heading
  `## 5.2. Título` reads "5 punto 2: Título". Spanish thousands (`2.750`, `1.500.000`), IP addresses, reply
  IDs, URLs, file names and paths keep their own reading, and a number ending a sentence keeps its period.
- **Technical names** are read by kind (`snake_case` loses its `_` everywhere):
  - a path, as its file or folder plus where it is: `~/.gentle-shell/agent/AGENTS.md` becomes "AGENTS punto md,
    en agent", `/tmp/x/wav/hs/` becomes "la carpeta hs, en wav", a bare `src/` becomes "la carpeta src", and a
    last part starting with a dot reads like any other (`ckan-docker/.prettierrc.json` becomes "prettierrc punto
    json, en ckan docker");
  - a path with a line: `src/speech-text.ts:42` becomes "speech text punto ts, en src, línea 42";
  - a file name: `README.md` becomes "README punto md";
  - a branch: `origin/main` becomes "la rama origin main" (after "rama", only the name);
  - a command: `/reload` becomes "el comando reload" ("del `/reload`" becomes "del comando reload"), while
    system folders such as `/tmp` read as "la carpeta tmp";
  - a commit hash is dropped after "commit" and read as "un commit" elsewhere;
  - a pair of words: `light/dark` becomes "light o dark";
  - an issue or PR number: `el PR #43` becomes "el PR número 43" ("number 43" in English);
  - a key combination: `Ctrl+Shift+P` becomes "Control más Shift más P" ("plus" in English), `Alt+R` "Alt más R";
  - a minimum version: `v1+` becomes "v1 o superior" ("or later" in English), `v2.0+` "v2 punto 0 o superior",
    `1.4+` "1 punto 4 o superior";
  - a count: `100+` becomes "100 o más" ("100 or more" in English), `300+ líneas` "300 o más líneas";
  - a time: `21:02` becomes "veintiuno cero dos", `07:30` "siete treinta" ("seven thirty"), `21:02:15`
    "veintiuno cero dos quince" and `07:00` "siete en punto" ("seven o'clock"); hours 0-23 and minutes 00-59 only;
  - a date with a year, `2026-10-27` or day first `27/10/2026`: "veintisiete de octubre de dos mil veintiséis"
    ("October twenty seven, two thousand twenty six"); `17/10` and `1/2` stay as they are;
  - a glob: `*.hs.lan` becomes "cualquier hs punto lan" ("any"), `bin/*` "todo lo de bin" ("everything in"),
    `lab-*` "lab algo" ("something");
  - tags, HTML or not (a name of letters, digits and `-`): a pair reads the name, a colon and the content, the
    closing tag silent (`<command>ls -la</command>` becomes "command: ls -la", `<thinking>dudo</thinking>`
    "thinking: dudo"); a lone `<name>` reads only the name (`reply-reader <archivo>` becomes "reply-reader
    archivo", "un `<iframe>`" "un iframe"); a lone closing `</a>` or a self-closing `<br/>` becomes "la etiqueta
    a" ("the a tag"; after "etiqueta" or "tag", only the name);
  - `<< text >>` reads like quotes: the marks are silent and the text gets a short pause around it (`<< esto no
    es un tag >>` becomes "esto no es un tag"); a shift such as `a << b`, with no closing `>>` or no words
    inside, stays as written;
  - numbers, last, in the text's language: `51` becomes "cincuenta y uno" ("fifty one"), `11.457` "once mil
    cuatrocientos cincuenta y siete", `1,2` "uno coma dos", `1.4` "uno punto cuatro", `-16` "menos dieciséis".
    In Spanish the number agrees with the next word: `1 segundo` "un segundo", `21 líneas` "veintiuna líneas",
    `de 1 a 5` "de uno a cinco", and hundreds too: `400 líneas` "cuatrocientas líneas", `200.000 líneas`
    "doscientas mil líneas". Numbers of more than 9 digits, or starting with 0, are read digit by digit
    (`007` "cero cero siete"). Digits in URLs, hosts and unrecognized technical tokens stay as written.

  Fractions like `1/2` keep their slash ("uno/dos") and short pairs like `y/o` stay as they are.

### Known limits

- Kinds are guessed from the text alone, so some names are misread: two-word paths such as `odd/tasks`
  or MIME types such as `application/json` read as alternatives ("odd o tasks"), web routes such as
  `/users` read as commands, files without an extension read as folders (`ckan-docker/Makefile` becomes
  "la carpeta Makefile, en ckan docker"; a dot file such as `ckan-docker/.gitignore` reads as a file,
  "gitignore, en ckan docker", but a lone `~/.gitignore` reads as a folder, like `~/.ssh`), dot folders
  written without a final `/` inside a longer path read as files (`/home/.snapshots` becomes "snapshots, en
  home"), browser versions written without `v` read as counts ("Chrome 123 o más"), and some hosts or code names
  read as file names (`org.bluez` becomes "org punto bluez").
- Numbers: the feminine list is short (an unlisted feminine noun gets "un" and masculine hundreds), a count
  with `+` keeps the masculine ("trescientos o más líneas"), a date without a year or written month first
  keeps its slashes ("diecisiete/diez"), eight-digit stamps such as `20261026` are read as one number, and an
  English thousands comma in Spanish text (`1,044`) reads as a decimal.
- Times, globs and tags are guessed from their shape: a ratio such as `1:30` reads as a time; a token of only
  letters wrapped in `*` or `**` is taken for Markdown written as code and reads only its letters
  (`**negrita**` becomes "negrita"), not a glob; inline HTML pairs read like any other pair (`<em>todas</em>` becomes
  "em: todas"); and a tag glued to a word (`a<b>c`, `List<String>`) stays as written.
- The voice speaks with Spanish pronunciation, also for English text (only the words the cleanup adds
  switch to English there).

## Outputs

An output is where a reading sounds. `local` is always there: this machine's default sink. You add others
in `$XDG_CONFIG_HOME/pi-reply-reader/outputs.json` (`~/.config/pi-reply-reader/outputs.json` when
`XDG_CONFIG_HOME` is unset), an object that maps each name to a `PULSE_SERVER` value:

```json
{ "desktop": "tcp:127.0.0.1:4714" }
```

- Names use letters, digits and `-`, and `local` is built in, so it cannot be redefined.
- Each value must be a non-empty string, or an object `{ "ssh": "you@host", "fallback": "<PULSE_SERVER>" }`
  for a listener that synthesizes the reading itself (see [Synthesize on the listener](#synthesize-on-the-listener)).
- The first `/read` of a session asks `Where should readings sound?` when there is more than one output;
  `/read-output` switches later, and completes the names.
- The output picked (at that question or with `/read-output`) is saved in `settings.json` as
  `"output": "desktop"`, keeping the other keys, and every new Pi session on this machine uses it without
  asking. A saved output no longer in `outputs.json` is not used: the session warns
  `Saved output "desktop" is not in …/outputs.json; choose one.` and the first reading asks as usual.
- An entry that breaks a rule is skipped with a warning such as
  `Ignored output "my out" in …/outputs.json: names use letters, digits and "-".` A file that is not valid
  JSON is ignored as a whole (`Ignored …/outputs.json: not valid JSON (…)`). The warning shows on the first
  `/read` of a session and on every `/read-output`, so a typo never sends a reading somewhere else
  silently.

Outside the interactive TUI nothing can be asked: with more than one output, pick one first with
`/read-output <name>`, or the reading is cancelled (`Reading cancelled: no output chosen.`).

## Hear it on another machine over SSH

A common setup: Pi runs on a server, and you sit at a desktop connected to it over SSH. The reading is
synthesized on the server, so its audio has to reach the desktop's speakers.

**Why not open a PulseAudio TCP port on the desktop?** pipewire-pulse has no IP allow-list. A LAN port would
let anyone on the network play sound on the desktop or record its microphone, unless a firewall closes it.

**Use an SSH tunnel instead.** It opens nothing on the desktop: a systemd user unit on the server forwards a
loopback port (`127.0.0.1:4714`) to the desktop's own Pulse socket, with SSH doing authentication and
encryption. The unit is in [`examples/reply-reader-desktop-audio.service`](examples/reply-reader-desktop-audio.service)
(it ships with the package, under `node_modules/pi-reply-reader/examples/` once installed).

1. On the server, edit the copy for your desktop: `AUDIO_HOST` (the desktop's address), `AUDIO_UID` (your
   user ID on the desktop, `id -u`) and the user in `you@${AUDIO_HOST}`. The server must reach the
   desktop with `ssh` and a key, without a password prompt (`BatchMode=yes`).
2. Install it (on the machine that runs Pi):

   ```sh
   cp examples/reply-reader-desktop-audio.service ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now reply-reader-desktop-audio.service
   ```

3. Name the output in `~/.config/pi-reply-reader/outputs.json`:

   ```json
   { "desktop": "tcp:127.0.0.1:4714" }
   ```

4. Verify (prints the desktop's host name; plays nothing):

   ```sh
   PULSE_SERVER=tcp:127.0.0.1:4714 pactl info | grep 'Host Name'
   ```

5. In Pi, `/read-output desktop`, then `/read`.

The tunnel is down while the desktop is off; the unit retries every 15 s, and a reading on `desktop` fails
with `Playback on "desktop" failed: …` in the meantime. When the tunnel is up but the desktop does not
answer, `paplay` would wait forever; the reading fails with `Playback on "desktop" failed: timed out`
after 15 s instead (`REPLY_READER_PLAYER_TIMEOUT`, 5 to 86400 seconds, changes it). To keep the tunnel running after you log out of the
server, enable lingering for your user there (`loginctl enable-linger`).

The desktop needs only PipeWire (with pipewire-pulse) or PulseAudio and an SSH server. It needs no TTS, no
Pi and no change to its configuration. A new client is one more unit and one more entry in `outputs.json`.

## Synthesize on the listener

In the setup above, the machine that runs Pi (the **agent host**) synthesizes every reading and only the audio
travels. When the agent host is slow (a small VPS, a loaded server), readings start late and stutter. A
**listener** output moves the synthesis to the machine where you listen: the agent host sends each reading's
cleaned text, voice, speed and pauses over SSH to `reply-reader --serve` on the listener, which synthesizes
and plays it there. Example: Pi on a home server, a desktop as the listener.

On the listener:

1. Install the command and its voice (Node 22.19 or newer, PipeWire with pipewire-pulse or PulseAudio, `paplay`):

   ```sh
   npm i -g pi-reply-reader
   reply-reader --download-voice
   ```

2. Make sure `reply-reader` is on the `PATH` of a non-interactive SSH command: from the agent host,
   `ssh you@listener reply-reader --help` must print the usage.

On the agent host:

3. The agent host must reach the listener with `ssh` and a key, without a password prompt (it runs
   `ssh -o BatchMode=yes … you@listener reply-reader --serve --client-name=pi-reply-reader`).
4. Name the output in `~/.config/pi-reply-reader/outputs.json`, with a fallback (optional, recommended):

   ```json
   { "desktop": { "ssh": "you@listener", "fallback": "tcp:127.0.0.1:4714" } }
   ```

   `ssh` is what you would type after `ssh` (a host, `user@host`, or a `Host` alias of your SSH client
   configuration); it cannot start with `-` or hold spaces or control characters. `fallback` is a `PULSE_SERVER` value, such as the
   tunnel above. Any other key is reported and the entry skipped.
5. In Pi, `/read-output desktop`, then `/read` (or `reply-reader --output desktop notes.md`).

Everything else works as for any output: the line and its order, the announcements, prompts read aloud,
pause and resume (from the sentence being heard on the listener), `/read-stop` and a new reading from any
session (they end the `ssh` child, which ends the reading on the listener), and the player timeout. The
listener respects its own turn: while it reads something of its own, the agent host's reading waits. A
reading of its own started on the listener ends the one it serves, and a `/read-stop` (or a `/read`) there
while the agent host's reading still waits drops it; either way the agent host's reading ends quietly, with
no fallback. Long readings are sent in several messages, so they stay on the listener; only a single
sentence over 1 MiB goes to the fallback (`a sentence is too long to send to the listener (over 1048576 bytes)`).

**The fallback.** When the listener does not answer (no route, a refused key, `ssh` not installed, nothing
heard within the player timeout), lacks `reply-reader`, its voice or `paplay`, runs an incompatible version,
or fails while reading, the reading goes on from the sentence last heard: synthesized on the agent host and
played through `fallback`, with one warning per session such as
`Output "desktop": the listener did not answer; reading here through its fallback.` or, without the voice,
`Output "desktop": the listener has no voice (install it there with "reply-reader --download-voice"); reading here through its fallback.`
Without a fallback the reading fails with `Playback on "desktop" failed: <reason>`. The agent host still
needs its own voice for the fallback. Text from the listener or `ssh` shown in these messages has its control
characters removed, and a line from the listener over 64 KiB ends the reading there
(`the listener sent a line longer than 65536 bytes`).

`reply-reader --serve` never downloads and writes no file besides the reading lock (and, when the music steps
aside, `music.json`) under `$XDG_RUNTIME_DIR/pi-reply-reader/`. It only plays what it is sent; whoever can run `ssh` as you to the
listener can make it speak.

## Requirements

- **`paplay`**, on the machine that runs Pi. It comes with `libpulse` on Arch and `pulseaudio-utils` on
  Debian and Ubuntu. Without it, `/read` says `Cannot play: paplay was not found on PATH …`.
- **`tar` with bzip2 support**, for the one-time voice download.
- **Node.js >= 22.19.**
- **A CPU is enough.** No GPU is used. The engine is
  [sherpa-onnx-node](https://github.com/k2-fsa/sherpa-onnx) 2.0.1 (installed with the package).

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build   # compiles the reply-reader command into dist/ (also run by npm pack)
```

## License

MIT for this package.

The voice is downloaded separately and has its own licenses:

- Supertonic 3 weights: OpenRAIL-M, see
  [Supertone/supertonic-3](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE).
- Supertonic code: MIT, see [supertone-inc/supertonic](https://github.com/supertone-inc/supertonic).
- sherpa-onnx, which runs it: [Apache-2.0](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE).

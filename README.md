# pi-reply-reader

Read a [Pi](https://github.com/earendil-works/pi) or Gentle Shell reply aloud, only when you ask.

`/read` takes the latest reply (or one by ID), cleans its Markdown so it sounds like prose instead of
"asterisco asterisco", and speaks it with a local Spanish voice. The output can be this machine's speakers or
another machine you reach over SSH. `/read notes.md` reads a Markdown file the same way.

- **Nothing plays by itself.** A reading starts only with `/read`. A new reading stops the one playing, so
  two never overlap.
- **Local and offline after setup.** Speech is synthesized on the machine that runs Pi, on the CPU, with no
  API key. Your replies never leave the machine (except as audio to an output you configured).
- **Nothing enters the model context.**

## Install

```sh
pi install npm:pi-reply-reader   # once it is published
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
| `/read-output [name]` | Choose where readings sound: local or an output from outputs.json | With a name, switches to that output; without one, asks. See [Outputs](#outputs). |
| `/read-voice [male\|female]` | Choose the voice for the next readings: male (default) or female | With a name, switches the voice; without one, asks. |
| `/read-speed [n]` | Choose the voice speed for the next readings, 0.5 to 2.0 (default 1.1); saved for later sessions | With a number, sets that speed; without one, offers 0.8 to 1.5. See [Speed](#speed). |

While a reading plays, the footer shows `Reading P12.R1 on local · Esc stops` (or the file name, as in
`Reading notes.md on local · Esc stops`).

- **Esc** stops the reading. While a reading plays, Esc is taken by the reader, so it does not also
  interrupt a running agent turn at that moment; press it again for that.
- **A new `/read`** stops the reading that is playing and starts the new one.
- The output and the voice last for the session. A new session starts with the male voice and asks for the
  output again on its first reading (only when there is more than `local` to choose from).

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
against the session's working directory. The file goes through the same cleanup, voice, output, Esc and
footer as a reply.

- A missing or unreadable file gets one warning naming the path as you typed it, such as
  `Cannot read "notes.md": file not found.`, and nothing plays (and no voice download is offered).
- A file with nothing to read says `notes.md has nothing to read.`

### Speed

The voice reads at speed 1.1 by default (1.0 is Supertonic's own pace). `/read-speed 1.15` sets any speed
from 0.5 to 2.0, and a comma decimal works too (`/read-speed 1,15`); it confirms with
`Readings will use speed 1.15.` `/read-speed` alone offers 0.8, 0.9, 1.0, 1.1, 1.2, 1.3 and 1.5. Anything
else says `Speed must be a number from 0.5 to 2.0.` and changes nothing.

- The choice is saved in `$XDG_CONFIG_HOME/pi-reply-reader/settings.json` (`~/.config/…` when
  `XDG_CONFIG_HOME` is unset) as `{ "speed": 1.15 }`, keeping any other keys, and every later session and
  reading uses it. A reading already playing keeps its speed.
- Only the voice speed changes; the pauses between sentences, lines and sections stay the same.
- No file means 1.1. An invalid file, or a speed outside 0.5 to 2.0, is ignored with one warning per
  session, and readings use 1.1. `/read-speed` does not overwrite a file that is not valid JSON.
- If the file cannot be saved, the speed still applies to this session and a warning says it was not saved.

## How replies are cleaned for listening

The cleanup is deterministic and needs no model, so the same reply always sounds the same.

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
- **Technical names** are read by kind (`snake_case` loses its `_` everywhere):
  - a path, as its file or folder plus where it is: `~/.gentle-shell/agent/AGENTS.md` becomes "AGENTS punto md,
    en agent", `/tmp/x/wav/hs/` becomes "la carpeta hs, en wav";
  - a path with a line: `src/speech-text.ts:42` becomes "speech text punto ts, en src, línea 42";
  - a file name: `README.md` becomes "README punto md";
  - a branch: `origin/main` becomes "la rama origin main" (after "rama", only the name);
  - a command: `/reload` becomes "el comando reload" ("del `/reload`" becomes "del comando reload"), while
    system folders such as `/tmp` read as "la carpeta tmp";
  - a commit hash is dropped after "commit" and read as "un commit" elsewhere;
  - a pair of words: `light/dark` becomes "light o dark".

  Fractions like `1/2`, versions, dates and short pairs like `y/o` stay as they are.

### Known limits

- Kinds are guessed from the text alone, so some names are misread: two-word paths such as `odd/tasks`
  or MIME types such as `application/json` read as alternatives ("odd o tasks"), web routes such as
  `/users` read as commands, files without an extension read as folders, and some hosts or code names
  read as file names (`org.bluez` becomes "org punto bluez").
- The voice speaks Spanish (and the code-block announcement is Spanish); English words are read with
  Spanish pronunciation.

## Outputs

An output is where a reading sounds. `local` is always there: this machine's default sink. You add others
in `$XDG_CONFIG_HOME/pi-reply-reader/outputs.json` (`~/.config/pi-reply-reader/outputs.json` when
`XDG_CONFIG_HOME` is unset), an object that maps each name to a `PULSE_SERVER` value:

```json
{ "desktop": "tcp:127.0.0.1:4714" }
```

- Names use letters, digits and `-`, and `local` is built in, so it cannot be redefined.
- Each value must be a non-empty string.
- The first `/read` of a session asks `Where should readings sound?` when there is more than one output;
  `/read-output` switches later, and completes the names.
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
   user ID on the desktop, `id -u`) and the user in `danielblc@${AUDIO_HOST}`. The server must reach the
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
with `Playback on "desktop" failed: …` in the meantime. To keep the tunnel running after you log out of the
server, enable lingering for your user there (`loginctl enable-linger`).

The desktop needs only PipeWire (with pipewire-pulse) or PulseAudio and an SSH server. It needs no TTS, no
Pi and no change to its configuration. A new client is one more unit and one more entry in `outputs.json`.

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
```

## License

MIT for this package.

The voice is downloaded separately and has its own licenses:

- Supertonic 3 weights: OpenRAIL-M, see
  [Supertone/supertonic-3](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE).
- Supertonic code: MIT, see [supertone-inc/supertonic](https://github.com/supertone-inc/supertonic).
- sherpa-onnx, which runs it: [Apache-2.0](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE).

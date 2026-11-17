# Changelog

## Unreleased

- `/read` reads a reply aloud on request only: the latest reply of the branch, or one by ID with
  `/read P12.R1` (any case, a `.Q<n>` suffix accepted, numbered like `pi-reply-thread`'s `/replies`) or by
  its entry ID. Nothing plays by itself. A new reading stops the one playing, and Esc stops it; the footer
  shows `Reading P12.R1 on local · Esc stops` meanwhile.
- `/read <file.md>` reads a Markdown file aloud (`.md` or `.markdown`, any case), resolved against the
  session's working directory (absolute and `~/` paths work too), with the same cleanup, voice, output,
  Esc and footer as a reply. A missing or unreadable file gets one warning naming it, and nothing plays.
- Local Spanish voice, Supertonic 3 through sherpa-onnx-node 2.0.1, on the CPU with no API key. The first
  `/read` asks before downloading it once (129 MB, pinned size and sha256) into
  `$XDG_DATA_HOME/pi-reply-reader/voices`; a failed download keeps nothing. Text is synthesized sentence by
  sentence, so audio starts after the first sentence, and both voices are brought to the same loudness.
- `/read-voice [male|female]` picks the voice for the next readings: male (default) or female.
- Replies are cleaned for listening: Markdown syntax is removed, table rows become sentences, code blocks
  are announced as "Bloque de código.", URLs are read as their host, reply IDs as "P 11, R 1, Q 1",
  symbols such as `→` and `≈` as words, emoji are dropped, and paths and branches are read as words.
  Approximations and units are spelled out, numbered items read "1:" instead of stopping after the number,
  and bold-only lines and headings are read as titles.
- Named outputs: `local` (this machine's default sink) plus the names in
  `$XDG_CONFIG_HOME/pi-reply-reader/outputs.json`, each mapped to a `PULSE_SERVER`. The first `/read` of a
  session asks which one when there is more than `local`; `/read-output [name]` switches. Bad entries are
  skipped with a warning.
- `examples/reply-reader-desktop-audio.service`: a systemd user unit that tunnels the audio over SSH to the
  machine you sit at, which needs only PipeWire or PulseAudio, with no port opened on it.

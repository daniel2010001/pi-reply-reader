# TTS bake-off on hs-node (CPU), 2026-10-27

The hs-CPU part of the listening test (task L15). hs-node has 4 threads and no GPU, and
other Pi sessions were running at the same time (load average 2.7 to 4.7). Every engine
ran through `sherpa-onnx-node` with `numThreads: 2`, `speed: 1.0` and the three texts in
`odd/bakeoff/texts/` (byte-identical to `/tmp/reply-reader-bakeoff/texts/`). These are
measurements only. Nobody has listened to the audio yet.

## Results

RTF = generation time / audio seconds (below 1 is faster than real time). first_segment_ms
is the wall time to synthesize only segment 1 (`text.split(/(?<=[.!?…:;])\s+|\n+/)`,
trimmed, empty ones dropped) with the model loaded, after one discarded warm-up run.
first chunk ms is the time to the first `onProgress` callback when the whole text goes to
`generateAsync`.

| Engine | Voice | Load s | RTF short / medium / long | first_segment_ms short / medium / long | First chunk ms short / medium / long | Peak RSS MB | Disk MB | Sample rate | License (code; weights) |
|---|---|---|---|---|---|---|---|---|---|
| Piper (reference), sherpa-onnx-node 1.13.8 | es_MX-claude-high | 1.19 | 0.12 / 0.11 / 0.11 | 145 / 232 / 126 | 200 / 251 / 711 | 534 | 111 (32 lib + 79 voice) | 22050 | Apache-2.0 binding, bundles GPL-3.0 espeak-ng; voice Apache-2.0 per MODEL_CARD |
| Supertonic 3 (int8), sherpa-onnx-node 2.0.1, `lang: es`, `numSteps: 8` | sid 0 (female, F0 about 185 Hz) | 0.97 | 0.49 / 0.46 / 0.55 | 1173 / 1547 / 1187 | 5932 / 10639 / 13353 | 549 | 171 (32 lib + 139 model) | 44100 | sherpa Apache-2.0 (GPL-free in v2), Supertonic code MIT; weights OpenRAIL-M |
| Supertonic 3 (int8), same | sid 6 (male, F0 about 90 Hz) | 1.08 | 0.58 / 0.57 / 0.55 | 1118 / 1725 / 1207 | 6861 / 12468 / 13221 | 536 | same | 44100 | same |
| Kokoro-82M v1.0 (int8 multi-lang), sherpa-onnx-node **1.13.8** + espeak-ng `lang: es` | ef_dora (sid 28) | 1.48 | 1.69 / 1.89 / 1.92 | 1982 / 4145 / 2273 | 2172 / 4571 / 12909 | 619 | 215 (32 lib + 183 model) | 24000 | Apache-2.0 binding, bundles GPL-3.0 espeak-ng (the archive also ships GPL espeak-ng-data); weights Apache-2.0 |
| Kokoro-82M, same | em_alex (sid 29) | 1.38 | 1.52 / 1.58 / 1.59 | 1996 / 4247 / 2327 | 1891 / 4328 / 9964 | 633 | same | 24000 | same |

Audio length (s) for short / medium / long: Piper 10.5 / 36.6 / 97.1; Supertonic F 12.1 / 43.2 / 116.4
and M 11.9 / 42.5 / 114.5; Kokoro ef_dora 9.6 / 33.1 / 88.9 and em_alex 9.8 / 34.0 / 90.2.
Seconds of audio per 1000 characters: Piper 63-67, Supertonic 72-81, Kokoro 58-63.

License URLs:
- sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE (Apache-2.0). Issue #3731 and PR #4055 cover the espeak-ng removal in v2.
- espeak-ng: https://github.com/espeak-ng/espeak-ng/blob/master/COPYING (GPL-3.0).
- Piper voice es_MX-claude-high: https://huggingface.co/spaces/HirCoir/Piper-TTS-Spanish (the model card says apache-2.0).
- Supertonic 3 weights: https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE (OpenRAIL-M). Code: https://github.com/supertone-inc/supertonic (MIT, also shipped as the archive's `LICENSE`).
- Kokoro-82M weights: https://huggingface.co/hexgrad/Kokoro-82M (Apache-2.0).

## Skipped-word check

Each word went into the carrier sentence "Ahora hago el ___ y sigo.". The table shows the
seconds of active speech (20 ms frames with RMS above 0.02) that the word adds over the
carrier alone. No engine skipped any word: every word adds audio. Whether the words sound
right still needs listening.

| Word | Piper | Supertonic F / M | Kokoro dora / alex |
|---|---|---|---|
| push | 0.36 | 0.08 / 0.08 | 0.14 / 0.14 |
| commit | 0.42 | 0.22 / 0.34 | 0.22 / 0.20 |
| merge | 0.56 | 0.14 / 0.20 | 0.22 / 0.20 |
| feat/phone-panel | 1.02 | 0.50 / 0.52 | 0.70 / 0.68 |
| P11.R1.Q1 | 1.74 | 1.02 / 0.96 | 1.40 / 1.38 |
| ~/.gentle-shell | 1.04 | 0.80 / 0.76 | 0.78 / 0.76 |

Supertonic gives "push" only 0.08 s of active speech, the shortest of all. It is worth
checking by ear whether it comes out clipped. Piper is longer on every word, likely because
espeak spells things out.

## Why Supertonic's first chunk takes 6-13 s

In sherpa-onnx v2.0.1 Supertonic does not stream per sentence. In
`sherpa-onnx/csrc/offline-tts-supertonic-impl.cc`, `Generate` ignores `maxNumSentences`.
It runs `ChunkText(text, max_len)` with `max_len` defaulting to 300 characters (120 for
ko/ja, configurable through `extra.max_len`). `ProcessChunksAndConcatenate` then calls the
callback once per chunk of up to 300 characters, and inserts 0.3 s of silence between chunks
(`extra.silence_duration`). Callback counts I measured with sid 0: short gives 1 callback
(the whole 12.1 s at 5.2 s), medium 2 (21.9 s and 21.0 s of audio), long 6 (the first
holds 23.4 s and arrives at 10.0 s). Piper (VITS, `maxNumSentences: 1`) calls back once per
sentence: 2, 8 and 17 callbacks. To get early audio from Supertonic, the caller has to
split the text itself and call `generate` per segment. Done that way, the first audio
arrives in about 1.1-1.7 s (first_segment_ms).

## WAV files (not in the repo)

`/tmp/reply-reader-bakeoff/wav/hs/<engine>-<voice>-<text>.wav`, where text is `1-short`,
`2-medium` or `3-long`:
- `piper-claude-{1-short,2-medium,3-long}.wav`
- `supertonic-F-sid0-{…}.wav`, `supertonic-M-sid6-{…}.wav`
- `kokoro-ef_dora-{…}.wav`, `kokoro-em_alex-{…}.wav`
- Word probes: `/tmp/reply-reader-bakeoff/wav/hs/probes/<engine>-<voice>-<word>.wav`

## Commands and scripts

All under `/tmp/reply-reader-bakeoff/`. Raw JSON results are in `logs/`.
- `scripts/bench.cjs <engine> <voice> <sid> <sherpaDir> <modelDir> <textsDir> <outDir> [scan]`
  measures load, generation, RTF, first chunk, peak RSS, active seconds, median F0, and runs
  the word probes. Env `ONLY_TEXT=<file>` runs one text and `NO_PROBES=1` skips the probes.
  Peak RSS is `VmHWM` from `/proc/self/status`, because `/usr/bin/time` is not installed on
  hs-node. The `scan` mode is how I picked the Supertonic speakers: median F0 for sids 0-9 was
  194, 219, 159, 210, 166, 125, 95, 98, 130, 89 Hz.
- `scripts/first-segment.cjs <engine> <voice> <sid> <sherpaDir> <modelDir> <textsDir> [chunks]`
  measures first_segment_ms and the callback count and timing on the whole text.
- `scripts/run-rest.sh <bakeoff dir>` ran the Kokoro texts, the probes and every
  first-segment run one after another.
- `scripts/kokoro-sherpa-probe.cjs` (Kokoro on v2, fails), `scripts/kokoro-v1-probe.cjs`
  (Kokoro on 1.13.8, works), `scripts/phon-probe.mjs`, `scripts/phon-err.mjs` (phonemizer.js)
  and `scripts/kokorojs-voice-check.mjs`.
- Example: `node scripts/bench.cjs supertonic F-sid0 0 sherpa2 models-supertonic/sherpa-onnx-supertonic-3-tts-int8-2026-05-11 texts wav/hs`.
- Engines: Piper reuses `/tmp/reply-reader-sherpa`, read-only (1.13.8 plus `vits/`).
  Supertonic and Kokoro use `sherpa2/` (`npm install sherpa-onnx-node@2.0.1`).
- Downloads from the GitHub release `tts-models` (asset list from release 130612623). Size
  and sha256 matched before extraction, and each archive went into its own new directory:
  - `sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2`: 128,774,318 B, `82fa96f9…c427`, extracted to `models-supertonic/`.
  - `kokoro-int8-multi-lang-v1_0.tar.bz2`: 132,353,410 B, `72c34723…0653`, extracted to `models-kokoro/`.

## Problems found

1. **Kokoro has no Spanish path in sherpa-onnx v2.** v2.0.1 warns "--kokoro-lang is
   deprecated and ignored in sherpa-onnx >= v2.0.0. espeak-ng is no longer used. Language is
   determined by the lexicon files you provide". The multi-lang archives only ship
   `lexicon-us-en.txt`, `lexicon-gb-en.txt` and `lexicon-zh.txt`. Spanish text then logs
   "OOV word skipped: 'de'" / "'está'" / "'listo'", so Spanish words are dropped silently.
   The `phonemeCodepoints` route needs a Spanish phonemizer (see 2).
2. **kokoro-js 1.2.1 cannot do Spanish.** Its voice table only lists en-us and en-gb voices
   ("Voice "ef_dora" not found. Should be one of: af_heart, …, bm_fable."). Its phonemizer
   (`phonemizer` 1.2.1, espeak-ng compiled to WASM) only ships English: `Invalid language
   identifier: "es". Should be one of: en, en-029, en-gb, …`. `npm install kokoro-js` also
   fails building `sharp` from source ("Please add node-addon-api to your dependencies"),
   so it was installed with `--ignore-scripts` (409 MB node_modules, not used further).
3. **Kokoro works only through sherpa-onnx-node 1.13.8 with GPL espeak-ng** (the same
   binary T4 pins), via `dataDir: espeak-ng-data, lang: "es"`. It runs slower than real time
   on this CPU: RTF 1.5-1.9, and the long text took 143-170 s for 89-90 s of audio. Played
   per segment, it would stall between sentences. Two early Kokoro runs overlapped each other
   (RTF 2.7 and 2.1). They were discarded (`logs/*.overlap.json`) and rerun one at a time.
4. **Supertonic outputs 44100 Hz.** The sherpa sample page says 24000. `tts.sampleRate` and
   the WAVs are 44100, so playback must use the rate the engine reports. Its default
   `extra.seed` is -1 (random), so the same text gives different audio on each run. Pass a
   fixed `seed` for reproducible output.
5. **Supertonic is slower than Piper and leaves more silence.** RTF is 0.46-0.58 against
   0.11, and audio per character is about 20 % longer than Piper's. Only 49-65 % of its
   audio is active speech, against 77-80 % for Piper.
6. Peak RSS is about 530-630 MB for every engine, measured while synthesizing the long text
   as one call. RSS after load: Piper 141 MB, Supertonic 244 MB, Kokoro 272 MB.
7. The machine was shared, so absolute times carry noise of maybe ±20 %. The ordering
   (Piper ≪ Supertonic < 1 < Kokoro) held on every run.

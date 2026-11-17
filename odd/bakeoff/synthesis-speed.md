# Synthesis speed on hs-node under load (T25), 2026-11-17

Measurement only (L67-L69); no source file changed. Supertonic 3 int8 via sherpa-onnx-node 2.0.1, installed voice,
male sid 6, speed 1.1, seed 42, `lang: "es"`, one `OfflineTts` per process and thread count, one discarded warm-up
("Hola.") before timing. Texts: `speechText` of two real pi-reply-reader replies (2026-11-17), split with a copy of
`fragments`: medium 660 chars, 8 fragments, 40.6 s of audio; long 1,869 chars, 28 fragments, 107 s. Audio
durations are after `trimSilence` (as playback does), without our pauses. Runs r1 (threads 2→3→4, steps 8→6→4,
medium then long) and r2 (the reverse order), plus one run of the default under a 2-core Node busy loop
(`stress`) and a 1-thread check (`x1`). Other Pi sessions were running throughout (load average 2.0-9.3 before
a run, our own synthesis included); nothing was stopped or reniced.

**CPU state found:** i7-6500U (2 cores, 4 threads), `intel_pstate` governor `powersave`, EPP `power`,
platform profile `power-saver`. Cores sat at 500 MHz idle and only 900 MHz under the busy loop (max 3.1 GHz).

## Summary (mean of r1 and r2; waits from the ideal simulation)

| Steps | Threads | RTF medium | Waits medium (n / total) | RTF long | Waits long (n / total) | 1st fragment s (medium / long) |
|---|---|---|---|---|---|---|
| 8 (today) | 2 | 1.46 | 4 / 13.0 s | 1.61 | 18-20 / 53.5 s | 8.6 / 6.5 |
| 8 | 3 | 1.76 | 4 / 23.7 s | 1.94 | 21-22 / 87.5 s | 10.5 / 7.7 |
| 8 | 4 | 1.95 | 5 / 30.1 s | 2.19-3.10 | 23-25 / 113-211 s | 11.6 / 8.3 |
| 6 | 2 | 1.14 | 1 / 2.9 s | 1.26 | 4-6 / 14.7-19.0 s | 6.7 / 4.8 |
| 6 | 3 | 1.38 | 4 / 10.5 s | 1.54 | 17-18 / 46.2 s | 7.9 / 5.9 |
| 6 | 4 | 1.58 | 4 / 16.8 s | 1.75-2.22 | 21-22 / 67-116 s | 9.6 / 8.2 |
| **4** | **2** | **0.82** | **0 / 0 s** | **0.90** | **0-1 / 0-0.3 s** | **4.8 / 3.7** |
| 4 | 3 | 1.00 | 1 / 1.2 s | 1.12 | 2 / 7.4 s | 6.0 / 4.5 |
| 4 | 4 | 1.11-1.93 | 1-5 / 1.6-28.0 s | 1.29-1.43 | 10-11 / 21-35 s | 9.6 / 5.5 |
| 8 + stress | 2 | 2.50 | 6 / 49.0 s | 2.69 | 24 / 164.8 s | 15.1 / 10.8 |
| 8 (x1) | 1 | 2.06 | 5 / 33.5 s | — | — | 12.7 / — |
| 4 (x1) | 1 | 1.14 | 1 / 3.1 s | — | — | 6.9 / — |

More threads is slower at every step count: 2 threads is the best setting here; 1 thread is slower too.
Model load (fresh process, cold `createAsync`): 2.6-3.0 s, 3.6 s under the busy loop (hs-cpu.md had about 1 s).

## Simulation

Times are per-fragment synthesis wall times from the runs; t = 0 is the start of fragment 1's synthesis (the
"1st fragment" column is the silence before the first word, model load not included). A wait is counted when
fragment i+1 is ready more than 0.05 s after the player finished what it had; the length is the extra silence
on top of our pause.

- **ideal**: fragment i is written with its own pause, so synthesis of i+1 overlaps both (the model in the task).
- **code order**: as `startReading` actually writes, the pause of i goes in front of fragment i+1, so it only
  starts once i+1 is synthesized; the pause no longer hides synthesis time. Adds 0.3-0.8 s over ideal here.
- **code order + 2.7 s lookahead** (assumption, not measured): `startReading` awaits `drain` after each write, so
  synthesis of i+1 only starts when the player's buffers (64 KB pipe ≈ 0.74 s plus an assumed ~2 s in
  paplay/Pulse) are all that is left of fragment i. If that holds, even 4 steps / 2 threads waits at most
  fragment boundaries. Measuring the real lookahead needs audio playback, which this task excluded.

## All runs

| Text | Steps | Threads | Run | Load1 before | Model load s | Synth s | Audio s (trimmed) | RTF | 1st fragment s | Waits ideal (n / total) | Waits code order | Waits code order + 2.7 s lookahead |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| medium | 8 | 1 | x1 | 4.15 | 2.63 | 83.8 | 40.7 | 2.06 | 12.65 | 5 / 33.5 s | 5 / 34.3 s | 7 / 52.8 s |
| medium | 8 | 2 | r1 | 2.38 | 2.63 | 58.1 | 40.7 | 1.43 | 8.48 | 4 / 12.1 s | 4 / 12.8 s | 7 / 31.3 s |
| medium | 8 | 2 | r2 | 2.65 | 2.70 | 60.1 | 40.7 | 1.48 | 8.68 | 4 / 13.9 s | 4 / 14.7 s | 7 / 33.2 s |
| medium | 8 | 2 | stress | 3.01 | 3.62 | 101.7 | 40.7 | 2.50 | 15.06 | 6 / 49.0 s | 6 / 49.7 s | 7 / 68.2 s |
| medium | 8 | 3 | r1 | 3.12 | 3.00 | 72.5 | 40.7 | 1.78 | 10.62 | 4 / 24.3 s | 4 / 25.1 s | 7 / 43.6 s |
| medium | 8 | 3 | r2 | 4.13 | 2.86 | 71.0 | 40.7 | 1.74 | 10.41 | 4 / 23.0 s | 4 / 23.8 s | 7 / 42.3 s |
| medium | 8 | 4 | r1 | 4.63 | 2.81 | 78.7 | 40.7 | 1.93 | 12.01 | 5 / 29.1 s | 5 / 29.8 s | 7 / 48.3 s |
| medium | 8 | 4 | r2 | 9.30 | 2.84 | 79.8 | 40.7 | 1.96 | 11.12 | 5 / 31.0 s | 5 / 31.8 s | 7 / 50.3 s |
| medium | 6 | 2 | r1 | 2.60 | 2.63 | 45.3 | 40.6 | 1.12 | 6.56 | 1 / 2.8 s | 1 / 3.1 s | 6 / 20.5 s |
| medium | 6 | 2 | r2 | 2.60 | 2.70 | 46.8 | 40.6 | 1.15 | 6.76 | 1 / 2.9 s | 2 / 3.4 s | 6 / 21.8 s |
| medium | 6 | 3 | r1 | 4.41 | 3.00 | 56.2 | 40.6 | 1.38 | 7.87 | 4 / 10.8 s | 4 / 11.5 s | 7 / 30.0 s |
| medium | 6 | 3 | r2 | 4.23 | 2.86 | 55.6 | 40.6 | 1.37 | 7.91 | 4 / 10.2 s | 4 / 10.9 s | 7 / 29.4 s |
| medium | 6 | 4 | r1 | 6.87 | 2.81 | 63.4 | 40.6 | 1.56 | 9.25 | 4 / 16.6 s | 4 / 17.3 s | 7 / 35.8 s |
| medium | 6 | 4 | r2 | 6.24 | 2.84 | 64.5 | 40.6 | 1.59 | 9.89 | 4 / 17.0 s | 4 / 17.8 s | 7 / 36.2 s |
| medium | 4 | 1 | x1 | 2.03 | 2.63 | 46.1 | 40.5 | 1.14 | 6.86 | 1 / 3.1 s | 1 / 3.5 s | 6 / 21.0 s |
| medium | 4 | 2 | r1 | 3.35 | 2.63 | 33.2 | 40.5 | 0.82 | 4.77 | 0 / 0.0 s | 1 / 0.4 s | 5 / 10.5 s |
| medium | 4 | 2 | r2 | 2.93 | 2.70 | 33.4 | 40.5 | 0.82 | 4.74 | 0 / 0.0 s | 1 / 0.3 s | 5 / 10.9 s |
| medium | 4 | 3 | r1 | 4.00 | 3.00 | 40.6 | 40.5 | 1.00 | 6.28 | 1 / 1.2 s | 1 / 1.5 s | 7 / 16.0 s |
| medium | 4 | 3 | r2 | 4.77 | 2.86 | 40.7 | 40.5 | 1.00 | 5.74 | 1 / 1.2 s | 1 / 1.6 s | 6 / 16.6 s |
| medium | 4 | 4 | r1 | 6.03 | 2.81 | 45.0 | 40.5 | 1.11 | 6.78 | 1 / 1.6 s | 1 / 2.0 s | 7 / 19.9 s |
| medium | 4 | 4 | r2 | 6.30 | 2.84 | 78.0 | 40.5 | 1.93 | 12.35 | 5 / 28.0 s | 5 / 28.7 s | 7 / 47.1 s |
| long | 8 | 2 | r1 | 2.49 | 2.63 | 171.5 | 107.2 | 1.60 | 6.75 | 18 / 51.8 s | 18 / 52.3 s | 27 / 96.2 s |
| long | 8 | 2 | r2 | 2.79 | 2.70 | 174.2 | 107.2 | 1.62 | 6.18 | 20 / 55.1 s | 20 / 55.6 s | 27 / 99.6 s |
| long | 8 | 2 | stress | 4.47 | 3.62 | 288.7 | 107.2 | 2.69 | 10.79 | 24 / 164.8 s | 24 / 165.3 s | 27 / 209.2 s |
| long | 8 | 3 | r1 | 4.32 | 3.00 | 208.3 | 107.2 | 1.94 | 7.66 | 21 / 87.7 s | 21 / 88.1 s | 27 / 132.1 s |
| long | 8 | 3 | r2 | 4.30 | 2.86 | 207.9 | 107.2 | 1.94 | 7.79 | 22 / 87.2 s | 22 / 87.7 s | 27 / 131.6 s |
| long | 8 | 4 | r1 | 4.75 | 2.81 | 234.5 | 107.2 | 2.19 | 8.23 | 23 / 113.2 s | 23 / 113.7 s | 27 / 157.6 s |
| long | 8 | 4 | r2 | 6.62 | 2.84 | 332.9 | 107.2 | 3.10 | 8.37 | 25 / 211.3 s | 25 / 211.8 s | 27 / 255.7 s |
| long | 6 | 2 | r1 | 2.86 | 2.63 | 131.6 | 107.0 | 1.23 | 4.73 | 4 / 14.7 s | 4 / 15.5 s | 24 / 58.6 s |
| long | 6 | 2 | r2 | 2.97 | 2.70 | 136.4 | 107.0 | 1.28 | 4.79 | 6 / 19.0 s | 6 / 19.8 s | 24 / 63.3 s |
| long | 6 | 3 | r1 | 4.09 | 3.00 | 164.1 | 107.0 | 1.53 | 5.82 | 17 / 45.6 s | 16 / 46.1 s | 27 / 89.9 s |
| long | 6 | 3 | r2 | 4.08 | 2.86 | 165.4 | 107.0 | 1.55 | 5.91 | 18 / 46.8 s | 18 / 47.3 s | 27 / 91.1 s |
| long | 6 | 4 | r1 | 5.76 | 2.81 | 186.8 | 107.0 | 1.75 | 7.19 | 21 / 66.8 s | 21 / 67.3 s | 27 / 111.2 s |
| long | 6 | 4 | r2 | 8.13 | 2.84 | 237.7 | 107.0 | 2.22 | 9.12 | 22 / 115.8 s | 22 / 116.3 s | 27 / 160.1 s |
| long | 4 | 2 | r1 | 3.60 | 2.63 | 94.9 | 107.3 | 0.88 | 3.60 | 1 / 0.3 s | 1 / 0.6 s | 16 / 24.0 s |
| long | 4 | 2 | r2 | 3.98 | 2.70 | 97.5 | 107.3 | 0.91 | 3.71 | 0 / 0.0 s | 1 / 0.4 s | 19 / 26.2 s |
| long | 4 | 3 | r1 | 4.25 | 3.00 | 119.5 | 107.3 | 1.11 | 4.51 | 2 / 7.3 s | 2 / 8.0 s | 22 / 46.6 s |
| long | 4 | 3 | r2 | 6.18 | 2.86 | 119.8 | 107.3 | 1.12 | 4.51 | 2 / 7.4 s | 2 / 8.1 s | 24 / 46.9 s |
| long | 4 | 4 | r1 | 7.33 | 2.81 | 138.9 | 107.3 | 1.29 | 5.44 | 10 / 20.8 s | 10 / 21.5 s | 26 / 65.0 s |
| long | 4 | 4 | r2 | 6.00 | 2.84 | 153.6 | 107.3 | 1.43 | 5.56 | 11 / 34.8 s | 11 / 35.3 s | 26 / 79.5 s |

## Listening samples

`/tmp/reply-reader-steps/steps-8.wav` (44.76 s), `steps-6.wav` (44.69 s), `steps-4.wav` (44.56 s): the medium
text, 44.1 kHz mono s16le, with the speaker gain, limiter, silence trim and our pauses exactly as playback writes
them (copied logic). Thread count does not change the audio: the medium PCM for each step count is byte-identical
(sha256) across threads 2, 3, 4 and both runs.

## Conclusion

1. At today's load only **numSteps 4 with numThreads 2** keeps both texts gap-free in the ideal pipeline (RTF
   0.82 / 0.90, at most one 0.3 s wait); 6 steps / 2 threads still starves the long text (4-6 waits, 15-19 s).
2. Extra threads hurt on this 2-core CPU, and the CPU is in `power-saver` (≤ 900 MHz under load), which likely
   explains RTF 1.4-2.5 today against 0.46-0.58 in hs-cpu.md; raising the profile may help more than any setting.
3. Fewer flow-matching steps can sound rougher or less natural (Supertonic's quality knob); whether 4 steps is
   acceptable is for the owner to judge from the samples. Writing each pause with its own fragment would
   also stop synthesis lateness from adding to our pauses.

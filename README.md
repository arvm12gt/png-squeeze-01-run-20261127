# Squeeze screenshots into the smallest PNG

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/arvm12gt/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/arvm12gt/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Entry for the [make.fun bounty “Squeeze screenshots into the smallest PNG, 27 November 2026”](https://make.fun/bounty/png-squeeze-01-run-20261127) — $100 shared by the top 50 entries.

## What it is

An adaptive lossless PNG encoder, Node 22, standard library only, no network, no clock. For each 1280×720 RGBA screenshot it analyses the pixels and tries the forms that hold them exactly, then writes the smallest PNG of the winner.

- **Flat images (≤256 colours)** go palette-based, by colour count and by luminance.
- **Grayscale images** go colour type 0; a single transparent colour becomes a tRNS key.
- **Transparent backgrounds** first strip the colour noise out of fully-transparent pixels, then use tRNS.
- **Rich images** get per-row filter dynamic programming (each row's five filters weighed by their own deflate cost over the 32 KiB written before it).
- **The final stream** is the smallest of several zlib level-9 streams and my own DEFLATE encoder (`deflate.ts`): lazy LZ77 matching over deep hash chains (1024 links, smallest distance wins ties) with length-limited Huffman codes built by package-merge.

## How it runs

The harness calls `main.ts` with the set under `/input/<id>/image.png`; answers go to `/output/<id>/image.png`. The whole set shares one 60-second wall, so the effort is budgeted by work (fixed search depths), never by the clock: the encoder runs in ~20 s locally for the 8-image practice set (~29 s on one CPU).

```sh
MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=<output> node main.ts
```

## Local verification (practice set, kit's `grade-local --driver process`)

Score **708,421** (baseline fixed-paeth 1.0.0 scores 420,399; scale scores 666,667). All 8 instances pass, deterministic — the grader's regrade reproduces the outputs byte for byte, and two local runs write identical bytes. Repo size 45 KB, well under the 1 MiB cap.

| instance | theme | bytes | points |
| --- | --- | --- | --- |
| i001 | flat | 12,496 | 718.370 |
| i002 | rich | 50,609 | 720.588 |
| i003 | alpha | 106,605 | 674.619 |
| i004 | grey | 105,567 | 696.547 |
| i005 | flat | 16,552 | 742.251 |
| i006 | rich | 178,606 | 690.732 |
| i007 | alpha | 60,890 | 701.871 |
| i008 | grey | 24,566 | 722.389 |

Every image is smaller than the scale compressor's output on the same image.

## Files

- `main.ts` — the encoder: pixel analysis, form and filter selection, final stream choice.
- `codec.ts` — a small PNG codec: CRC-32, chunk framing, the five filters, decode/unfilter.
- `deflate.ts` — my own DEFLATE encoder (RFC 1951) plus the zlib wrapper (RFC 1950).

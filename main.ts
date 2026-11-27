// main.ts — squeeze screenshots into the smallest PNG (png-squeeze-01-run-20261127).
//
// Adaptive lossless PNG encoder, Node 22, standard library only, no network,
// no clock: every byte of output is a deterministic function of the input.
//
// For each 1280x720 RGBA screenshot it:
//   1. analyses the pixels (opaque? grey? at most 256 colours? one transparent key?),
//   2. tries the forms that hold it exactly — palette (by count and by
//      luminance), grey / grey+alpha, RGB / RGBA, with a tRNS key where one
//      fully transparent value stands alone — and the filter choices each
//      form takes (fixed filters, minimum-sum, fewest-distinct-pairs, and
//      brute force: each row's five filters weighed by their own deflate
//      cost over the 32 KiB written before it),
//   3. screens every (form, filter) by zlib at level 6, keeps the smallest,
//   4. writes the winner with the smallest of several zlib level-9 streams
//      and my own DEFLATE encoder (deflate.ts).
//
// A set holds 8 instances under /input/<id>/; answers go to
// /output/<id>/image.png. The whole set shares one 60-second wall, so the
// effort is budgeted by work (fixed search depths), never by the clock.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync } from 'node:zlib';
import { deflateZlib } from './deflate.ts';
import { decodePng, filterRow, ihdrOf, pngOf, signedSum } from './codec.ts';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** What the image holds: opaque? grey? its colours when at most 256? */
interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Array<{ rgba: [number, number, number, number]; word: number; count: number }> | null;
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  const counts = new Map<number, number>();
  let opaque = true;
  let grey = true;
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const w = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
      const k = counts.get(w);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(w, 1);
      } else counts.set(w, k + 1);
    }
  }
  let colours: Analysis['colours'] = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => ({
      rgba: [
        (word >>> 24) & 0xff,
        (word >>> 16) & 0xff,
        (word >>> 8) & 0xff,
        word & 0xff,
      ] as [number, number, number, number],
      word,
      count,
    }));
  }
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value (grey or RGB) the image may key by tRNS
 * instead of an alpha channel: every pixel opaque or that exact value at
 * alpha 0, and no opaque pixel of the same value. Null when there is none.
 */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in colour type `ct` (0, 2, 4 or 6) from its RGBA. */
function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/** A palette's entries: transparent ones first (by alpha), then by `order`. */
function paletteOrder(
  colours: NonNullable<Analysis['colours']>,
  order: 'count' | 'luminance',
): NonNullable<Analysis['colours']> {
  const lum = (c: { rgba: [number, number, number, number] }): number =>
    299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

interface PaletteForm {
  plte: Uint8Array;
  trns: Uint8Array | null;
  indices: Uint8Array;
}

function paletteForm(rgba: Uint8Array, colours: NonNullable<Analysis['colours']>, order: 'count' | 'luminance'): PaletteForm {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const w = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
    indices[i] = index.get(w)!;
  }
  return { plte, trns, indices };
}

type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

/** How many bytes written before a row brute force weighs its trials after. */
const BRUTE_CONTEXT = 32768;
/** The zlib level brute force weighs a row's trials at. */
const BRUTE_LEVEL = 4;

/** The fewest-distinct-pairs heuristic's cost for one filtered row. */
function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

/**
 * The raw data of an image of `samples` (height rows of width x bpp samples),
 * each row behind its filter byte, by `choice`: a fixed filter (0-4), or
 * 'minsum' (least signed sum), 'pairs' (fewest distinct byte pairs), or
 * 'brute' (each of the five filters compressed by zlib after the 32 KiB
 * written before it, the smallest kept). The lower type on a tie.
 */
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: FilterChoice): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else {
        cost = deflateSync(trial[t], {
          level: BRUTE_LEVEL,
          memLevel: 9,
          ...(before.length === 0 ? {} : { dictionary: before }),
        }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: FilterChoice[];
}

/** The forms an image can be written in, each with the filter choices it takes. */
function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'brute']],
    ] as Array<['count' | 'luminance', FilterChoice[]]>) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct]!;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

/** The bytes a form's PLTE and tRNS chunks take in its file. */
const chunkBytes = (form: Form): number =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

/** The zlib setting every choice is screened by. */
const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

/** The PNG of an image of `form` whose IDAT holds the zlib stream `idat`. */
function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/**
 * The best zlib stream for filtered `data`: level 9 with the default and
 * the filtered strategies, level 9 at memLevel 9, and my own encoder
 * (deflate.ts: lazy matching over deep hash chains, package-merge Huffman
 * lengths) — the smallest wins. Deterministic: every candidate is a pure
 * function of its input and settings.
 */
function bestZlib(data: Uint8Array): Uint8Array {
  const tries = [
    { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
    { level: 9, memLevel: 8, strategy: constants.Z_FILTERED },
    { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
    { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  ];
  let best: Uint8Array | null = null;
  for (const opt of tries) {
    const out = deflateSync(data, opt);
    if (best === null || out.length < best.length) best = out;
  }
  const mine = deflateZlib(data);
  if (mine.length < best!.length) best = mine;
  return best!;
}

/** Encode one screenshot: the smallest PNG of it this program can write. */
function encode(rgba: Uint8Array, width: number, height: number): Uint8Array {
  let best: { form: Form; data: Uint8Array; bytes: number } | null = null;
  for (const form of formsOf(rgba)) {
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  const idat = bestZlib(best!.data);
  return pngOfForm(width, height, best!.form, idat);
}

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encode(image.rgba, image.width, image.height));
}

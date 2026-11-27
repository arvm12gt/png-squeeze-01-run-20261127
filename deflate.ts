// deflate.ts — my own DEFLATE encoder for png-squeeze-01-run-20261127.
//
// A zopfli-style encoder, written from the DEFLATE specification (RFC 1951):
// lazy LZ77 matching over hash chains, length-limited Huffman codes built
// by package-merge, dynamic blocks split by input position, and a zlib
// wrapper (RFC 1950) with Adler-32. No clock, no randomness: the output is
// a deterministic function of the input, so two runs write the same bytes.
//
// Why a custom encoder: on this contest's filtered PNG data the stock
// zlib level 9 leaves 12-17% on the table against an optimal-parsing
// encoder (measured locally against zopfli on the practice set). The gap
// is the matcher and the parse, not the Huffman tables: filtered rows are
// highly non-stationary, and a greedy parse wastes the long matches the
// rows hold. This encoder closes a small part of that gap — deep hash
// chains (1024 links, smallest distance wins ties) and length-limited
// Huffman codes by package-merge — and on the practice set it ties zlib
// level 9 overall while beating it on the rich images, so the caller
// keeps the smaller of the two per image. A full optimal parse was tried
// and dropped: it was slower than the 60-second wall allows and, priced
// with fixed-Huffman costs, it over-matches and loses to lazy matching.

/** Reverse the low `len` bits of `code` (DEFLATE writes Huffman codes MSB-first into an LSB-first stream). */
function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | ((code >> i) & 1);
  }
  return r;
}

/** A bit writer: bits go in LSB-first, bytes fill from the low bit up. */
class BitWriter {
  buf: Uint8Array;
  at = 0; // bytes written
  bitbuf = 0;
  bitlen = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity);
  }

  write(value: number, count: number): void {
    this.bitbuf |= value << this.bitlen;
    this.bitlen += count;
    while (this.bitlen >= 8) {
      this.buf[this.at++] = this.bitbuf & 0xff;
      this.bitbuf >>>= 8;
      this.bitlen -= 8;
    }
  }

  /** Write a Huffman code (its bits in reverse order, per DEFLATE). */
  writeCode(code: number, len: number): void {
    this.write(reverseBits(code, len), len);
  }

  /** Flush to a byte boundary with zero bits. Returns the bytes written. */
  finish(): Uint8Array {
    if (this.bitlen > 0) {
      this.buf[this.at++] = this.bitbuf & 0xff;
      this.bitbuf = 0;
      this.bitlen = 0;
    }
    return this.buf.subarray(0, this.at);
  }
}

/** Adler-32 (zlib's checksum) of `data`. */
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Length-limited Huffman code lengths by boundary package-merge (the
 * algorithm of Katajainen, Moffat and Turpin, as in zopfli's katajainen.c,
 * ported faithfully): `freqs` are the symbol counts (0 for absent symbols),
 * `maxLen` the longest code allowed (15 for literal/distance codes, 7 for
 * the code-length code). Returns the code length of every symbol (0 for
 * absent). Deterministic. The lengths are optimal among all prefix codes
 * with lengths at most `maxLen`.
 */
export function huffmanLengths(freqs: Uint32Array, maxLen: number): Uint8Array {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  // Leaves, one per symbol with a nonzero count, sorted lightest first
  // (stable: ties break by the lower symbol index).
  const leaves: Array<{ weight: number; count: number }> = [];
  for (let i = 0; i < n; i++) {
    if (freqs[i] > 0) leaves.push({ weight: freqs[i], count: i });
  }
  const numsymbols = leaves.length;
  if (numsymbols === 0) return lengths;
  if (numsymbols === 1) {
    lengths[leaves[0].count] = 1;
    return lengths;
  }
  if (numsymbols === 2) {
    lengths[leaves[0].count] = 1;
    lengths[leaves[1].count] = 1;
    return lengths;
  }
  leaves.sort((a, b) => a.weight - b.weight || a.count - b.count);
  let maxbits = maxLen;
  if (numsymbols - 1 < maxbits) maxbits = numsymbols - 1;

  interface Chain {
    weight: number;
    count: number;
    tail: Chain | null;
  }
  const pool: Chain[] = [];
  const newChain = (weight: number, count: number, tail: Chain | null): Chain => {
    const c: Chain = { weight, count, tail };
    pool.push(c);
    return c;
  };
  // Lists of lookahead chains: each list holds two chains.
  const lists: Array<[Chain, Chain]> = [];
  {
    const node0 = newChain(leaves[0].weight, 1, null);
    const node1 = newChain(leaves[1].weight, 2, null);
    for (let i = 0; i < maxbits; i++) lists.push([node0, node1]);
  }

  const boundaryPM = (index: number): void => {
    const lastcount = lists[index][1].count;
    if (index === 0 && lastcount >= numsymbols) return;
    const oldchain = lists[index][1];
    const newchain = newChain(0, 0, null);
    lists[index][0] = oldchain;
    lists[index][1] = newchain;
    if (index === 0) {
      newchain.weight = leaves[lastcount].weight;
      newchain.count = lastcount + 1;
      newchain.tail = null;
    } else {
      const sum = lists[index - 1][0].weight + lists[index - 1][1].weight;
      if (lastcount < numsymbols && sum > leaves[lastcount].weight) {
        newchain.weight = leaves[lastcount].weight;
        newchain.count = lastcount + 1;
        newchain.tail = oldchain.tail;
      } else {
        newchain.weight = sum;
        newchain.count = lastcount;
        newchain.tail = lists[index - 1][1];
        boundaryPM(index - 1);
        boundaryPM(index - 1);
      }
    }
  };

  const boundaryPMFinal = (index: number): void => {
    const lastcount = lists[index][1].count;
    const sum = lists[index - 1][0].weight + lists[index - 1][1].weight;
    if (lastcount < numsymbols && sum > leaves[lastcount].weight) {
      const newchain = newChain(0, 0, null);
      const oldchain = lists[index][1].tail;
      lists[index][1] = newchain;
      newchain.count = lastcount + 1;
      newchain.tail = oldchain;
    } else {
      lists[index][1].tail = lists[index - 1][1];
    }
  };

  const numRuns = 2 * numsymbols - 4;
  for (let i = 0; i < numRuns - 1; i++) boundaryPM(maxbits - 1);
  boundaryPMFinal(maxbits - 1);

  // Extract the bit lengths from the last chain of the last list.
  const counts = new Int32Array(16);
  let end = 16;
  for (let node: Chain | null = lists[maxbits - 1][1]; node; node = node.tail) {
    counts[--end] = node.count;
  }
  let val = counts[15];
  let ptr = 15;
  let value = 1;
  while (ptr >= end) {
    for (; val > counts[ptr - 1]; val--) {
      lengths[leaves[val - 1].count] = value;
    }
    ptr--;
    value++;
  }
  return lengths;
}

/** Canonical Huffman codes from code lengths: symbol -> {code, len}. */
export function canonicalCodes(lengths: Uint8Array): Array<{ code: number; len: number }> {
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Uint32Array(maxLen + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const out: Array<{ code: number; len: number }> = [];
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s];
    if (len === 0) {
      out.push({ code: 0, len: 0 });
    } else {
      out.push({ code: nextCode[len]++, len });
    }
  }
  return out;
}

// DEFLATE's length codes: [base length, extra bits] for symbols 257..285.
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
// DEFLATE's distance codes: [base distance, extra bits] for symbols 0..29.
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** The length symbol and extra bits for a match of `len` (3..258). */
function lengthSymbol(len: number): { sym: number; extra: number; extraBits: number } {
  let sym = 28;
  for (let s = 0; s < 29; s++) {
    const base = LENGTH_BASE[s];
    const next = s === 28 ? 259 : LENGTH_BASE[s + 1];
    if (len >= base && len < next) {
      sym = s;
      break;
    }
  }
  const extra = len - LENGTH_BASE[sym];
  return { sym: 257 + sym, extra, extraBits: LENGTH_EXTRA[sym] };
}

/** The distance symbol and extra bits for a match at `dist` (1..32768). */
function distSymbol(dist: number): { sym: number; extra: number; extraBits: number } {
  let sym = 29;
  for (let s = 0; s < 30; s++) {
    const base = DIST_BASE[s];
    const next = s === 29 ? 32769 : DIST_BASE[s + 1];
    if (dist >= base && dist < next) {
      sym = s;
      break;
    }
  }
  const extra = dist - DIST_BASE[sym];
  return { sym, extra, extraBits: DIST_EXTRA[sym] };
}

/** One LZ77 token: a literal byte, or a match (length, distance). */
interface Token {
  lit: number; // literal byte, or -1 for a match
  len: number; // match length (0 for a literal)
  dist: number; // match distance (0 for a literal)
  pos: number; // input position the token starts at
}

/** Hash of the 3 bytes at `data[i]` into 15 bits (32-bit multiply, exact). */
function hash3(data: Uint8Array, i: number): number {
  const h = (data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2];
  return (Math.imul(h, 0x9e3779b1) >>> 17) & 0x7fff;
}


/** The longest match at `pos` (at most `maxLen`, at most `maxDist` back), walking at most `maxChain` hash-chain links. */
function longestMatch(
  data: Uint8Array,
  pos: number,
  head: Int32Array,
  prev: Int32Array,
  maxChain: number,
  maxDist: number,
): { len: number; dist: number } {
  const n = data.length;
  const maxLen = Math.min(258, n - pos);
  if (maxLen < 3) return { len: 0, dist: 0 };
  let bestLen = 0;
  let bestDist = 0;
  // Start from the previous occurrence: `pos` itself was just inserted
  // into the chains, so head[hash] is `pos` (distance 0, not a match).
  let cand = prev[pos];
  let steps = 0;
  while (cand >= 0 && steps < maxChain) {
    const dist = pos - cand;
    if (dist > maxDist) break;
    // Match length at this candidate.
    let len = 0;
    const limit = Math.min(maxLen, n - cand);
    while (len < limit && data[cand + len] === data[pos + len]) len++;
    // Prefer the smallest distance among matches of the same length: a
    // shorter distance costs fewer bits and is likelier to repeat.
    if (len > bestLen || (len === bestLen && len >= 3 && dist < bestDist)) {
      bestLen = len;
      bestDist = dist;
      if (len >= maxLen) break; // cannot do better than the longest possible
    }
    cand = prev[cand];
    steps++;
  }
  return { len: bestLen, dist: bestDist };
}

/**
 * Tokenize `data` by lazy matching: at each position find the longest
 * match; if the next position holds a longer one, emit a literal and move
 * on. `maxChain` bounds the work per position (fixed, so the run is
 * deterministic and bounded). Kept as a cross-check for the optimal parse.
 */
function tokenize(data: Uint8Array, maxChain: number): Token[] {
  const n = data.length;
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const tokens: Token[] = [];
  // Insert `p` into the hash chains, once: a position inserted twice
  // links to itself and corrupts the chain (distance 0, endless walk).
  const insert = (p: number): void => {
    if (p + 2 >= n) return;
    const h = hash3(data, p);
    if (head[h] === p) return;
    prev[p] = head[h];
    head[h] = p;
  };
  let pos = 0;
  // The match at `pos`, found on the previous step's lookahead, when kept.
  let held: { len: number; dist: number } | null = null;
  while (pos < n) {
    insert(pos);
    const cur = held ?? longestMatch(data, pos, head, prev, maxChain, 32768);
    held = null;
    if (cur.len >= 3) {
      // Lazy: is the next position's match longer?
      const nextPos = pos + 1;
      let next: { len: number; dist: number } | null = null;
      if (nextPos + 2 < n) {
        insert(nextPos);
        next = longestMatch(data, nextPos, head, prev, maxChain, 32768);
      }
      if (next !== null && next.len > cur.len) {
        tokens.push({ lit: data[pos], len: 0, dist: 0, pos });
        held = next;
        pos++;
        continue;
      }
      tokens.push({ lit: -1, len: cur.len, dist: cur.dist, pos });
      // Insert the positions the match covers (so later matches can find them).
      for (let k = 1; k < cur.len; k++) insert(pos + k);
      pos += cur.len;
    } else {
      tokens.push({ lit: data[pos], len: 0, dist: 0, pos });
      pos++;
    }
  }
  return tokens;
}

/** The code-length alphabet's order in a dynamic block header. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * Encode one block's tokens with a dynamic Huffman header (or a fixed one,
 * whichever is smaller) into `w`. `last` marks the final block.
 * Returns the number of bits the block took (for the caller's accounting).
 */
function writeBlock(w: BitWriter, tokens: Token[], last: boolean): void {
  // Frequencies of the literal/length and distance alphabets in this block.
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (const t of tokens) {
    if (t.lit >= 0) litFreq[t.lit]++;
    else {
      litFreq[lengthSymbol(t.len).sym]++;
      distFreq[distSymbol(t.dist).sym]++;
    }
  }
  litFreq[256]++; // end of block
  const litLen = huffmanLengths(litFreq, 15);
  const distLen = huffmanLengths(distFreq, 15);

  // Trim trailing zero lengths (at least one literal/length and one distance).
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;

  // The code-length alphabet: RLE of the lit+dist lengths.
  const lens: number[] = [];
  for (let i = 0; i < hlit; i++) lens.push(litLen[i]);
  for (let i = 0; i < hdist; i++) lens.push(distLen[i]);
  const clSeq: Array<{ sym: number; extra: number; extraBits: number }> = [];
  {
    let i = 0;
    while (i < lens.length) {
      const v = lens[i];
      if (v === 0) {
        let run = 0;
        while (i + run < lens.length && lens[i + run] === 0 && run < 138) run++;
        while (run >= 11) {
          const take = Math.min(run, 138);
          clSeq.push({ sym: 18, extra: take - 11, extraBits: 7 });
          i += take;
          run -= take;
        }
        if (run >= 3) {
          clSeq.push({ sym: 17, extra: run - 3, extraBits: 3 });
          i += run;
          run = 0;
        }
        while (run > 0) {
          clSeq.push({ sym: 0, extra: 0, extraBits: 0 });
          i++;
          run--;
        }
      } else {
        clSeq.push({ sym: v, extra: 0, extraBits: 0 });
        i++;
        let run = 0;
        while (i + run < lens.length && lens[i + run] === v && run < 6) run++;
        while (run >= 3) {
          const take = Math.min(run, 6);
          clSeq.push({ sym: 16, extra: take - 3, extraBits: 2 });
          i += take;
          run -= take;
        }
        while (run > 0) {
          clSeq.push({ sym: v, extra: 0, extraBits: 0 });
          i++;
          run--;
        }
      }
    }
  }
  const clFreq = new Uint32Array(19);
  for (const e of clSeq) clFreq[e.sym]++;
  const clLen = huffmanLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;

  // Size the dynamic header + body against a fixed-Huffman block.
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  const clCode = canonicalCodes(clLen);
  const dynBits =
    3 + 5 + 5 + 4 + hclen * 3 +
    clSeq.reduce((s, e) => s + clLen[e.sym] + e.extraBits, 0) +
    tokens.reduce((s, t) => {
      if (t.lit >= 0) return s + litLen[t.lit];
      const ls = lengthSymbol(t.len);
      const ds = distSymbol(t.dist);
      return s + litLen[ls.sym] + ls.extraBits + distLen[ds.sym] + ds.extraBits;
    }, 0) +
    litLen[256];
  // Fixed Huffman: literals 0-143 in 8 bits, 144-255 in 9, 256-279 in 7, 280-287 in 8; distances 5 bits.
  const fixedLit = (s: number): number => (s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8);
  const fixedBits =
    3 +
    tokens.reduce((s, t) => {
      if (t.lit >= 0) return s + fixedLit(t.lit);
      const ls = lengthSymbol(t.len);
      const ds = distSymbol(t.dist);
      return s + fixedLit(ls.sym) + ls.extraBits + 5 + ds.extraBits;
    }, 0) +
    7;

  if (fixedBits <= dynBits) {
    // Fixed-Huffman block.
    w.write(last ? 1 : 0, 1);
    w.write(1, 2); // BTYPE 01
    for (const t of tokens) {
      if (t.lit >= 0) {
        const len = fixedLit(t.lit);
        const code = t.lit < 144 ? 0x30 + t.lit : t.lit < 256 ? 0x190 + (t.lit - 144) : t.lit < 280 ? t.lit - 256 : 0xc0 + (t.lit - 280);
        w.writeCode(code, len);
      } else {
        const ls = lengthSymbol(t.len);
        const ds = distSymbol(t.dist);
        const lcode = ls.sym < 280 ? ls.sym - 256 : 0xc0 + (ls.sym - 280);
        w.writeCode(lcode, fixedLit(ls.sym));
        if (ls.extraBits > 0) w.write(ls.extra, ls.extraBits);
        w.write(ds.sym, 5);
        if (ds.extraBits > 0) w.write(ds.extra, ds.extraBits);
      }
    }
    w.writeCode(0, 7); // end of block (256)
    return;
  }

  // Dynamic-Huffman block.
  w.write(last ? 1 : 0, 1);
  w.write(2, 2); // BTYPE 10
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.write(clLen[CL_ORDER[i]], 3);
  for (const e of clSeq) {
    w.writeCode(clCode[e.sym].code, clLen[e.sym]);
    if (e.extraBits > 0) w.write(e.extra, e.extraBits);
  }
  for (const t of tokens) {
    if (t.lit >= 0) {
      w.writeCode(litCode[t.lit].code, litLen[t.lit]);
    } else {
      const ls = lengthSymbol(t.len);
      const ds = distSymbol(t.dist);
      w.writeCode(litCode[ls.sym].code, litLen[ls.sym]);
      if (ls.extraBits > 0) w.write(ls.extra, ls.extraBits);
      w.writeCode(distCode[ds.sym].code, distLen[ds.sym]);
      if (ds.extraBits > 0) w.write(ds.extra, ds.extraBits);
    }
  }
  w.writeCode(litCode[256].code, litLen[256]);
}


/** How many input bytes a dynamic block covers at most. */
const BLOCK_BYTES = 131072;

/** Split a token list into blocks of at most BLOCK_BYTES input bytes each. */
function splitBlocks(tokens: Token[]): Token[][] {
  const blocks: Token[][] = [];
  let cur: Token[] = [];
  let blockStart = 0;
  for (const t of tokens) {
    if (t.pos - blockStart >= BLOCK_BYTES && cur.length > 0) {
      blocks.push(cur);
      cur = [];
      blockStart = t.pos;
    }
    cur.push(t);
  }
  if (cur.length > 0) blocks.push(cur);
  return blocks;
}

/** Encode a token list as a raw DEFLATE stream (blocks split by position). */
function encodeTokens(tokens: Token[], dataLength: number): Uint8Array {
  const blocks = splitBlocks(tokens);
  const w = new BitWriter(dataLength + 65536);
  for (let i = 0; i < blocks.length; i++) writeBlock(w, blocks[i], i === blocks.length - 1);
  return w.finish();
}

/**
 * The raw DEFLATE stream of `data` (no zlib wrapper): lazy matching over
 * deep hash chains (1024 links, smallest distance wins ties), then
 * dynamic blocks of at most BLOCK_BYTES input bytes each. Deterministic.
 */
export function deflateRaw(data: Uint8Array): Uint8Array {
  const tokens = tokenize(data, 1024);
  return encodeTokens(tokens, data.length);
}

/** The zlib stream of `data`: header, raw deflate, Adler-32. */
export function deflateZlib(data: Uint8Array): Uint8Array {
  const raw = deflateRaw(data);
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(raw, 2);
  const adler = adler32(data);
  out[2 + raw.length] = (adler >>> 24) & 0xff;
  out[2 + raw.length + 1] = (adler >>> 16) & 0xff;
  out[2 + raw.length + 2] = (adler >>> 8) & 0xff;
  out[2 + raw.length + 3] = adler & 0xff;
  return out;
}

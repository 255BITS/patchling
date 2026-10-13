/**
 * Exhaustive check of the truncated-UTF-8 tail classifier (Ember's review of #5).
 *
 * For every 1-, 2- and 3-byte tail after "a" (lead 0x80-0xFF; following bytes
 * over every continuation byte 0x80-0xBF plus non-continuation probes), the
 * bytes must be text exactly when some valid completion exists. The reference
 * is a fatal streaming TextDecoder: with `stream: true` it throws only once
 * the bytes so far can no longer start valid UTF-8, i.e. when no completion
 * exists. The reference itself is cross-checked by brute force on 1- and
 * 2-byte tails. src/filter.js and landing/lib/filter.js must agree everywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as srcFilter from '../src/filter.js';
import * as landingFilter from '../landing/lib/filter.js';

const A = 0x61;
const LEADS = Array.from({ length: 128 }, (_, i) => 0x80 + i);
const CONTINUATIONS = Array.from({ length: 64 }, (_, i) => 0x80 + i);
/** Range edges for every second-byte rule (E0/ED/F0/F4) and plain 80-BF. */
const EDGE_CONTINUATIONS = [0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf];
const FOLLOW = [...CONTINUATIONS, 0x41, 0x7f, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff];

function hasValidCompletion(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function decodesFully(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Brute force: try appending 0-3 continuation bytes (range edges suffice). */
function bruteHasCompletion(bytes) {
  if (decodesFully(bytes)) return true;
  let frontier = [bytes];
  for (let k = 0; k < 3; k++) {
    const next = [];
    for (const prefix of frontier) {
      for (const c of EDGE_CONTINUATIONS) {
        const buf = new Uint8Array(prefix.length + 1);
        buf.set(prefix);
        buf[prefix.length] = c;
        if (decodesFully(buf)) return true;
        next.push(buf);
      }
    }
    frontier = next;
    if (k === 1) break; // 3 appended bytes are only needed after a lone 4-byte lead; covered below
  }
  // A lone 4-byte lead needs 3 continuations; check it directly.
  if (bytes.length >= 1) {
    const lead = bytes[bytes.length - 1];
    if (lead >= 0xf0 && lead <= 0xf4) {
      for (const b of [0x80, 0x8f, 0x90, 0xbf]) {
        const buf = new Uint8Array([...bytes, b, 0x80, 0x80]);
        if (decodesFully(buf)) return true;
      }
    }
  }
  return false;
}

function* tails() {
  for (const l of LEADS) {
    yield [l];
    for (const b of FOLLOW) {
      yield [l, b];
      for (const c of FOLLOW) yield [l, b, c];
    }
  }
}

test('streaming reference agrees with brute-force completion on 1- and 2-byte tails', () => {
  let checked = 0;
  for (const l of LEADS) {
    for (const tail of [[l], ...FOLLOW.map((b) => [l, b])]) {
      const bytes = new Uint8Array([A, ...tail]);
      assert.equal(hasValidCompletion(bytes), bruteHasCompletion(bytes), `tail ${hex(tail)}`);
      checked += 1;
    }
  }
  assert.ok(checked > 9000);
});

function hex(tail) {
  return tail.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

test('every tail after "a": text iff a valid completion exists, in src and landing', () => {
  let checked = 0;
  const mismatches = [];
  for (const tail of tails()) {
    const bytes = new Uint8Array([A, ...tail]);
    const expectedBinary = !hasValidCompletion(bytes);
    const src = srcFilter.isBinaryContent(bytes);
    const landing = landingFilter.isBinaryContent(bytes);
    if (src !== expectedBinary || landing !== src) {
      mismatches.push(`${hex(tail)}: expected binary=${expectedBinary} src=${src} landing=${landing}`);
      if (mismatches.length > 20) break;
    }
    checked += 1;
  }
  assert.deepEqual(mismatches, []);
  assert.equal(checked, 128 * (1 + FOLLOW.length + FOLLOW.length ** 2));
});

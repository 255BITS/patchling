/**
 * Shared parity fixtures vendored byte-for-byte from 255BITS/patchling-py
 * (tests/fixtures/parity/, commit 533749a). The Python suite runs the same
 * cases in tests/test_relevance.py. Each file's sha256 is pinned so a drift
 * on either side shows up as a failure here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isBinaryContent, parseRelevanceAnswer } from '../src/index.js';
import { truncateUtf8 } from '../src/filter.js';

const FIXTURE_SHA256 = {
  'binary.json': 'babcc94fe1dd990f0a69c41819ed9f76a185756ff28fa2d0e14651a190314934',
  'parser.json': '809a3522c79781da2aa2f10168bafd770aa781dc29c215b1dd885689047d3c7b',
  'truncation.json': 'c1d9db9b70687c24068f13a0b2a0edcf84ca3c5830e166336ff4da3c35b5c0df',
};

function loadFixture(name) {
  const bytes = readFileSync(new URL(`./fixtures/parity/${name}`, import.meta.url));
  return { bytes, data: JSON.parse(bytes.toString('utf8')) };
}

const fixtures = Object.fromEntries(
  Object.keys(FIXTURE_SHA256).map((name) => [name, loadFixture(name)]),
);

for (const [name, sha256] of Object.entries(FIXTURE_SHA256)) {
  test(`${name} bytes match the recorded sha256`, () => {
    assert.equal(createHash('sha256').update(fixtures[name].bytes).digest('hex'), sha256);
  });
}

function binaryCaseBytes(c) {
  if (c.hex !== undefined) return new Uint8Array(Buffer.from(c.hex, 'hex'));
  const pad = Buffer.alloc(c.length, c.fill, 'utf8');
  return new Uint8Array(Buffer.concat([pad, Buffer.from(c.tail_hex, 'hex')]));
}

test('binary.json: every case matches isBinaryContent', () => {
  const { cases } = fixtures['binary.json'].data;
  assert.ok(cases.length > 0);
  for (const c of cases) {
    assert.equal(isBinaryContent(binaryCaseBytes(c)), c.expect_binary, c.id);
  }
});

test('parser.json: every case matches parseRelevanceAnswer', () => {
  const { cases } = fixtures['parser.json'].data;
  assert.ok(cases.length > 0);
  for (const c of cases) {
    assert.equal(parseRelevanceAnswer(c.raw).decision, c.decision, c.id);
  }
});

test('truncation.json: every case matches truncateUtf8 and never emits U+FFFD', () => {
  const { cases } = fixtures['truncation.json'].data;
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const out = truncateUtf8(c.text, c.max_bytes);
    assert.equal(out, c.expected, c.id);
    assert.ok(!out.includes('\uFFFD'), c.id);
    assert.ok(Buffer.byteLength(out, 'utf8') <= Math.max(c.max_bytes, 0), c.id);
  }
});

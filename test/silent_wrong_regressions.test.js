import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatchToFile } from '../src/index.js';

// Regression tests for the benchmark's former "clean-WRONG" (silent
// corruption) cases: applyPatchToFile must apply correctly or return null,
// never apply cleanly with wrong output.

// --- malformed `++` body markers -------------------------------------------
// A `++foo` hunk-body line is ambiguous: malformed double-plus add of `foo`,
// or a legitimate add of `+foo`. Either literal reading silently corrupts the
// file under the other, so the applier must return null (LLM fallback).

test('double-plus body add returns null instead of injecting a literal "+"', () => {
  // Distilled from malformed-markers-double-plus-body-add.
  const original = 'function log(msg) {\n  console.log(msg);\n}\n';
  const patch =
    '--- a/src/logger.js\n' +
    '+++ b/src/logger.js\n' +
    '@@ -1,3 +1,4 @@\n' +
    ' function log(msg) {\n' +
    '   console.log(msg);\n' +
    '++  console.error(msg);\n' +
    ' }\n';
  assert.equal(applyPatchToFile(original, patch), null);
});

test('double-plus adds paired with a real deletion also return null', () => {
  // Distilled from malformed-markers-double-plus-prefix-multiple.
  const original = 'async function f(url) {\n  const res = await fetch(url);\n  return res.json();\n}\n';
  const patch =
    '@@ -1,4 +1,6 @@\n' +
    ' async function f(url) {\n' +
    '   const res = await fetch(url);\n' +
    "++  if (!res.ok) throw new Error('request failed');\n" +
    '++  return res.json();\n' +
    '-  return res.json();\n' +
    ' }\n';
  assert.equal(applyPatchToFile(original, patch), null);
});

test('a "+++" body line is not treated as a malformed double-plus add', () => {
  // `+++ b/...` file headers pass through the hunk scanner only before `@@`;
  // this checks the `++` guard does not misfire on ordinary single-plus adds.
  const original = 'a\nb\n';
  const patch = '@@ -1,2 +1,3 @@\n a\n+between\n b\n';
  assert.equal(applyPatchToFile(original, patch), 'a\nbetween\nb\n');
});

// --- git end-of-file no-newline restatement ---------------------------------
// Deleting the last line of a newline-less file makes the previous line the
// new EOF line, which git canonically emits as a -/+ pair with `\ No newline`
// markers. Sloppy diffs keep the old copy as *context*, leaving a trailing
// `+<line>` that duplicates the kept line. When the @@ header's new-line
// count confirms the collapsed reading, the redundant add must be dropped.

test('no-newline EOF restatement add is collapsed, not duplicated', () => {
  // Distilled from no-trailing-newline-delete-trailing-line.
  const original = 'package cfg\n\nconst Timeout = 30\nconst Retries = 3\nconst Debug = true';
  const patch =
    '--- a/const.go\n' +
    '+++ b/const.go\n' +
    '@@ -2,4 +2,3 @@\n' +
    ' \n' +
    ' const Timeout = 30\n' +
    ' const Retries = 3\n' +
    '-const Debug = true\n' +
    '\\ No newline at end of file\n' +
    '+const Retries = 3\n' +
    '\\ No newline at end of file';
  assert.equal(applyPatchToFile(original, patch), 'package cfg\n\nconst Timeout = 30\nconst Retries = 3\n');
});

test('a genuine duplicate add at EOF is kept when the header count says so', () => {
  // Same shape, but the @@ header's new count (4) matches the literal reading,
  // so the trailing add really does append a duplicate line — and its
  // `\ No newline` marker means the result ends without a trailing newline.
  const original = 'package cfg\n\nconst Timeout = 30\nconst Retries = 3\nconst Debug = true';
  const patch =
    '@@ -2,4 +2,4 @@\n' +
    ' \n' +
    ' const Timeout = 30\n' +
    ' const Retries = 3\n' +
    '-const Debug = true\n' +
    '\\ No newline at end of file\n' +
    '+const Retries = 3\n' +
    '\\ No newline at end of file';
  assert.equal(
    applyPatchToFile(original, patch),
    'package cfg\n\nconst Timeout = 30\nconst Retries = 3\nconst Retries = 3',
  );
});

test('an add without the no-newline marker is never collapsed', () => {
  // No `\ No newline` marker on the add: the duplicate is intentional even
  // though the header undercounts (LLM headers are unreliable).
  const original = 'a\nb\nc\n';
  const patch = '@@ -1,3 +1,3 @@\n a\n b\n-c\n+b\n';
  assert.equal(applyPatchToFile(original, patch), 'a\nb\nb\n');
});

// --- partial-file hunks keep trailing content --------------------------------
// Distilled from multi-file-ts-context-mismatch-fallback (whose corpus
// `expected` was a generator error): a valid hunk covering only the top of a
// file must keep everything after it — no patch semantics may drop unrelated
// trailing lines.

test('a hunk covering the top of a file preserves the untouched tail', () => {
  const original =
    'let current = null;\n\nexport function setSession(user) {\n  current = user;\n}\n\n' +
    'export function getSession() {\n  return current;\n}\n';
  const patch =
    '@@ -1,4 +1,5 @@\n' +
    ' let current = null;\n' +
    ' \n' +
    ' export function setSession(user) {\n' +
    "+  console.log('session set', user);\n" +
    '   current = user;\n' +
    ' }\n';
  const got = applyPatchToFile(original, patch);
  assert.ok(got.includes("console.log('session set', user);"));
  assert.ok(got.includes('export function getSession()'), 'untouched tail must be preserved');
});

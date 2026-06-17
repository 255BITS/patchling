/**
 * Regression tests for behavioral fixes found during the Python-vs-JS parity
 * review (edge cases not covered by the ported Python suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiff, extractDiffBlocks, stripThinkTags, smartapply } from '../src/index.js';

test('applyDiff does not throw on a malformed -0,0 hunk against a non-empty file', () => {
  const files = { 'f.txt': 'a\nb\nc\n' };
  const diff = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n c\n+x\n';
  // The -0,0 line numbers are bogus, but the context line "c" is found, so the
  // addition applies after it (by content match) rather than crashing.
  const result = applyDiff(files, diff);
  assert.equal(result.changed, true);
  assert.equal(result.files['f.txt'], 'a\nb\nc\nx\n');
});

test('applyDiff fails gracefully when a malformed hunk context is not found', () => {
  const files = { 'f.txt': 'a\nb\nc\n' };
  const diff = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n zzz\n+x\n';
  const result = applyDiff(files, diff);
  assert.equal(result.changed, false);
  assert.deepEqual(result.files, files);
});

test('extractDiffBlocks only collects fences whose language is exactly "diff"', () => {
  assert.deepEqual(extractDiffBlocks('```diffx\nhello\n```'), []);
  assert.deepEqual(extractDiffBlocks('```python\nhello\n```'), []);
  assert.deepEqual(extractDiffBlocks('```diff\nhello\n```'), ['hello\n']);
});

test('extractDiffBlocks force-closes an unterminated block', () => {
  assert.deepEqual(extractDiffBlocks('```diff\nhello\nworld'), ['hello\nworld\n']);
});

test('stripThinkTags removes an unterminated <think> tag', () => {
  assert.equal(stripThinkTags('before<think>never closed'), 'before');
  assert.equal(stripThinkTags('<think>a</think>\nkept'), 'kept');
});

test('smartapply does not leak an unclosed think block into a file', async () => {
  const diff = 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-old\n+new\n';
  const mock = async () => 'def x():\n    pass\n<think>leaking reasoning with no close';
  // forceLlm: this exercises the LLM think-stripping path, not the fast path.
  const updated = await smartapply(diff, { 'x.py': 'old\n' }, { callLlmForApply: mock, forceLlm: true });
  assert.equal(updated['x.py'], 'def x():\n    pass');
});

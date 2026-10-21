/**
 * Live integration tests against NanoGPT.
 *
 * These are SKIPPED unless both of these are set:
 *   GPTDIFF_LIVE=1
 *   GPTDIFF_LLM_API_KEY=<your NanoGPT key>   (e.g. sk-nano-... from OAuth sign-in)
 *
 * Model defaults to deepseek/deepseek-v4.1-flash-1017 (override with GPTDIFF_MODEL).
 * Base URL defaults to https://nano-gpt.com/api/v1/ (override GPTDIFF_LLM_BASE_URL).
 *
 * Run with:  npm run test:live
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDiff, smartapply, applyDiff, buildEnvironment } from '../src/index.js';
import { DEFAULT_MODEL } from '../src/env.js';

const LIVE = process.env.GPTDIFF_LIVE === '1' && !!process.env.GPTDIFF_LLM_API_KEY;
const MODEL = process.env.GPTDIFF_MODEL || DEFAULT_MODEL;

test(
  'live: generateDiff produces an applicable diff for a one-line change',
  { skip: LIVE ? false : 'set GPTDIFF_LIVE=1 and GPTDIFF_LLM_API_KEY to run' },
  async () => {
    const files = { 'greet.py': 'def greet():\n    print("hello")\n' };
    const environment = buildEnvironment(files);
    const diff = await generateDiff(
      environment,
      'Change the greeting from "hello" to "goodbye".',
      { model: MODEL, temperature: 0 },
    );
    assert.ok(diff.trim().length > 0, 'expected a non-empty diff');
    assert.ok(diff.includes('goodbye'), `expected diff to mention goodbye, got:\n${diff}`);
  },
);

test(
  'live: smartapply applies an LLM-resolved diff',
  { skip: LIVE ? false : 'set GPTDIFF_LIVE=1 and GPTDIFF_LLM_API_KEY to run' },
  async () => {
    const files = { 'greet.py': 'def greet():\n    print("hello")\n' };
    const diff = `diff --git a/greet.py b/greet.py
--- a/greet.py
+++ b/greet.py
@@ -1,2 +1,2 @@
 def greet():
-    print("hello")
+    print("goodbye")`;
    const updated = await smartapply(diff, files, { model: MODEL });
    assert.ok(Object.hasOwn(updated, 'greet.py'));
    assert.ok(updated['greet.py'].includes('goodbye'), `got:\n${updated['greet.py']}`);
    // applyDiff (no LLM) should reach the same destination for this clean diff.
    const local = applyDiff(files, diff);
    assert.equal(local.changed, true);
    assert.ok(local.files['greet.py'].includes('goodbye'));
  },
);

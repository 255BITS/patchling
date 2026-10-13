import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as src from '../src/filter.js';
import * as landing from '../landing/lib/filter.js';

const yes = async () => ({ choices: [{ message: { content: 'yes' } }], usage: {} });

/** Every keyword of patchling-py filter_relevant() (patchling/relevance.py @ bf9c8f0). */
const PY_KEYWORDS = [
  'files', 'task', 'model', 'concurrency', 'cache',
  'api_key', 'base_url', 'max_bytes', 'max_tokens', 'on_oversize', 'on_binary',
  'max_output_tokens', 'skip_patterns', 'max_attempts', 'retry_backoff', 'sleep', 'call_llm',
];
const SHARED_NAMES = new Set(['files', 'task', 'model', 'concurrency', 'cache']);

function counting() {
  const state = { calls: 0 };
  state.callLlm = async () => { state.calls += 1; throw Object.assign(new Error('HTTP 503'), { status: 503 }); };
  return state;
}

for (const [label, mod] of [['src', src], ['landing', landing]]) {
  test(`${label}: skip_patterns: [] throws instead of still excluding a generated file`, async () => {
    const llm = counting();
    await assert.rejects(
      mod.filterRelevant({ 'dist/app.js': 'x' }, 'task', { callLlm: llm.callLlm, apiKey: 'k', cache: false, skip_patterns: [] }),
      (err) => err instanceof TypeError && /skip_patterns: use ignore/.test(err.message),
    );
    assert.equal(llm.calls, 0);
  });

  test(`${label}: max_attempts: 1 throws before any attempt`, async () => {
    const llm = counting();
    await assert.rejects(
      mod.filterRelevant({ 'a.js': 'x' }, 'task', { callLlm: llm.callLlm, apiKey: 'k', cache: false, retryBaseMs: 0, max_attempts: 1 }),
      /max_attempts: use retries, which counts extra attempts: retries = max_attempts - 1/,
    );
    assert.equal(llm.calls, 0, 'no mocked attempt is made');
  });

  test(`${label}: retry_backoff: 0 throws with the retryBaseMs conversion`, async () => {
    const llm = counting();
    await assert.rejects(
      mod.filterRelevant({ 'a.js': 'x' }, 'task', { callLlm: llm.callLlm, apiKey: 'k', retry_backoff: 0 }),
      /retry_backoff: use retryBaseMs, in milliseconds: retryBaseMs = retry_backoff \* 1000/,
    );
    assert.equal(llm.calls, 0);
  });

  test(`${label}: every snake_case patchling-py keyword is rejected`, async () => {
    for (const key of PY_KEYWORDS.filter((k) => !SHARED_NAMES.has(k))) {
      assert.ok(Object.hasOwn(mod.SNAKE_CASE_OPTIONS, key), `${key} is mapped`);
      const llm = counting();
      await assert.rejects(
        mod.filterRelevant({ 'a.js': 'x' }, 'task', { callLlm: llm.callLlm, apiKey: 'k', cache: false, [key]: undefined }),
        (err) => err instanceof TypeError && err.message.includes(`${key}: `),
        key,
      );
      assert.equal(llm.calls, 0, key);
    }
  });
}

test('sleep is reported as not supported in JS', async () => {
  await assert.rejects(
    src.filterRelevant({ 'a.js': 'x' }, 'task', { callLlm: yes, apiKey: 'k', sleep: () => {} }),
    /sleep: not supported in JS/,
  );
});

test('several snake_case options are all named in one error', async () => {
  await assert.rejects(
    src.filterRelevant({ 'a.js': 'x' }, 'task', { callLlm: yes, apiKey: 'k', on_binary: 'include', max_bytes: 10 }),
    /on_binary: use onBinary; max_bytes: use maxBytes/,
  );
});

test('camelCase options and unrelated extra keys still work', async () => {
  const result = await src.filterRelevant(
    { 'a.bin': new Uint8Array([0, 1]), 'a.js': 'x' },
    'task',
    { callLlm: yes, apiKey: 'k', onBinary: 'include', cache: false, label: 'mine' },
  );
  assert.deepEqual(result.decisions.map((d) => d.decision).sort(), ['yes', 'yes']);
});

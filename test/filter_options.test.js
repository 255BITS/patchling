import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRelevant } from '../src/filter.js';

const yes = async () => ({ choices: [{ message: { content: 'yes' } }], usage: {} });

test('snake_case options from patchling-py throw with the camelCase name', async () => {
  let calls = 0;
  const callLlm = async () => { calls += 1; return yes(); };
  await assert.rejects(
    filterRelevant({ 'a.bin': new Uint8Array([0, 1]) }, 'task', { callLlm, apiKey: 'k', on_binary: 'include' }),
    (err) => err instanceof TypeError && /on_binary -> onBinary/.test(err.message),
  );
  await assert.rejects(
    filterRelevant({ 'a.js': 'x' }, 'task', { callLlm, apiKey: 'k', max_bytes: 10, reasoning_effort: null }),
    /max_bytes -> maxBytes, reasoning_effort -> reasoningEffort/,
  );
  assert.equal(calls, 0, 'no model call is made before the options are rejected');
});

test('camelCase options and unrelated extra keys still work', async () => {
  const result = await filterRelevant(
    { 'a.bin': new Uint8Array([0, 1]), 'a.js': 'x' },
    'task',
    { callLlm: yes, apiKey: 'k', onBinary: 'include', cache: false, label: 'mine' },
  );
  assert.deepEqual(result.decisions.map((d) => d.decision).sort(), ['yes', 'yes']);
});

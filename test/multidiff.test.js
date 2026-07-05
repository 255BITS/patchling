import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDiff } from '../src/index.js';

test('test_fail_diff_through_call_llm', async () => {
  const diffStr = `\`\`\`diff
DIFF 1
\`\`\`

Some text here
\`\`\`diff
DIFF 2
\`\`\``;

  const expected = `
DIFF 1

DIFF 2`;

  const dummyCallLlm = async () => ({
    choices: [{ message: { content: diffStr } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });

  const result = await generateDiff('dummy environment', 'dummy goal', {
    model: 'test-model',
    callLlm: dummyCallLlm,
  });

  assert.equal(result.trim(), expected.trim());
});

test('generateDiff reports token usage via opts.onUsage without changing its return type', async () => {
  const dummyCallLlm = async () => ({
    choices: [{ message: { content: '```diff\nDIFF\n```' } }],
    usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
  });

  let usage = null;
  const result = await generateDiff('dummy environment', 'dummy goal', {
    model: 'test-model',
    callLlm: dummyCallLlm,
    onUsage: (u) => { usage = u; },
  });

  assert.equal(typeof result, 'string');
  assert.equal(result.trim(), 'DIFF');
  assert.deepEqual(usage, { promptTokens: 42, completionTokens: 7, totalTokens: 49 });
});

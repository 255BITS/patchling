import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLlm, generateDiff } from '../src/index.js';

const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
function response(chunks, failure, cancel) {
  let index = 0;
  const state = { cancelled: 0, released: 0 };
  const reader = {
    async read() {
      if (index < chunks.length) return { value: new TextEncoder().encode(chunks[index++]), done: false };
      if (failure) throw failure;
      return { done: true };
    },
    async cancel() { state.cancelled += 1; return cancel?.(); },
    releaseLock() { state.released += 1; },
  };
  return { state, value: { ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader } } };
}
const options = { apiKey: 'test-key', model: 'test-model', messages: [{ role: 'user', content: 'edit' }] };

test('EOF before a terminal event rejects a usable diff prefix without replaying the request', async () => {
  const partial = '```diff\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n```';
  const stream = response([frame({ choices: [{ delta: { content: partial } }] })]);
  let requests = 0;
  await assert.rejects(generateDiff('two files', 'change both files', {
    ...options, onToken() {},
    callLlm: (req) => callLlm({ ...req, fetchImpl: async () => { requests += 1; return stream.value; } }),
  }), { name: 'IncompleteCompletionError' });
  assert.equal(requests, 1);
  assert.deepEqual(stream.state, { cancelled: 1, released: 1 });
});

test('a terminal stop reason permits EOF-only providers and keeps the final usage', async () => {
  const stream = response([
    frame({ choices: [{ delta: { content: 'complete' } }] }),
    // Deliberately no final blank line or [DONE].
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 7 } }),
  ]);
  const result = await callLlm({ ...options, onToken() {}, fetchImpl: async () => stream.value });
  assert.equal(result.choices[0].message.content, 'complete');
  assert.equal(result.usage.total_tokens, 7);
  assert.deepEqual(stream.state, { cancelled: 1, released: 1 });
});

test('[DONE] completes legacy compatible streams without reading another chunk', async () => {
  const stream = response([frame({ choices: [{ delta: { content: 'complete' } }] }) + 'data: [DONE]\n\n'], new Error('must not read past DONE'));
  const result = await callLlm({ ...options, onToken() {}, fetchImpl: async () => stream.value });
  assert.equal(result.choices[0].message.content, 'complete');
  assert.deepEqual(stream.state, { cancelled: 1, released: 1 });
});

for (const reason of ['length', 'content_filter']) {
  test(`explicit ${reason} is incomplete even when followed by DONE`, async () => {
    const stream = response([frame({ choices: [{ delta: { content: 'prefix' }, finish_reason: reason }] }) + 'data: [DONE]\n\n']);
    await assert.rejects(callLlm({ ...options, onToken() {}, fetchImpl: async () => stream.value }), { name: 'IncompleteCompletionError' });
    assert.deepEqual(stream.state, { cancelled: 1, released: 1 });
  });
  test(`non-streaming ${reason} is not passed off as a complete answer`, async () => {
    await assert.rejects(callLlm({ ...options, fetchImpl: async () => Response.json({
      choices: [{ message: { content: 'prefix' }, finish_reason: reason }],
    }) }), { name: 'IncompleteCompletionError' });
  });
}

test('reader interruption propagates without retry and releases the response', async () => {
  const aborted = new DOMException('cancelled', 'AbortError');
  const stream = response([frame({ choices: [{ delta: { content: 'prefix' } }] })], aborted);
  let requests = 0;
  await assert.rejects(callLlm({ ...options, onToken() {}, fetchImpl: async () => { requests += 1; return stream.value; } }), (error) => error === aborted);
  assert.equal(requests, 1);
  assert.deepEqual(stream.state, { cancelled: 1, released: 1 });
});

test('a throwing token consumer still cancels and releases the response', async () => {
  const stream = response([frame({ choices: [{ delta: { content: 'prefix' } }] })]);
  await assert.rejects(callLlm({ ...options, onToken() { throw new Error('consumer failed'); }, fetchImpl: async () => stream.value }), /consumer failed/);
  assert.deepEqual(stream.state, { cancelled: 1, released: 1 });
});

for (const complete of [true, false]) {
  test(`stalled transport cancellation does not delay ${complete ? 'completion' : 'incomplete-stream rejection'}`, { timeout: 1000 }, async () => {
    const stream = response([frame({ choices: [{ delta: { content: 'prefix' } }] }) + (complete ? 'data: [DONE]\n\n' : '')], null, () => new Promise(() => {}));
    const pending = callLlm({ ...options, onToken() {}, fetchImpl: async () => stream.value });
    if (complete) assert.equal((await pending).choices[0].message.content, 'prefix');
    else await assert.rejects(pending, { name: 'IncompleteCompletionError' });
    assert.deepEqual(stream.state, { cancelled: 1, released: 1 });
  });
}

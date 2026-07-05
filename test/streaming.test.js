import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLlm } from '../src/llm.js';
import { generateDiff, smartapply } from '../src/index.js';

/**
 * Build a mock fetch Response whose body is a reader-compatible stream that
 * emits the given string chunks (so we can split SSE events across chunk
 * boundaries deliberately).
 */
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) return { value: encoder.encode(chunks[i++]), done: false };
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}

function sseEvent(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

test('callLlm streams SSE deltas via onToken and returns the non-streaming shape', async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const chunks = [
    // First event split across two network chunks, mid-JSON.
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\n\n' + sseEvent({ choices: [{ delta: { content: ' wor' } }] }),
    sseEvent({ choices: [{ delta: { content: 'ld' } }] }),
    // Multi-line data event: SSE joins data lines with "\n" (valid JSON whitespace).
    'data: {"choices":[{"delta":\ndata: {"content":"!"}}]}\n\n',
    // Final usage-only chunk (stream_options.include_usage), then [DONE].
    sseEvent({ choices: [], usage }),
    'data: [DONE]\n\n',
  ];

  let capturedRequest = null;
  const fetchImpl = async (url, init) => {
    capturedRequest = { url, body: JSON.parse(init.body) };
    return sseResponse(chunks);
  };

  const tokens = [];
  const response = await callLlm({
    apiKey: 'k',
    baseUrl: 'https://example.test/api/v1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: (t) => tokens.push(t),
    fetchImpl,
  });

  // The event split across two chunks is buffered and emitted whole ("Hello"),
  // proving chunk boundaries inside an event lose nothing.
  assert.deepEqual(tokens, ['Hello', ' wor', 'ld', '!']);
  assert.equal(response.choices[0].message.content, 'Hello world!');
  assert.deepEqual(response.usage, usage);

  // The request must opt into streaming (and ask for usage in the stream).
  assert.equal(capturedRequest.body.stream, true);
  assert.deepEqual(capturedRequest.body.stream_options, { include_usage: true });
});

test('callLlm without onToken does not request streaming', async () => {
  let body = null;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: 'plain' } }], usage: {} }),
    };
  };
  const response = await callLlm({
    apiKey: 'k',
    baseUrl: 'https://example.test/api/v1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
  });
  assert.equal(response.choices[0].message.content, 'plain');
  assert.equal('stream' in body, false);
  assert.equal('stream_options' in body, false);
});

test('generateDiff threads onToken through to the LLM client', async () => {
  const mockCallLlm = async ({ onToken }) => {
    assert.equal(typeof onToken, 'function');
    onToken('```diff\n');
    onToken('--- a/f\n+++ b/f\n');
    onToken('```');
    return {
      choices: [{ message: { content: '```diff\n--- a/f\n+++ b/f\n```' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  };

  const tokens = [];
  const diff = await generateDiff('File: f\nContent:\nx\n', 'do it', {
    model: 'test-model',
    onToken: (t) => tokens.push(t),
    callLlm: mockCallLlm,
  });
  assert.deepEqual(tokens, ['```diff\n', '--- a/f\n+++ b/f\n', '```']);
  assert.equal(diff, '--- a/f\n+++ b/f\n');
});

test('smartapply passes the file path as the second onToken argument', async () => {
  const diffText = `diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,2 +1,2 @@
 def hello():
-    print('Hola')
+    print('Goodbye')`;

  // Original content does not match the diff's context, so the deterministic
  // fast path fails and the (mock) LLM fallback streams the result.
  const originalFiles = { 'hello.py': "def hello():\n    print('Hello')" };

  const mockApply = async (filePath, originalContent, fileDiff, model, opts) => {
    opts.onToken('def hello():\n');
    opts.onToken("    print('Goodbye')");
    return "def hello():\n    print('Goodbye')";
  };

  const calls = [];
  const updated = await smartapply(diffText, originalFiles, {
    callLlmForApply: mockApply,
    onToken: (text, path) => calls.push([text, path]),
  });

  assert.deepEqual(calls, [
    ['def hello():\n', 'hello.py'],
    ["    print('Goodbye')", 'hello.py'],
  ]);
  assert.equal(updated['hello.py'], "def hello():\n    print('Goodbye')");
});

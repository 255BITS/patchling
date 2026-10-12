import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRelevant,
  createMemoryCache,
  parseRelevanceAnswer,
  buildEnvironment,
  DEFAULT_FILTER_MODEL,
  DEFAULT_FILTER_MAX_BYTES,
} from '../src/index.js';
import { setEnv } from '../src/env.js';

function llm(replies) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (req) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const index = calls.length;
    calls.push(req);
    await new Promise((r) => setTimeout(r, 15));
    inFlight -= 1;
    const next = typeof replies === 'function' ? replies(req, index) : replies[index];
    if (next instanceof Error) throw next;
    const content = typeof next === 'string' || next == null ? (next ?? 'yes') : next.content;
    const tokens = typeof next === 'object' && next && 'tokens' in next ? next.tokens : 11;
    return {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 7, completion_tokens: Math.max(0, tokens - 7), total_tokens: tokens },
    };
  };
  return { fn, calls, stats: () => ({ maxInFlight, count: calls.length }) };
}

function replyByPath(map) {
  return (req) => {
    const path = req.messages[1].content.match(/File: ([^\n]+)/)[1];
    if (!Object.prototype.hasOwnProperty.call(map, path)) throw new Error(`no reply for ${path}`);
    return map[path];
  };
}

const QUESTION = 'is this file relevant to the task? yes/no';

test('parseRelevanceAnswer strips think tags and accepts yes/no with a reason', () => {
  assert.deepEqual(parseRelevanceAnswer('yes'), { decision: 'yes', reason: null, ambiguous: false });
  assert.deepEqual(parseRelevanceAnswer('  YES. '), { decision: 'yes', reason: null, ambiguous: false });
  assert.deepEqual(parseRelevanceAnswer('No'), { decision: 'no', reason: null, ambiguous: false });
  assert.deepEqual(parseRelevanceAnswer('no — arithmetic helpers'), {
    decision: 'no',
    reason: 'arithmetic helpers',
    ambiguous: false,
  });
  assert.deepEqual(parseRelevanceAnswer('<think>the greeting lives here</think>\n\nno'), {
    decision: 'no',
    reason: null,
    ambiguous: false,
  });
  assert.deepEqual(parseRelevanceAnswer('**yes**\ndefines greet'), {
    decision: 'yes',
    reason: 'defines greet',
    ambiguous: false,
  });
  assert.equal(parseRelevanceAnswer('The answer is no.').decision, 'no');
  const both = parseRelevanceAnswer('Yes and no');
  assert.equal(both.decision, 'yes');
  assert.equal(both.ambiguous, true);
  const maybe = parseRelevanceAnswer('maybe later');
  assert.equal(maybe.decision, 'yes');
  assert.equal(maybe.ambiguous, true);
  const empty = parseRelevanceAnswer('<think>only thoughts</think>');
  assert.equal(empty.decision, 'yes');
  assert.equal(empty.ambiguous, true);
});

test('filterRelevant sends full contents and the task, and returns per-file decisions', async () => {
  const mock = llm(replyByPath({
    'greet.py': 'yes — defines the greeting',
    'math_utils.py': 'no',
  }));
  const files = {
    'greet.py': 'def greet():\n    print("hello")\n',
    'math_utils.py': 'def add(a, b):\n    return a + b\n',
  };
  const seen = [];
  const decisions = await filterRelevant(files, 'Say goodbye instead of hello', {
    model: 'cheap-test',
    apiKey: 'sk-test',
    baseUrl: 'https://example.test/v1',
    cache: createMemoryCache(),
    callLlm: mock.fn,
    onDecision: (d) => seen.push(d.path),
  });

  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].path, 'greet.py');
  assert.equal(decisions[0].decision, 'yes');
  assert.equal(decisions[0].reason, 'defines the greeting');
  assert.equal(decisions[0].raw, 'yes — defines the greeting');
  assert.equal(decisions[0].tokens, 11);
  assert.equal(decisions[0].cached, false);
  assert.equal(decisions[0].skippedReason, null);
  assert.equal(decisions[0].error, null);
  assert.equal(decisions[1].decision, 'no');
  assert.deepEqual(seen.sort(), ['greet.py', 'math_utils.py']);

  assert.equal(mock.calls.length, 2);
  for (const [path, content] of Object.entries(files)) {
    const call = mock.calls.find((c) => c.messages[1].content.includes(`File: ${path}\n`));
    assert.ok(call, path);
    assert.equal(call.model, 'cheap-test');
    assert.equal(call.apiKey, 'sk-test');
    assert.equal(call.baseUrl, 'https://example.test/v1');
    assert.equal(call.temperature, 0);
    assert.match(call.messages[1].content, /Task:\nSay goodbye instead of hello/);
    assert.ok(call.messages[1].content.includes(content));
    assert.ok(call.messages[1].content.includes(QUESTION));
  }
});

test('ambiguous answers and thrown errors include the file and surface the error', async () => {
  const mock = llm(replyByPath({
    a: 'maybe',
    b: new Error('connection reset'),
    c: 'no',
  }));
  const decisions = await filterRelevant(
    { a: 'aaa', b: 'bbb', c: 'ccc' },
    'touch a',
    { model: 'cheap-test', cache: null, callLlm: mock.fn },
  );
  assert.equal(decisions[0].decision, 'yes');
  assert.equal(decisions[0].error, 'ambiguous answer');
  assert.equal(decisions[0].raw, 'maybe');
  assert.equal(decisions[1].decision, 'yes');
  assert.equal(decisions[1].error, 'connection reset');
  assert.equal(decisions[1].raw, null);
  assert.equal(decisions[1].tokens, null);
  assert.equal(decisions[2].decision, 'no');
  assert.equal(decisions[2].error, null);
});

test('binary and huge files are skipped and never sent', async () => {
  const mock = llm(['yes']);
  const huge = 'x'.repeat(50);
  const files = {
    'keep.py': 'print(1)\n',
    'logo.bin': 'PNG\0bytes',
    'notes.txt': huge,
    'odd.dat': '\u0001'.repeat(20),
  };
  const decisions = await filterRelevant(files, 'print', {
    model: 'cheap-test',
    cache: null,
    maxBytes: 40,
    callLlm: mock.fn,
  });
  const by = Object.fromEntries(decisions.map((d) => [d.path, d]));
  assert.equal(by['keep.py'].decision, 'yes');
  assert.equal(by['logo.bin'].decision, 'skip');
  assert.equal(by['logo.bin'].skippedReason, 'binary');
  assert.equal(by['logo.bin'].tokens, null);
  assert.equal(by['notes.txt'].decision, 'skip');
  assert.equal(by['notes.txt'].skippedReason, 'too-large');
  assert.equal(by['odd.dat'].skippedReason, 'binary');
  assert.equal(mock.stats().count, 1);
  assert.ok(!mock.calls[0].messages[1].content.includes('PNG'));
});

test('maxBytes counts UTF-8 bytes and can be raised or disabled', async () => {
  const mock = llm(['yes', 'yes', 'no']);
  const accented = 'é'; // 1 UTF-16 unit, 2 UTF-8 bytes
  const files = { a: accented, b: 'b' };
  const skipped = await filterRelevant(files, 't', {
    model: 'cheap-test',
    cache: null,
    maxBytes: 1,
    callLlm: mock.fn,
  });
  assert.equal(skipped[0].skippedReason, 'too-large');
  assert.equal(skipped[1].decision, 'yes');

  const sent = await filterRelevant({ a: accented }, 't', {
    model: 'cheap-test',
    cache: null,
    maxBytes: 2,
    callLlm: mock.fn,
  });
  assert.equal(sent[0].decision, 'yes');
  assert.equal(sent[0].skippedReason, null);

  const open = await filterRelevant({ a: 'zzzz'.repeat(100) }, 't', {
    model: 'cheap-test',
    cache: null,
    maxBytes: null,
    callLlm: mock.fn,
  });
  assert.equal(open[0].decision, 'no');
});

test('a file of exactly maxBytes is sent', async () => {
  const mock = llm(['yes']);
  const content = 'abcd';
  const decisions = await filterRelevant({ a: content }, 't', {
    model: 'cheap-test',
    cache: null,
    maxBytes: 4,
    callLlm: mock.fn,
  });
  assert.equal(decisions[0].decision, 'yes');
  assert.equal(mock.stats().count, 1);
});

test('concurrency stays bounded and result order follows the input', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const files = Object.fromEntries(names.map((n) => [n, `body ${n}`]));
  const mock = llm(names.map(() => 'yes'));
  const decisions = await filterRelevant(files, 'all', {
    model: 'cheap-test',
    concurrency: 2,
    cache: null,
    callLlm: mock.fn,
  });
  assert.deepEqual(decisions.map((d) => d.path), names);
  assert.equal(mock.stats().maxInFlight, 2);
  assert.equal(mock.stats().count, 6);
});

test('cache is keyed by model, task hash, and content hash', async () => {
  const cache = createMemoryCache();
  const first = llm(['yes — greeting']);
  const files = { 'greet.py': 'print("hello")\n' };
  const task = 'change the greeting';
  await filterRelevant(files, task, { model: 'cheap-a', cache, callLlm: first.fn });

  const second = llm(['no']);
  const again = await filterRelevant({ 'other.py': 'print("hello")\n' }, task, {
    model: 'cheap-a',
    cache,
    callLlm: second.fn,
  });
  assert.equal(second.stats().count, 0);
  assert.equal(again[0].cached, true);
  assert.equal(again[0].path, 'other.py');
  assert.equal(again[0].decision, 'yes');
  assert.equal(again[0].reason, 'greeting');
  assert.equal(again[0].tokens, 11);

  const otherTask = llm(['no']);
  const moved = await filterRelevant(files, 'rename the function', {
    model: 'cheap-a',
    cache,
    callLlm: otherTask.fn,
  });
  assert.equal(moved[0].cached, false);
  assert.equal(moved[0].decision, 'no');

  const otherModel = llm(['no']);
  const remodeled = await filterRelevant(files, task, {
    model: 'cheap-b',
    cache,
    callLlm: otherModel.fn,
  });
  assert.equal(remodeled[0].cached, false);
  assert.equal(otherModel.stats().count, 1);

  const stored = [];
  const custom = {
    async get(key) {
      stored.push(['get', key]);
      return undefined;
    },
    async set(key, value) {
      stored.push(['set', key, value.decision]);
    },
  };
  await filterRelevant({ p: 'body' }, 'task', { model: 'm', cache: custom, callLlm: llm(['yes']).fn });
  const set = stored.find((row) => row[0] === 'set');
  assert.ok(set);
  const parts = set[1].split('\0');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'm');
  assert.match(parts[1], /^[0-9a-f]{64}$/);
  assert.match(parts[2], /^[0-9a-f]{64}$/);
  assert.notEqual(parts[1], parts[2]);
});

test('ambiguous answers are not cached', async () => {
  const cache = createMemoryCache();
  const first = llm(['maybe']);
  await filterRelevant({ a: 'body' }, 'task', { model: 'm', cache, callLlm: first.fn });
  const second = llm(['no']);
  const decisions = await filterRelevant({ a: 'body' }, 'task', { model: 'm', cache, callLlm: second.fn });
  assert.equal(second.stats().count, 1);
  assert.equal(decisions[0].decision, 'no');
  assert.equal(decisions[0].cached, false);
});

test('default model and the shared memory cache', async () => {
  const prev = process.env.GPTDIFF_FILTER_MODEL;
  setEnv('GPTDIFF_FILTER_MODEL', 'from-env');
  try {
    const mock = llm(['yes']);
    const task = `env-model-${Date.now()}`;
    await filterRelevant({ a: `unique-${task}` }, task, { cache: undefined, callLlm: mock.fn });
    assert.equal(mock.calls[0].model, 'from-env');
    const again = llm(['no']);
    const hit = await filterRelevant({ b: `unique-${task}` }, task, { callLlm: again.fn });
    assert.equal(again.stats().count, 0);
    assert.equal(hit[0].cached, true);
  } finally {
    setEnv('GPTDIFF_FILTER_MODEL', undefined);
    if (prev === undefined) delete process.env.GPTDIFF_FILTER_MODEL;
    else process.env.GPTDIFF_FILTER_MODEL = prev;
  }
  assert.equal(typeof DEFAULT_FILTER_MODEL, 'string');
  assert.equal(DEFAULT_FILTER_MAX_BYTES, 262144);
});

test('buildEnvironment includes only yes files when decisions are passed', () => {
  const files = {
    'greet.py': 'hello\n',
    'main.py': 'main\n',
    'math_utils.py': 'add\n',
    'logo.bin': 'PNG',
  };
  const untouched = buildEnvironment(files);
  assert.match(untouched, /File: greet\.py/);
  assert.match(untouched, /File: math_utils\.py/);
  assert.match(untouched, /File: logo\.bin/);

  const decisions = [
    { path: 'greet.py', decision: 'yes' },
    { path: 'main.py', decision: 'no' },
    { path: 'math_utils.py', decision: 'skip', skippedReason: 'binary' },
    { path: 'logo.bin', decision: 'skip', skippedReason: 'too-large' },
  ];
  const filtered = buildEnvironment(files, { decisions });
  assert.match(filtered, /File: greet\.py/);
  assert.match(filtered, /hello/);
  assert.doesNotMatch(filtered, /math_utils/);
  assert.doesNotMatch(filtered, /main/);
  assert.doesNotMatch(filtered, /logo/);
  assert.equal(filtered, buildEnvironment(files, decisions));

  const includedByError = buildEnvironment(files, {
    decisions: [{ path: 'main.py', decision: 'yes', error: 'ambiguous answer' }],
  });
  assert.match(includedByError, /File: main\.py/);
  assert.doesNotMatch(includedByError, /greet/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filterRelevant,
  RelevanceCache,
  createMemoryCache,
  parseRelevanceAnswer,
  isBinaryContent,
  countTokens,
  formatFilterSummary,
  dumpDecisions,
  buildEnvironment,
  DEFAULT_FILTER_MODEL,
  DEFAULT_FILTER_MAX_BYTES,
  DEFAULT_FILTER_MAX_TOKENS,
  DEFAULT_FILTER_MAX_OUTPUT_TOKENS,
  DEFAULT_FILTER_REASONING_EFFORT,
  DEFAULT_FILTER_CONCURRENCY,
  FILTER_PROMPT_VERSION,
  PROMPT_VERSION,
  DEFAULT_IGNORE_PATTERNS,
  isIgnoredPath,
  callLlm,
} from '../src/index.js';
import { setEnv } from '../src/env.js';

function response(content, prompt = 11, completion = 3, total = prompt + completion) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
  };
}

function llm(replies) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (req) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const index = calls.length;
    calls.push(req);
    const next = typeof replies === 'function' ? await replies(req, index) : replies[index];
    inFlight -= 1;
    if (next instanceof Error) throw next;
    if (next && typeof next === 'object' && next.choices) return next;
    return response(next == null ? 'yes' : String(next));
  };
  return { fn, calls, stats: () => ({ maxInFlight, count: calls.length }) };
}

function pathsOf(req) {
  const user = req.messages[req.messages.length - 1].content;
  const match = user.match(/File paths?:\n([\s\S]*?)\n\n/);
  assert.ok(match, user);
  return match[1].split('\n');
}

function bodyOf(req) {
  const user = req.messages[req.messages.length - 1].content;
  const marker = 'File contents:\n';
  const start = user.indexOf(marker);
  assert.notEqual(start, -1);
  return user.slice(start + marker.length).replace(/\n\nIs this file relevant to the task\? yes\/no$/, '');
}

function answerFor(req, unmatched = 'no — unrelated') {
  const body = bodyOf(req);
  if (body.includes('def keep') || body.includes('ALPHA_TOKEN')) return response('yes — needed for the task');
  if (body.includes('BINARY_PREVIEW')) return response('yes the path matches');
  return response(unmatched);
}

const baseOpts = { model: 'fake-model', apiKey: 'test-key', cache: false };

let envLock = Promise.resolve();
function withEnv(fn) {
  const run = envLock.then(fn, fn);
  envLock = run.then(() => {}, () => {});
  return run;
}

test('parseRelevanceAnswer accepts yes/no variants and drops a fence', () => {
  assert.equal(parseRelevanceAnswer('yes').decision, 'yes');
  assert.equal(parseRelevanceAnswer('Yes.').decision, 'yes');
  assert.equal(parseRelevanceAnswer('NO\nthis file is a changelog').decision, 'no');
  assert.equal(parseRelevanceAnswer('Answer: yes, the parser lives here').decision, 'yes');
  const fenced = parseRelevanceAnswer('```\nyes\n```');
  assert.equal(fenced.decision, 'yes');
  assert.ok(fenced.cleaned.includes('yes'));
});

test('parseRelevanceAnswer strips think tags before deciding', () => {
  const yes = parseRelevanceAnswer('<think>no, this file is irrelevant</think>\nyes, the function to rename is here');
  assert.equal(yes.decision, 'yes');
  assert.equal(yes.cleaned.includes('irrelevant'), false);

  assert.equal(parseRelevanceAnswer('<think>yes, definitely edit it</think>\nno — tests only').decision, 'no');
  assert.equal(parseRelevanceAnswer('<think>no, skip this file entirely').decision, null);
  assert.equal(parseRelevanceAnswer('<thinking>maybe</thinking>\nyes').decision, 'yes');
});

test('parseRelevanceAnswer is malformed without a leading standalone yes or no', () => {
  assert.equal(parseRelevanceAnswer("I'm not sure about this one").decision, null);
  assert.equal(parseRelevanceAnswer('').decision, null);
  assert.equal(parseRelevanceAnswer('nope').decision, null);
  assert.equal(parseRelevanceAnswer('The answer is no.').decision, null);
  assert.equal(parseRelevanceAnswer('yes for the helper, no for the tests').decision, 'yes');
  assert.equal(parseRelevanceAnswer('yes/no').decision, null);
  assert.equal(parseRelevanceAnswer('yes-no').decision, null);
  assert.equal(parseRelevanceAnswer('yes?').decision, null);
  assert.equal(parseRelevanceAnswer('yes!').decision, 'yes');
  assert.equal(parseRelevanceAnswer('no)').decision, 'no');
});

test('parseRelevanceAnswer: quoted yes/no is a decision', () => {
  assert.equal(parseRelevanceAnswer('"yes"').decision, 'yes');
  assert.equal(parseRelevanceAnswer("'no'").decision, 'no');
  assert.equal(parseRelevanceAnswer('**yes**').decision, 'yes');
  assert.equal(parseRelevanceAnswer('`no`').decision, 'no');
  assert.equal(parseRelevanceAnswer('Answer: **yes**').decision, 'yes');
  assert.equal(parseRelevanceAnswer('Decision: "no"').decision, 'no');
});

test('parseRelevanceAnswer: a quoted decision followed by a reason is that decision', () => {
  assert.equal(parseRelevanceAnswer('**no** unrelated').decision, 'no');
  assert.equal(parseRelevanceAnswer('"no" unrelated').decision, 'no');
  assert.equal(parseRelevanceAnswer('\u201cno\u201d \u2014 unrelated').decision, 'no');
  assert.equal(parseRelevanceAnswer('**yes** the helper').decision, 'yes');
  assert.equal(parseRelevanceAnswer('nope').decision, null);
  assert.equal(parseRelevanceAnswer('yes/no').decision, null);
});

test('parseRelevanceAnswer: negated "There is no doubt this file is required" is malformed', () => {
  const parsed = parseRelevanceAnswer('There is no doubt this file is required');
  assert.equal(parsed.decision, null);
  assert.match(parsed.cleaned, /no doubt/);
});

test('parseRelevanceAnswer: explanatory wording is malformed', () => {
  assert.equal(parseRelevanceAnswer('The file defines helpers used by the task').decision, null);
  assert.equal(parseRelevanceAnswer('I would say no because it is unrelated').decision, null);
  assert.equal(parseRelevanceAnswer('This file is not relevant to the task').decision, null);
});

test('filterRelevant keeps only yes files and reports camelCase decisions', async () => {
  const mock = llm((req) => answerFor(req));
  const files = {
    'keep.py': 'def keep():\n    return 1\n',
    'drop.py': 'def drop():\n    return 2\n',
  };
  const seen = [];
  const result = await filterRelevant(files, 'Update keep()', {
    ...baseOpts,
    baseUrl: 'https://example.test/v1',
    callLlm: mock.fn,
    onDecision: (d) => seen.push(d.path),
  });

  assert.deepEqual(Object.keys(result.files), ['keep.py']);
  assert.equal(result.files['keep.py'], files['keep.py']);
  assert.deepEqual(result.decisions.map((d) => d.path), ['keep.py', 'drop.py']);
  assert.deepEqual(result.decisions.map((d) => d.decision), ['yes', 'no']);
  assert.equal(result.model, 'fake-model');
  const yes = result.decisions[0];
  assert.ok(yes.raw.startsWith('yes'));
  assert.ok(yes.reason.includes('needed'));
  assert.equal(yes.tokens, 14);
  assert.equal(yes.promptTokens, 11);
  assert.equal(yes.completionTokens, 3);
  assert.equal(yes.cached, false);
  assert.equal(yes.skippedReason, null);
  assert.equal(yes.error, null);
  assert.equal('cacheKey' in yes, false);
  assert.deepEqual(seen.sort(), ['drop.py', 'keep.py']);

  assert.equal(mock.calls.length, 2);
  for (const call of mock.calls) {
    assert.equal(call.model, 'fake-model');
    assert.equal(call.apiKey, 'test-key');
    assert.equal(call.baseUrl, 'https://example.test/v1');
    assert.equal(call.temperature, 0);
    assert.equal(call.maxTokens, DEFAULT_FILTER_MAX_OUTPUT_TOKENS);
    assert.equal(call.reasoningEffort, 'low');
    assert.equal(call.maxRetries, 0);
    assert.match(call.messages[1].content, /Task:\nUpdate keep\(\)/);
    assert.match(call.messages[1].content, /Is this file relevant to the task\? yes\/no/);
  }
  assert.ok(bodyOf(mock.calls[0]).includes('def keep') || bodyOf(mock.calls[1]).includes('def keep'));
});

test('ambiguous answers and thrown errors include the file', async () => {
  const mock = llm((req) => {
    const paths = pathsOf(req);
    if (paths.includes('ambiguous.py')) return response('<think>no</think>\nmaybe later');
    throw new Error('connection reset');
  });
  const result = await filterRelevant(
    { 'ambiguous.py': 'x = 1\n', 'broken.py': 'y = 2\n' },
    'Touch both',
    { ...baseOpts, callLlm: mock.fn },
  );
  assert.deepEqual(Object.keys(result.files).sort(), ['ambiguous.py', 'broken.py']);
  const by = Object.fromEntries(result.decisions.map((d) => [d.path, d]));
  assert.equal(by['ambiguous.py'].decision, 'yes');
  assert.equal(by['ambiguous.py'].error, null);
  assert.equal(by['ambiguous.py'].failedOpen, true);
  assert.match(by['ambiguous.py'].reason, /malformed/);
  assert.equal(by['broken.py'].decision, 'yes');
  assert.equal(by['broken.py'].failedOpen, true);
  assert.match(by['broken.py'].error, /connection reset/);
  assert.match(by['broken.py'].reason, /connection reset/);
  assert.equal(by['broken.py'].tokens, 0);
  assert.deepEqual(result.errors, [by['broken.py']]);
  assert.equal(result.failedOpen, 2);
  const summary = formatFilterSummary(result);
  assert.match(summary, /connection reset/);
  assert.match(summary, /included by default/);
  assert.match(summary, /2 failed open/);
});

test('errors are not cached', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    if (n === 1) throw new Error('temporary');
    return response('no');
  });
  const cache = new RelevanceCache();
  const files = { 'a.py': "print('a')\n" };
  const opts = { model: 'fake', cache, apiKey: 'test-key', callLlm: mock.fn };
  const first = await filterRelevant(files, 'edit a', opts);
  const second = await filterRelevant(files, 'edit a', opts);
  assert.equal(first.decisions[0].decision, 'yes');
  assert.ok(first.decisions[0].error);
  assert.equal(second.decisions[0].decision, 'no');
  assert.equal(second.decisions[0].error, null);
  assert.equal(n, 2);
});

test('memory and disk cache round-trip', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return response('yes', 5, 1, 6);
  });
  const dir = mkdtempSync(join(tmpdir(), 'patchling-filter-'));
  const disk = join(dir, 'relevance-cache.json');
  const files = { 'a.py': "print('cached')\n" };
  const firstCache = new RelevanceCache(disk);
  const first = await filterRelevant(files, 'ship it', {
    model: 'fake', cache: firstCache, apiKey: 'test-key', callLlm: mock.fn,
  });
  assert.equal(first.decisions[0].cached, false);
  assert.equal(n, 1);
  const stored = JSON.parse(readFileSync(disk, 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(Object.keys(stored.entries).length, 1);
  const [storedKey, storedValue] = Object.entries(stored.entries)[0];
  assert.match(storedKey, /^[0-9a-f]{64}$/);
  const expectedKey = await RelevanceCache.makeKey({
    model: 'fake',
    intent: 'ship it',
    path: 'a.py',
    content: "print('cached')\n",
    maxOutputTokens: DEFAULT_FILTER_MAX_OUTPUT_TOKENS,
    reasoningEffort: 'low',
    promptVersion: FILTER_PROMPT_VERSION,
  });
  assert.equal(storedKey, expectedKey);
  assert.equal(storedValue.decision, 'yes');
  assert.equal(storedValue.prompt_tokens, 5);
  assert.equal(storedValue.skipped_reason, null);

  const second = await filterRelevant(files, 'ship it', {
    model: 'fake', cache: new RelevanceCache(disk), apiKey: 'test-key', callLlm: mock.fn,
  });
  assert.equal(n, 1);
  assert.equal(second.decisions[0].cached, true);
  assert.equal(second.decisions[0].tokens, 6);
  assert.equal(second.decisions[0].promptTokens, 5);
  assert.equal(second.billedTokens, 0);
  assert.ok(second.files['a.py']);

  await filterRelevant(files, 'other task', { model: 'fake', cache: firstCache, apiKey: 'k', callLlm: mock.fn });
  await filterRelevant(files, 'ship it', { model: 'other-model', cache: firstCache, apiKey: 'k', callLlm: mock.fn });
  await filterRelevant(
    { 'a.py': "print('changed')\n" },
    'ship it',
    { model: 'fake', cache: firstCache, apiKey: 'k', callLlm: mock.fn },
  );
  assert.equal(n, 4);
});

test('a cache path string enables disk cache and false disables it', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return response('no');
  });
  const dir = mkdtempSync(join(tmpdir(), 'patchling-filter-'));
  const disk = join(dir, 'nested', 'cache.json');
  const files = { 'a.py': 'v = 1\n' };
  await filterRelevant(files, 'task', { model: 'm', cache: disk, apiKey: 'k', callLlm: mock.fn });
  await filterRelevant(files, 'task', { model: 'm', cache: disk, apiKey: 'k', callLlm: mock.fn });
  assert.equal(n, 1);

  await filterRelevant(files, 'task', { model: 'm', cache: false, apiKey: 'k', callLlm: mock.fn });
  await filterRelevant(files, 'task', { model: 'm', cache: null, apiKey: 'k', callLlm: mock.fn });
  assert.equal(n, 3);
});

test('a corrupt disk cache is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patchling-filter-'));
  const disk = join(dir, 'cache.json');
  writeFileSync(disk, '{not json');
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return response('yes');
  });
  const result = await filterRelevant(
    { 'a.py': 'v = 1\n' },
    'task',
    { model: 'm', cache: new RelevanceCache(disk), apiKey: 'k', callLlm: mock.fn },
  );
  assert.equal(n, 1);
  assert.equal(result.decisions[0].decision, 'yes');
  const rewritten = JSON.parse(readFileSync(disk, 'utf8'));
  assert.equal(rewritten.version, 1);
});

test('same-batch: empty unrelated.py "no" does not exclude empty src/target.py', async () => {
  const mock = llm((req) => {
    const paths = pathsOf(req);
    assert.equal(paths.length, 1);
    return response(paths[0] === 'unrelated.py' ? 'no' : 'yes');
  });
  const result = await filterRelevant(
    { 'unrelated.py': '', 'src/target.py': '' },
    'edit the target',
    { ...baseOpts, cache: false, callLlm: mock.fn },
  );
  assert.equal(mock.calls.length, 2);
  const by = Object.fromEntries(result.decisions.map((d) => [d.path, d]));
  assert.equal(by['unrelated.py'].decision, 'no');
  assert.equal(by['unrelated.py'].failedOpen, false);
  assert.equal(by['src/target.py'].decision, 'yes');
  assert.equal(by['src/target.py'].cached, false);
  assert.deepEqual(Object.keys(result.files), ['src/target.py']);
  assert.equal(result.files['src/target.py'], '');
});

test('cross-call: cached no for empty unrelated.py does not exclude empty src/target.py', async () => {
  const cache = new RelevanceCache();
  let n = 0;
  const mock = llm((req) => {
    n += 1;
    const paths = pathsOf(req);
    return response(paths[0] === 'unrelated.py' ? 'no' : 'yes');
  });
  const opts = { model: 'm', cache, apiKey: 'k', callLlm: mock.fn };
  const first = await filterRelevant({ 'unrelated.py': '' }, 'edit the target', opts);
  assert.equal(first.decisions[0].decision, 'no');
  const second = await filterRelevant(
    { 'unrelated.py': '', 'src/target.py': '' },
    'edit the target',
    opts,
  );
  assert.equal(n, 2);
  const by = Object.fromEntries(second.decisions.map((d) => [d.path, d]));
  assert.equal(by['unrelated.py'].decision, 'no');
  assert.equal(by['unrelated.py'].cached, true);
  assert.equal(by['src/target.py'].decision, 'yes');
  assert.equal(by['src/target.py'].cached, false);
  assert.equal('src/target.py' in second.files, true);
});

test('concurrency stays bounded and result order follows the input', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `file-${i}.py`);
  const files = Object.fromEntries(names.map((name, i) => [name, `body ${i}\n`]));
  const mock = llm(async (req) => {
    const header = req.messages[1].content.split('File contents:')[0];
    if (header.includes('file-9.py')) await new Promise((r) => setTimeout(r, 40));
    else await new Promise((r) => setTimeout(r, 15));
    const relevant = header.includes('file-1.py') || header.includes('file-9.py');
    return response(relevant ? 'yes' : 'no', 1, 1, 2);
  });
  const result = await filterRelevant(files, 'touch file-1 and file-9', {
    model: 'm',
    concurrency: 3,
    cache: false,
    apiKey: 'k',
    callLlm: mock.fn,
  });
  assert.ok(mock.stats().maxInFlight <= 3);
  assert.ok(mock.stats().maxInFlight >= 2);
  assert.deepEqual(result.decisions.map((d) => d.path), names);
  assert.deepEqual(Object.keys(result.files).sort(), ['file-1.py', 'file-9.py']);
});

test('binary and oversize policies keep original contents on yes', async () => {
  let n = 0;
  const mock = llm((req) => {
    n += 1;
    const user = req.messages[1].content;
    assert.equal(user.includes('SECRET_TAIL'), false);
    if (user.includes('contents omitted')) {
      assert.ok(user.includes('bin.dat'));
      return response('no');
    }
    return response('yes — prefix is enough');
  });
  const binary = 'hello\0world';
  const huge = `PREFIX ${'x'.repeat(80)} SECRET_TAIL`;
  const limits = { maxBytes: 40, maxTokens: null };

  const excluded = await filterRelevant(
    { 'bin.dat': binary, 'big.py': huge },
    'edit the prefix',
    { model: 'm', cache: false, onBinary: 'exclude', onOversize: 'exclude', ...limits, callLlm: mock.fn },
  );
  assert.equal(n, 0);
  assert.deepEqual(excluded.files, {});
  const excludedBy = Object.fromEntries(excluded.decisions.map((d) => [d.path, d]));
  assert.equal(excludedBy['bin.dat'].decision, 'no');
  assert.equal(excludedBy['bin.dat'].skippedReason, 'binary');
  assert.equal(excludedBy['big.py'].decision, 'no');
  assert.equal(excludedBy['big.py'].skippedReason, 'oversize');
  assert.equal(excludedBy['big.py'].tokens, 0);
  assert.equal(excludedBy['big.py'].reason.includes('over size threshold'), true);

  const included = await filterRelevant(
    { 'bin.dat': binary, 'big.py': huge },
    'edit the prefix',
    { model: 'm', cache: false, onBinary: 'include', onOversize: 'include', ...limits, callLlm: mock.fn },
  );
  assert.equal(n, 0);
  assert.deepEqual(Object.keys(included.files).sort(), ['big.py', 'bin.dat']);
  assert.equal(included.files['big.py'], huge);
  assert.equal(included.files['bin.dat'], binary);
  assert.deepEqual(included.decisions.map((d) => d.decision), ['yes', 'yes']);

  n = 0;
  const truncated = await filterRelevant(
    { 'bin.dat': new Uint8Array([0, 1, ...Buffer.from('BINARY_PREVIEW')]), 'big.py': huge },
    'edit the prefix',
    {
      model: 'm',
      cache: false,
      apiKey: 'k',
      onBinary: 'truncate',
      onOversize: 'truncate',
      ...limits,
      callLlm: mock.fn,
    },
  );
  assert.equal(n, 2);
  const truncatedBy = Object.fromEntries(truncated.decisions.map((d) => [d.path, d]));
  assert.equal(truncatedBy['big.py'].decision, 'yes');
  assert.equal(truncatedBy['big.py'].skippedReason, 'truncated');
  assert.equal(truncated.files['big.py'], huge);
  assert.equal(truncatedBy['bin.dat'].decision, 'no');
  assert.equal(truncatedBy['bin.dat'].skippedReason, 'truncated');
  assert.equal('bin.dat' in truncated.files, false);
});

test('a truncated judgment is not reused as a full read', async () => {
  let n = 0;
  const mock = llm((req) => {
    n += 1;
    const user = req.messages[1].content;
    return response(user.includes('truncated') ? 'no' : 'yes');
  });
  const dir = mkdtempSync(join(tmpdir(), 'patchling-filter-'));
  const cache = new RelevanceCache(join(dir, 'cache.json'));
  const files = { 'big.py': `PREFIX ${'x'.repeat(50)}` };
  const first = await filterRelevant(files, 'task', {
    model: 'm', cache, apiKey: 'k', maxBytes: 20, maxTokens: null, onOversize: 'truncate', callLlm: mock.fn,
  });
  const second = await filterRelevant(files, 'task', {
    model: 'm', cache, apiKey: 'k', maxBytes: 10_000, maxTokens: null, callLlm: mock.fn,
  });
  assert.equal(first.decisions[0].decision, 'no');
  assert.equal(first.decisions[0].skippedReason, 'truncated');
  assert.equal(second.decisions[0].decision, 'yes');
  assert.equal(second.decisions[0].cached, false);
  assert.equal(second.decisions[0].skippedReason, null);
  assert.equal(n, 2);
  const stored = JSON.parse(readFileSync(cache.path, 'utf8'));
  assert.equal(Object.keys(stored.entries).length, 2);
});

test('maxBytes counts UTF-8 bytes and a token cap truncates before the byte cap', async () => {
  const seen = [];
  const mock = llm((req) => {
    seen.push(bodyOf(req));
    return response('yes');
  });
  const accented = 'é';
  const excluded = await filterRelevant({ a: accented, b: 'b' }, 't', {
    ...baseOpts,
    maxBytes: 1,
    maxTokens: null,
    onOversize: 'exclude',
    callLlm: mock.fn,
  });
  assert.equal(excluded.decisions[0].skippedReason, 'oversize');
  assert.equal(excluded.decisions[0].decision, 'no');
  assert.equal(excluded.decisions[1].decision, 'yes');
  assert.equal(excluded.decisions[1].skippedReason, null);

  const exact = await filterRelevant({ a: 'abcd' }, 't', {
    ...baseOpts, maxBytes: 4, maxTokens: null, callLlm: mock.fn,
  });
  assert.equal(exact.decisions[0].skippedReason, null);
  assert.equal(exact.files.a, 'abcd');

  const long = 'y'.repeat(40);
  const truncated = await filterRelevant({ a: long }, 't', {
    ...baseOpts, maxBytes: null, maxTokens: 4, callLlm: mock.fn,
  });
  assert.equal(countTokens(long) > 4, true);
  assert.equal(truncated.decisions[0].skippedReason, 'truncated');
  assert.equal(truncated.files.a, long);
  assert.equal(seen.at(-1), long.slice(0, 16));
});

test('zero disables both size limits', async () => {
  const seen = [];
  const mock = llm((req) => {
    seen.push(req.messages[1].content);
    return response('yes');
  });
  const body = 'y'.repeat(250_000);
  const result = await filterRelevant({ 'big.py': body }, 'read the whole file', {
    ...baseOpts,
    maxBytes: 0,
    maxTokens: 0,
    onOversize: 'truncate',
    callLlm: mock.fn,
  });
  assert.equal(Object.keys(result.files).length, 1);
  assert.equal(seen[0].includes('truncated to fit'), false);
  assert.ok(seen[0].includes(body));
  assert.equal(result.files['big.py'], body);
});

test('missing api key throws only when a call is required', async () => withEnv(async () => {
  const prev = process.env.GPTDIFF_LLM_API_KEY;
  delete process.env.GPTDIFF_LLM_API_KEY;
  setEnv('GPTDIFF_LLM_API_KEY', undefined);
  try {
    const skipped = await filterRelevant({ 'bin.dat': '\0' }, 'task', {
      model: 'm',
      cache: false,
      onBinary: 'exclude',
      callLlm: () => { throw new Error('should not be called'); },
    });
    assert.deepEqual(skipped.files, {});

    await assert.rejects(
      () => filterRelevant({ 'a.py': 'x = 1\n' }, 'task', {
        model: 'm',
        cache: false,
        callLlm: () => { throw new Error('should not be called'); },
      }),
      /GPTDIFF_LLM_API_KEY/,
    );
  } finally {
    setEnv('GPTDIFF_LLM_API_KEY', undefined);
    if (prev === undefined) delete process.env.GPTDIFF_LLM_API_KEY;
    else process.env.GPTDIFF_LLM_API_KEY = prev;
  }
}));

test('cached files do not need an api key', async () => withEnv(async () => {
  const prev = process.env.GPTDIFF_LLM_API_KEY;
  delete process.env.GPTDIFF_LLM_API_KEY;
  setEnv('GPTDIFF_LLM_API_KEY', undefined);
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return response('no');
  });
  try {
    const cache = createMemoryCache();
    assert.ok(cache instanceof RelevanceCache);
    const files = { 'a.py': 'x = 1\n' };
    await filterRelevant(files, 'task', { model: 'm', cache, apiKey: 'k', callLlm: mock.fn });
    const result = await filterRelevant(files, 'task', { model: 'm', cache, callLlm: mock.fn });
    assert.equal(n, 1);
    assert.equal(result.decisions[0].cached, true);
    assert.equal(result.decisions[0].decision, 'no');
  } finally {
    setEnv('GPTDIFF_LLM_API_KEY', undefined);
    if (prev === undefined) delete process.env.GPTDIFF_LLM_API_KEY;
    else process.env.GPTDIFF_LLM_API_KEY = prev;
  }
}));

test('invalid arguments throw', async () => {
  await assert.rejects(
    () => filterRelevant({ 'a.py': 'x' }, 'task', { concurrency: 0, cache: false, apiKey: 'k' }),
    /concurrency/,
  );
  await assert.rejects(
    () => filterRelevant({ 'a.py': 'x' }, 'task', { onOversize: 'drop', cache: false, apiKey: 'k' }),
    /onOversize/,
  );
  await assert.rejects(
    () => filterRelevant({ 'a.py': 'x' }, '  ', { cache: false, apiKey: 'k' }),
    /task/,
  );
  await assert.rejects(
    () => filterRelevant([['a.py', 'x']], 'task', { cache: false, apiKey: 'k' }),
    TypeError,
  );
  await assert.rejects(
    () => filterRelevant({ 'a.py': 'x' }, 'task', { cache: {}, apiKey: 'k' }),
    TypeError,
  );
  await assert.rejects(
    () => filterRelevant({ 'a.py': 1 }, 'task', { cache: false, apiKey: 'k', callLlm: llm(['yes']).fn }),
    TypeError,
  );
  await assert.rejects(
    () => filterRelevant({ 'a.py': 'x' }, 'task', { cache: false, apiKey: 'k', ignore: 'nope' }),
    TypeError,
  );
});

test('model defaults to GPTDIFF_FILTER_MODEL, else xiaomi/mimo-v2.6-flash', async () => withEnv(async () => {
  const prevFilter = process.env.GPTDIFF_FILTER_MODEL;
  const prevBase = process.env.GPTDIFF_LLM_BASE_URL;
  delete process.env.GPTDIFF_FILTER_MODEL;
  setEnv('GPTDIFF_FILTER_MODEL', undefined);
  setEnv('GPTDIFF_LLM_BASE_URL', 'https://example.test/v1/');
  const seen = [];
  const mock = llm((req) => {
    seen.push(req);
    return response('yes');
  });
  try {
    const fromEnv = await filterRelevant({ 'a.py': 'x = 1\n' }, 'task', {
      cache: false,
      apiKey: 'from-arg',
      callLlm: mock.fn,
    });
    setEnv('GPTDIFF_FILTER_MODEL', 'env-filter-model');
    const named = await filterRelevant({ 'a.py': 'x = 1\n' }, 'task', {
      cache: false,
      apiKey: 'from-arg',
      callLlm: mock.fn,
    });
    assert.equal(seen[0].model, DEFAULT_FILTER_MODEL);
    assert.equal(fromEnv.model, 'xiaomi/mimo-v2.6-flash');
    assert.equal(seen[0].baseUrl, 'https://example.test/v1/');
    assert.equal(seen[0].apiKey, 'from-arg');
    assert.equal(seen[0].reasoningEffort, 'low');
    assert.ok(seen[0].messages[0].content.startsWith('You are a relevance filter'));
    assert.ok(seen[0].messages[1].content.startsWith('Task:\n'));
    assert.equal(named.model, 'env-filter-model');
    assert.equal(seen[1].model, 'env-filter-model');
    const gemini = llm(() => response('yes'));
    await filterRelevant({ 'a.py': 'x = 1\n' }, 'task', {
      model: 'gemini-2.0-flash',
      cache: false,
      apiKey: 'from-arg',
      callLlm: gemini.fn,
    });
    assert.ok(gemini.calls[0].messages[1].content.startsWith('You are a relevance filter'));
  } finally {
    setEnv('GPTDIFF_FILTER_MODEL', undefined);
    setEnv('GPTDIFF_LLM_BASE_URL', undefined);
    if (prevFilter === undefined) delete process.env.GPTDIFF_FILTER_MODEL;
    else process.env.GPTDIFF_FILTER_MODEL = prevFilter;
    if (prevBase === undefined) delete process.env.GPTDIFF_LLM_BASE_URL;
    else process.env.GPTDIFF_LLM_BASE_URL = prevBase;
  }
  assert.equal(DEFAULT_FILTER_MODEL, 'xiaomi/mimo-v2.6-flash');
  assert.equal(DEFAULT_FILTER_MAX_BYTES, 200_000);
  assert.equal(DEFAULT_FILTER_MAX_TOKENS, 12_000);
  assert.equal(DEFAULT_FILTER_MAX_OUTPUT_TOKENS, 1024);
  assert.equal(DEFAULT_FILTER_REASONING_EFFORT, 'low');
  assert.equal(FILTER_PROMPT_VERSION, 3);
  assert.equal(PROMPT_VERSION, 3);
  assert.equal(DEFAULT_FILTER_CONCURRENCY, 8);
  assert.equal(isBinaryContent('hello\0world'), true);
  assert.equal(isBinaryContent('plain text'), false);
  assert.equal(countTokens(''), 0);
  assert.equal(countTokens('abcd'), 1);
}));

test('omitting cache does not reuse a previous call', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return response('yes');
  });
  await filterRelevant({ a: 'body' }, 'task', { model: 'm', apiKey: 'k', callLlm: mock.fn });
  await filterRelevant({ a: 'body' }, 'task', { model: 'm', apiKey: 'k', callLlm: mock.fn });
  assert.equal(n, 2);
});

test('dumpDecisions writes camelCase decisions', async () => {
  const mock = llm(() => response('yes — keep'));
  const result = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', { ...baseOpts, callLlm: mock.fn });
  const dir = mkdtempSync(join(tmpdir(), 'patchling-filter-'));
  const dest = join(dir, 'out', 'decisions.json');
  mkdirSync(join(dir, 'out'), { recursive: true });
  await dumpDecisions(result, dest);
  const saved = JSON.parse(readFileSync(dest, 'utf8'));
  assert.deepEqual(saved.files, ['a.py']);
  assert.equal(saved.decisions[0].promptTokens, 11);
  assert.equal(saved.decisions[0].skippedReason, null);
  assert.equal('skipped_reason' in saved.decisions[0], false);
  assert.equal(saved.billedTokens, 14);
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
    { path: 'math_utils.py', decision: 'no', skippedReason: 'binary' },
    { path: 'logo.bin', decision: 'no', skippedReason: 'oversize' },
  ];
  const filtered = buildEnvironment(files, { decisions });
  assert.match(filtered, /File: greet\.py/);
  assert.match(filtered, /hello/);
  assert.doesNotMatch(filtered, /math_utils/);
  assert.doesNotMatch(filtered, /main/);
  assert.doesNotMatch(filtered, /logo/);
  assert.equal(filtered, buildEnvironment(files, decisions));

  const includedByError = buildEnvironment(files, {
    decisions: [{ path: 'main.py', decision: 'yes', error: 'Error: connection reset' }],
  });
  assert.match(includedByError, /File: main\.py/);
  assert.doesNotMatch(includedByError, /greet/);
});

function statusError(status) {
  const err = new Error(`LLM request failed (${status}) from example: unavailable`);
  err.status = status;
  return err;
}

test('an empty answer is an error, fails open, and is not cached', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    if (n === 1) return response('<think>no, skip this file</think>');
    return response('no');
  });
  const cache = new RelevanceCache();
  const files = { 'a.py': 'v = 1\n' };
  const first = await filterRelevant(files, 'task', {
    model: 'm', cache, apiKey: 'k', callLlm: mock.fn, retryBaseMs: 0,
  });
  assert.equal(first.decisions[0].decision, 'yes');
  assert.equal(first.decisions[0].error, 'empty answer');
  assert.equal(first.failedOpen, 1);
  assert.equal('a.py' in first.files, true);
  assert.match(formatFilterSummary(first), /1 failed open/);
  const stored = await cache.get(await RelevanceCache.makeKey({
    model: 'm', intent: 'task', path: 'a.py', content: 'v = 1\n',
  }));
  assert.equal(stored, undefined);

  const second = await filterRelevant(files, 'task', {
    model: 'm', cache, apiKey: 'k', callLlm: mock.fn, retryBaseMs: 0,
  });
  assert.equal(n, 2);
  assert.equal(second.decisions[0].decision, 'no');
  assert.equal(second.decisions[0].error, null);
  assert.equal(second.decisions[0].cached, false);
  assert.equal(second.failedOpen, 0);
});

test('ambiguous answers fail open and are not cached', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return n === 1 ? response('maybe later') : response('no — unrelated');
  });
  const cache = createMemoryCache();
  const opts = { model: 'm', cache, apiKey: 'k', callLlm: mock.fn, retryBaseMs: 0 };
  const first = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', opts);
  const second = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', opts);
  assert.equal(n, 2);
  assert.equal(first.decisions[0].decision, 'yes');
  assert.equal(first.decisions[0].error, null);
  assert.match(first.decisions[0].reason, /malformed/);
  assert.equal(first.decisions[0].failedOpen, true);
  assert.equal(first.failedOpen, 1);
  assert.equal(second.decisions[0].decision, 'no');
  assert.equal(second.decisions[0].cached, false);
});

test('a stored fallback is not reused', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return response('no');
  });
  const cache = new RelevanceCache();
  const body = 'v = 1\n';
  const key = await RelevanceCache.makeKey({
    model: 'm', intent: 'task', path: 'a.py', content: body,
  });
  await cache.put(key, {
    decision: 'yes',
    reason: 'malformed answer; included by default: maybe',
    error: null,
    tokens: 4,
  });
  const result = await filterRelevant({ 'a.py': body }, 'task', {
    model: 'm', cache, apiKey: 'k', callLlm: mock.fn,
  });
  assert.equal(n, 1);
  assert.equal(result.decisions[0].decision, 'no');
  assert.equal(result.decisions[0].cached, false);
});

test('cache keys hash when global crypto is missing (Node 18)', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    const body = 'v = 1\n';
    const key = await RelevanceCache.makeKey({
      model: 'm', intent: 'task', path: 'a.py', content: body,
    });
    assert.match(key, /^[0-9a-f]{64}$/);
    const again = await RelevanceCache.makeKey({
      model: 'm', intent: 'task', path: 'other.py', content: body,
    });
    assert.notEqual(key, again);
    const mock = llm(() => response('yes'));
    const result = await filterRelevant({ 'a.py': body }, 'task', {
      model: 'm', cache: false, apiKey: 'k', callLlm: mock.fn,
    });
    assert.equal(result.decisions[0].decision, 'yes');
    assert.equal(result.decisions[0].error, null);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});

test('the output-token limit is part of the cache key', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return response('yes');
  });
  const cache = new RelevanceCache();
  const files = { 'a.py': 'v = 1\n' };
  const opts = { model: 'm', cache, apiKey: 'k', callLlm: mock.fn };
  await filterRelevant(files, 'task', { ...opts, maxOutputTokens: 128 });
  await filterRelevant(files, 'task', { ...opts, maxOutputTokens: 2048 });
  assert.equal(n, 2);
  await filterRelevant(files, 'task', { ...opts, maxOutputTokens: 128 });
  assert.equal(n, 2);
});

test('transient 503 and timeouts are retried with backoff', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    if (n < 3) return statusError(503);
    return response('no');
  });
  const result = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', {
    ...baseOpts, callLlm: mock.fn, retryBaseMs: 0,
  });
  assert.equal(n, 3);
  assert.equal(result.decisions[0].decision, 'no');
  assert.equal(result.decisions[0].error, null);
  assert.equal(result.failedOpen, 0);

  let timeouts = 0;
  const timed = llm(() => {
    timeouts += 1;
    if (timeouts === 1) {
      const err = new Error('request timed out');
      err.name = 'TimeoutError';
      return err;
    }
    return response('yes');
  });
  const afterTimeout = await filterRelevant({ 'a.py': 'v = 2\n' }, 'task', {
    ...baseOpts, callLlm: timed.fn, retryBaseMs: 0,
  });
  assert.equal(timeouts, 2);
  assert.equal(afterTimeout.decisions[0].decision, 'yes');
  assert.equal(afterTimeout.decisions[0].error, null);
});

test('a non-transient error is not retried and still fails open', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return new Error('connection reset');
  });
  const result = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', {
    ...baseOpts, callLlm: mock.fn, retries: 4, retryBaseMs: 0,
  });
  assert.equal(n, 1);
  assert.equal(result.decisions[0].decision, 'yes');
  assert.match(result.decisions[0].error, /connection reset/);
  assert.equal(result.failedOpen, 1);
  assert.equal(result.files['a.py'], 'v = 1\n');
});

test('truncateUtf8 cuts éX at 2 bytes without U+FFFD', async () => {
  const seen = [];
  const mock = llm((req) => {
    seen.push(bodyOf(req));
    return response('yes');
  });
  const cases = [
    ['éX', 2, 'é'],
    ['€X', 2, ''],
    ['😀X', 3, ''],
    ['a€b', 4, 'a€'],
  ];
  for (const [text, maxBytes, expected] of cases) {
    await filterRelevant({ 'a.py': text }, 'task', {
      ...baseOpts, maxBytes, maxTokens: null, onOversize: 'truncate', callLlm: mock.fn,
    });
    assert.equal(seen.at(-1), expected);
    assert.equal(seen.at(-1).includes('\uFFFD'), false);
  }
});

test('isBinaryContent tolerates a multibyte character cut at byte 8192', () => {
  function sample(pad, tail) {
    const bytes = new Uint8Array(pad + tail.length);
    bytes.fill(0x61, 0, pad);
    bytes.set(tail, pad);
    return bytes;
  }
  assert.equal(isBinaryContent(sample(8191, [0xc3])), false);
  assert.equal(isBinaryContent(sample(8190, [0xe2, 0x82])), false);
  assert.equal(isBinaryContent(sample(8189, [0xf0, 0x9f, 0x98])), false);
  assert.equal(isBinaryContent(sample(8191, [0xff])), true);
  assert.equal(isBinaryContent(Uint8Array.from([0x68, 0x69, 0x00])), true);
  const valid = new Uint8Array(8192);
  valid.fill(0x61);
  assert.equal(isBinaryContent(valid), false);
});

test('a 4xx that names reasoning_effort is retried once without it', async () => {
  const efforts = [];
  const wrapped = async (req) => {
    efforts.push(req.reasoningEffort ?? null);
    if (efforts.length === 1) {
      const err = new Error('LLM request failed (400) from example: invalid reasoning_effort');
      err.status = 400;
      throw err;
    }
    return response('no');
  };
  const result = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', {
    ...baseOpts, callLlm: wrapped, retryBaseMs: 0, retries: 0,
  });
  assert.deepEqual(efforts, ['low', null]);
  assert.equal(result.decisions[0].decision, 'no');
  assert.equal(result.decisions[0].failedOpen, false);
  assert.equal(result.failedOpen, 0);
});

test('billing reservation errors are retried then fail open', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return new Error('billing reservation failed');
  });
  const result = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', {
    ...baseOpts, callLlm: mock.fn, retries: 2, retryBaseMs: 0,
  });
  assert.equal(n, 3);
  assert.equal(result.decisions[0].decision, 'yes');
  assert.equal(result.decisions[0].failedOpen, true);
  assert.equal(result.failedOpen, 1);
});

test('cache read and write errors are logged and do not abort the run', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    let puts = 0;
    const cache = {
      async get() {
        throw new Error('disk read failed');
      },
      async put() {
        puts += 1;
        throw new Error('disk write failed');
      },
      async flush() {
        throw new Error('disk flush failed');
      },
    };
    const mock = llm(() => response('no'));
    const result = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', {
      model: 'm', cache, apiKey: 'k', callLlm: mock.fn,
    });
    assert.equal(result.decisions[0].decision, 'no');
    assert.equal(result.decisions[0].failedOpen, false);
    assert.equal(puts, 1);
    assert.match(warnings.join('\n'), /disk read failed/);
    assert.match(warnings.join('\n'), /disk write failed/);
    assert.match(warnings.join('\n'), /disk flush failed/);
    assert.equal('a.py' in result.files, false);
  } finally {
    console.warn = original;
  }
});

test('lockfiles and generated files are skipped unless ignore is configured', async () => {
  assert.equal(isIgnoredPath('package-lock.json', DEFAULT_IGNORE_PATTERNS), true);
  assert.equal(isIgnoredPath('app/yarn.lock', DEFAULT_IGNORE_PATTERNS), true);
  assert.equal(isIgnoredPath('src/app.js', DEFAULT_IGNORE_PATTERNS), false);
  assert.equal(isIgnoredPath('dist/app.js'), true);
  assert.equal(isIgnoredPath('web/dist/main.min.js'), true);
  assert.equal(isIgnoredPath('src/app.min.js'), true);
  assert.equal(isIgnoredPath('src/app.min.mjs'), true);
  assert.equal(isIgnoredPath('Src/Package-Lock.json'), true);
  assert.equal(isIgnoredPath('keep.py'), false);

  const seen = [];
  const mock = llm((req) => {
    seen.push(...pathsOf(req));
    return response('yes');
  });
  const files = {
    'src/app.js': 'export const n = 1;\n',
    'package-lock.json': '{ "lock": true }\n',
    'dist/app.js': 'bundled\n',
    'src/app.min.js': 'min\n',
  };
  const skipped = await filterRelevant(files, 'rename n', { ...baseOpts, callLlm: mock.fn });
  assert.deepEqual(seen, ['src/app.js']);
  assert.deepEqual(Object.keys(skipped.files), ['src/app.js']);
  const by = Object.fromEntries(skipped.decisions.map((d) => [d.path, d]));
  assert.equal(by['package-lock.json'].decision, 'no');
  assert.equal(by['package-lock.json'].skippedReason, 'ignored');
  assert.equal(by['dist/app.js'].skippedReason, 'ignored');
  assert.equal(by['src/app.min.js'].skippedReason, 'ignored');
  assert.equal(by['src/app.js'].skippedReason, null);

  seen.length = 0;
  const sent = await filterRelevant(
    { 'package-lock.json': '{}\n', 'secret.txt': 'nope\n', 'src/app.js': 'ok\n' },
    'task',
    { ...baseOpts, ignore: ['**/secret.txt'], callLlm: mock.fn },
  );
  assert.ok(seen.includes('package-lock.json'));
  assert.ok(seen.includes('src/app.js'));
  assert.equal(seen.includes('secret.txt'), false);
  assert.equal(sent.decisions.find((d) => d.path === 'secret.txt').skippedReason, 'ignored');

  seen.length = 0;
  await filterRelevant({ 'package-lock.json': '{}\n' }, 'task', {
    ...baseOpts, ignore: false, callLlm: mock.fn,
  });
  assert.deepEqual(seen, ['package-lock.json']);
});

test('callLlm sends reasoning_effort only when the filter asks for it', async () => {
  /** @type {Record<string, unknown>[]} */
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'yes' } }], usage: { total_tokens: 1 } }),
      text: async () => '',
      headers: { get: () => null },
    };
  };
  await callLlm({
    apiKey: 'k',
    baseUrl: 'https://example.test/v1',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 1024,
    temperature: 0,
    reasoningEffort: 'low',
    fetchImpl,
  });
  await callLlm({
    apiKey: 'k',
    baseUrl: 'https://example.test/v1',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
    fetchImpl,
  });
  assert.equal(bodies[0].reasoning_effort, 'low');
  assert.equal(bodies[0].max_tokens, 1024);
  assert.equal('reasoning_effort' in bodies[1], false);
});

test('a full file and a preview truncated to the same bytes do not share a cache key', async () => {
  let n = 0;
  const mock = llm(() => {
    n += 1;
    return response('yes');
  });
  const cache = new RelevanceCache();
  const opts = { model: 'm', cache, apiKey: 'k', callLlm: mock.fn, maxTokens: null };
  await filterRelevant({ 'a.txt': 'abc' }, 'edit', opts);
  await filterRelevant({ 'a.txt': 'abcXXXX' }, 'edit', {
    ...opts, maxBytes: 3, onOversize: 'truncate',
  });
  assert.equal(n, 2);
  const full = await RelevanceCache.makeKey({
    model: 'm', intent: 'edit', path: 'a.txt', content: 'abc', mode: 'full', note: '',
  });
  const truncated = await RelevanceCache.makeKey({
    model: 'm', intent: 'edit', path: 'a.txt', content: 'abc', mode: 'truncated', note: 'x',
  });
  assert.notEqual(full, truncated);
});

test('a rejected reasoning_effort is cached under the empty effort', async () => {
  const efforts = [];
  let n = 0;
  const wrapped = async (req) => {
    n += 1;
    efforts.push(req.reasoningEffort ?? null);
    if (efforts.length === 1) {
      const err = new Error('LLM request failed (400) from example: invalid reasoning_effort');
      err.status = 400;
      throw err;
    }
    return response('no');
  };
  const cache = new RelevanceCache();
  const opts = { model: 'm', cache, apiKey: 'k', callLlm: wrapped, retryBaseMs: 0, retries: 0 };
  const first = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', opts);
  assert.deepEqual(efforts, ['low', null]);
  assert.equal(first.decisions[0].decision, 'no');
  assert.equal(first.decisions[0].cached, false);
  const lowKey = await RelevanceCache.makeKey({
    model: 'm', intent: 'task', path: 'a.py', content: 'v = 1\n',
    reasoningEffort: 'low', mode: 'full', note: '',
  });
  const emptyKey = await RelevanceCache.makeKey({
    model: 'm', intent: 'task', path: 'a.py', content: 'v = 1\n',
    reasoningEffort: null, mode: 'full', note: '',
  });
  assert.equal(await cache.get(lowKey), undefined);
  assert.ok(await cache.get(emptyKey));
  const second = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', opts);
  assert.equal(second.decisions[0].cached, true);
  assert.equal(second.decisions[0].decision, 'no');
  assert.equal(n, 2);
});

test('a TypeError is not retried and does not strip reasoning_effort', async () => {
  const efforts = [];
  const wrapped = async (req) => {
    efforts.push(req.reasoningEffort ?? null);
    throw new TypeError('choices is not iterable');
  };
  const result = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', {
    ...baseOpts, callLlm: wrapped, retries: 2, retryBaseMs: 0,
  });
  assert.deepEqual(efforts, ['low']);
  assert.equal(result.decisions[0].decision, 'yes');
  assert.equal(result.decisions[0].failedOpen, true);
  assert.equal(result.failedOpen, 1);
});

test('reasoning_effort is not retried when it was not sent', async () => {
  let n = 0;
  const wrapped = async () => {
    n += 1;
    const err = new Error('LLM request failed (400) from example: invalid reasoning_effort');
    err.status = 400;
    throw err;
  };
  const result = await filterRelevant({ 'a.py': 'v = 1\n' }, 'task', {
    ...baseOpts, reasoningEffort: null, callLlm: wrapped, retries: 2, retryBaseMs: 0,
  });
  assert.equal(n, 1);
  assert.equal(result.decisions[0].failedOpen, true);
});

test('a bad response envelope fails open, stays uncached, and does not abort other files', async () => {
  let n = 0;
  const wrapped = async (req) => {
    n += 1;
    const path = pathsOf(req)[0];
    if (path === 'bad.py') return { usage: { total_tokens: 3 } };
    if (path === 'empty-choices.py') return { choices: [] };
    if (path === 'no-message.py') return { choices: [{}] };
    if (path === 'no-content.py') return { choices: [{ message: {} }] };
    if (path === 'json.py') throw new SyntaxError('Unexpected token');
    return response('no');
  };
  const cache = new RelevanceCache();
  const files = {
    'bad.py': 'a\n',
    'empty-choices.py': 'b\n',
    'no-message.py': 'c\n',
    'no-content.py': 'd\n',
    'json.py': 'e\n',
    'ok.py': 'f\n',
  };
  const result = await filterRelevant(files, 'task', {
    ...baseOpts, cache, callLlm: wrapped, retries: 2, retryBaseMs: 0,
  });
  for (const path of ['bad.py', 'empty-choices.py', 'no-message.py', 'no-content.py', 'json.py']) {
    const decision = result.decisions.find((item) => item.path === path);
    assert.equal(decision.decision, 'yes', path);
    assert.equal(decision.failedOpen, true, path);
    assert.equal(decision.cached, false, path);
    assert.equal(path in result.files, true, path);
  }
  assert.equal(result.decisions.find((item) => item.path === 'ok.py').decision, 'no');
  assert.equal(n, 6);
  const again = await filterRelevant({ 'bad.py': 'a\n' }, 'task', {
    ...baseOpts, cache, callLlm: wrapped, retries: 2, retryBaseMs: 0,
  });
  assert.equal(again.decisions[0].cached, false);
  assert.equal(n, 7);
});

test('a truncated UTF-8 tail keeps the valid prefix', async () => {
  const samples = [
    { bytes: Uint8Array.from([0x61, 0xc3]), text: 'a' },
    { bytes: Uint8Array.from([0x61, 0xe0, 0xa0]), text: 'a' },
  ];
  for (const prefix of [8192, 9000]) {
    for (const tail of [[0xc3], [0xe0, 0xa0]]) {
      const bytes = new Uint8Array(prefix + tail.length);
      bytes.fill(0x61, 0, prefix);
      bytes.set(tail, prefix);
      samples.push({ bytes, text: 'a'.repeat(prefix) });
    }
  }
  for (const sample of samples) {
    assert.equal(isBinaryContent(sample.bytes), false);
    let body = '';
    const result = await filterRelevant({ 'a.py': sample.bytes }, 'task', {
      ...baseOpts,
      callLlm: async (req) => {
        body = req.messages[1].content;
        return response('yes');
      },
    });
    assert.equal(result.decisions[0].skippedReason, null);
    assert.equal(result.files['a.py'], sample.text);
    assert.equal(body.includes(sample.text), true);
    assert.equal(body.includes('\uFFFD'), false);
  }
});

test('malformed UTF-8 tails stay binary under include, exclude, and fail-open', async () => {
  const tails = [
    [0xe0, 0x80],
    [0xed, 0xa0],
    [0xf0, 0x80],
    [0xf4, 0x90],
  ];
  for (const prefix of [1, 8192, 9000]) {
    for (const tail of tails) {
      const bytes = new Uint8Array(prefix + tail.length);
      bytes.fill(0x61, 0, prefix);
      bytes.set(tail, prefix);
      const label = `${prefix}+${Buffer.from(tail).toString('hex')}`;
      assert.equal(isBinaryContent(bytes), true, label);

      let calls = 0;
      const callLlm = async () => {
        calls += 1;
        return response('yes');
      };
      const included = await filterRelevant({ 'a.py': bytes }, 'task', {
        ...baseOpts, onBinary: 'include', callLlm,
      });
      assert.equal(calls, 0, label);
      assert.equal(included.decisions[0].decision, 'yes', label);
      assert.equal(included.decisions[0].skippedReason, 'binary', label);
      assert.equal(included.files['a.py'], bytes, label);
      assert.equal(included.files['a.py'] instanceof Uint8Array, true, label);

      const excluded = await filterRelevant({ 'a.py': bytes }, 'task', {
        ...baseOpts, onBinary: 'exclude', callLlm,
      });
      assert.equal(calls, 0, label);
      assert.equal(excluded.decisions[0].decision, 'no', label);
      assert.equal(excluded.decisions[0].skippedReason, 'binary', label);
      assert.equal('a.py' in excluded.files, false, label);

      let sent = '';
      const opened = await filterRelevant({ 'a.py': bytes }, 'task', {
        ...baseOpts,
        onBinary: 'truncate',
        retries: 0,
        retryBaseMs: 0,
        callLlm: async (req) => {
          calls += 1;
          sent = req.messages[1].content;
          throw new Error('offline');
        },
      });
      assert.equal(calls, 1, label);
      assert.equal(opened.decisions[0].failedOpen, true, label);
      assert.equal(opened.decisions[0].decision, 'yes', label);
      assert.equal(opened.files['a.py'], bytes, label);
      assert.equal(opened.files['a.py'] instanceof Uint8Array, true, label);
      assert.match(sent, /\[binary file,/, label);
      assert.equal(sent.includes(`File contents:\n${'a'.repeat(prefix)}`), false, label);
    }
  }

  for (const lead of [0xc0, 0xc1, 0xf5, 0xff]) {
    assert.equal(isBinaryContent(Uint8Array.from([0x61, lead])), true, lead.toString(16));
  }
  assert.equal(isBinaryContent(Uint8Array.from([0x61, 0xc3, 0x7f])), true);
});

test('an ignored binary file is excluded before any UTF-8 decode', async () => {
  const Original = globalThis.TextDecoder;
  let decodes = 0;
  globalThis.TextDecoder = class SpyDecoder extends Original {
    decode(...args) {
      decodes += 1;
      return super.decode(...args);
    }
  };
  try {
    const bytes = Uint8Array.from([0x61, 0xc3, 0xff, 0x00]);
    const result = await filterRelevant(
      { 'dist/app.min.js': bytes, 'src/keep.js': 'export const n = 1;\n' },
      'task',
      {
        ...baseOpts,
        callLlm: async () => response('yes'),
      },
    );
    const ignored = result.decisions.find((decision) => decision.path === 'dist/app.min.js');
    assert.equal(ignored.decision, 'no');
    assert.equal(ignored.skippedReason, 'ignored');
    assert.equal('dist/app.min.js' in result.files, false);
    assert.equal(decodes, 0);
    assert.equal(result.files['src/keep.js'], 'export const n = 1;\n');
  } finally {
    globalThis.TextDecoder = Original;
  }
});

test('8192 ASCII + 0xff + TAIL is binary and included bytes stay original', async () => {
  const bytes = new Uint8Array(8192 + 1 + 4);
  bytes.fill(0x61, 0, 8192);
  bytes[8192] = 0xff;
  bytes.set([0x54, 0x41, 0x49, 0x4c], 8193);
  assert.equal(isBinaryContent(bytes), true);
  let calls = 0;
  const callLlm = async () => {
    calls += 1;
    return response('yes');
  };
  const excluded = await filterRelevant({ 'a.py': bytes }, 'task', {
    ...baseOpts, onBinary: 'exclude', callLlm,
  });
  assert.equal(calls, 0);
  assert.equal(excluded.decisions[0].decision, 'no');
  assert.equal(excluded.decisions[0].skippedReason, 'binary');
  assert.equal('a.py' in excluded.files, false);

  const included = await filterRelevant({ 'a.py': bytes }, 'task', {
    ...baseOpts, onBinary: 'include', callLlm,
  });
  assert.equal(calls, 0);
  assert.equal(included.decisions[0].decision, 'yes');
  assert.equal(included.decisions[0].skippedReason, 'binary');
  assert.equal(included.files['a.py'], bytes);
  assert.equal(included.files['a.py'][8192], 0xff);
  assert.equal(Buffer.from(included.files['a.py'].subarray(8193)).toString('utf8'), 'TAIL');

  const straddling = new Uint8Array(8191 + 2 + 4);
  straddling.fill(0x61, 0, 8191);
  straddling.set([0xc3, 0xa9], 8191);
  straddling.set([0x54, 0x41, 0x49, 0x4c], 8193);
  assert.equal(isBinaryContent(straddling), false);
  let body = '';
  const decoded = await filterRelevant({ 'a.py': straddling }, 'task', {
    ...baseOpts,
    callLlm: async (req) => {
      body = req.messages[1].content;
      return response('yes');
    },
  });
  assert.equal(decoded.files['a.py'], `${'a'.repeat(8191)}éTAIL`);
  assert.match(body, /éTAIL/);
  assert.equal(String(decoded.files['a.py']).includes('\uFFFD'), false);
});

test('non-string message content fails open and is not cached', async () => {
  let calls = 0;
  const cache = new RelevanceCache();
  const callLlm = async () => {
    calls += 1;
    return { choices: [{ message: { content: ['no'] } }], usage: { total_tokens: 4, prompt_tokens: 0, completion_tokens: 0 } };
  };
  const opts = { ...baseOpts, cache, callLlm, retries: 2, retryBaseMs: 0 };
  const first = await filterRelevant({ 'a.py': 'x\n' }, 'task', opts);
  const second = await filterRelevant({ 'a.py': 'x\n' }, 'task', opts);
  assert.equal(first.decisions[0].decision, 'yes');
  assert.equal(first.decisions[0].failedOpen, true);
  assert.equal(first.decisions[0].cached, false);
  assert.match(first.decisions[0].error, /envelope/);
  assert.equal(first.files['a.py'], 'x\n');
  assert.equal(second.decisions[0].cached, false);
  assert.equal(second.decisions[0].failedOpen, true);
  assert.equal(calls, 2);
});

test('a leading UTF-8 BOM is preserved in decoded text', async () => {
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  let body = '';
  const result = await filterRelevant({ 'a.py': bytes }, 'task', {
    ...baseOpts,
    maxBytes: null,
    maxTokens: null,
    callLlm: async (req) => {
      body = req.messages[1].content;
      return response('yes');
    },
  });
  assert.equal(result.decisions[0].skippedReason, null);
  assert.equal(result.files['a.py'], '\uFEFFhello');
  assert.equal(result.files['a.py'].charCodeAt(0), 0xfeff);
  assert.match(body, /\uFEFFhello/);
  assert.equal(countTokens('\uFEFFhello'), 2);
  assert.equal(countTokens(result.files['a.py']), 2);
});

test('valid UTF-8 bytes are decoded and a changed buffer is a separate call', async () => {
  const seen = [];
  let n = 0;
  const mock = llm((req) => {
    n += 1;
    seen.push(bodyOf(req));
    return response('yes');
  });
  const cache = new RelevanceCache();
  const opts = { ...baseOpts, cache, callLlm: mock.fn };
  const first = await filterRelevant({ 'a.py': new TextEncoder().encode('hello') }, 'task', opts);
  assert.equal(first.files['a.py'], 'hello');
  assert.equal(first.decisions[0].skippedReason, null);
  assert.equal(seen[0], 'hello');
  const second = await filterRelevant({ 'a.py': new TextEncoder().encode('hello!') }, 'task', opts);
  assert.equal(second.files['a.py'], 'hello!');
  assert.equal(n, 2);
  const invalid = await filterRelevant({ 'a.py': Uint8Array.from([0xc3]) }, 'task', opts);
  assert.equal(invalid.decisions[0].skippedReason, 'binary');
  assert.equal(invalid.decisions[0].decision, 'no');
  assert.equal(n, 2);
  assert.equal('a.py' in invalid.files, false);
});

test('code-point truncation keeps a whole emoji, CJK run, and combining mark', async () => {
  const seen = [];
  const mock = llm((req) => {
    seen.push(bodyOf(req));
    return response('no');
  });
  const cases = [
    ['abc😀def', 'abc😀'],
    ['中文测试啊', '中文测试'],
    ['e\u0301XYZ', 'e\u0301XY'],
  ];
  for (const [text, expected] of cases) {
    await filterRelevant({ 'a.py': text }, 'task', {
      ...baseOpts, maxBytes: null, maxTokens: 1, callLlm: mock.fn,
    });
    assert.equal(seen.at(-1), expected);
    assert.equal(seen.at(-1).includes('\uFFFD'), false);
  }
  assert.equal(countTokens('abcde'), 2);
  assert.equal(countTokens('abc😀def'), 2);
  assert.equal(countTokens('中'), 1);
  assert.equal(countTokens('e\u0301'), 1);
});

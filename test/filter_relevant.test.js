import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('parseRelevanceAnswer is ambiguous when both words appear, or neither', () => {
  assert.equal(parseRelevanceAnswer("I'm not sure about this one").decision, null);
  assert.equal(parseRelevanceAnswer('yes for the helper, no for the tests').decision, null);
  assert.equal(parseRelevanceAnswer('').decision, null);
  assert.equal(parseRelevanceAnswer('nope').decision, null);
  assert.equal(parseRelevanceAnswer('The answer is no.').decision, 'no');
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
  assert.match(by['ambiguous.py'].reason, /ambiguous/);
  assert.equal(by['broken.py'].decision, 'yes');
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
  assert.equal(storedKey.split('\n').length, 6);
  assert.equal(storedKey.split('\n')[3], 'full');
  assert.equal(storedKey.split('\n')[4], String(DEFAULT_FILTER_MAX_OUTPUT_TOKENS));
  assert.equal(storedKey.split('\n')[5], String(FILTER_PROMPT_VERSION));
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

test('duplicate contents share one request', async () => {
  let n = 0;
  const mock = llm((req) => {
    n += 1;
    const paths = pathsOf(req);
    assert.ok(paths.includes('a.py') && paths.includes('b.py'));
    return response('yes', 4, 1, 5);
  });
  const result = await filterRelevant(
    { 'a.py': 'SAME', 'b.py': 'SAME' },
    'task',
    { ...baseOpts, model: 'm', callLlm: mock.fn },
  );
  assert.equal(n, 1);
  assert.equal(result.decisions[0].cached, false);
  assert.equal(result.decisions[1].cached, true);
  assert.equal(result.billedTokens, 5);
  assert.deepEqual(Object.keys(result.files).sort(), ['a.py', 'b.py']);
  assert.equal(result.files['a.py'], 'SAME');
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
  const variants = Object.keys(stored.entries).map((key) => key.split('\n')[3]);
  assert.ok(variants.includes('truncated:None:20'));
  assert.ok(variants.includes('full'));
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
  assert.equal(FILTER_PROMPT_VERSION, 1);
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
  const stored = await cache.get(await RelevanceCache.makeKey('m', 'task', 'v = 1\n', 'full'));
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
  assert.match(first.decisions[0].reason, /ambiguous/);
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
  const key = await RelevanceCache.makeKey('m', 'task', body, 'full');
  await cache.put(key, {
    decision: 'yes',
    reason: 'ambiguous answer; included by default: maybe',
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
    const key = await RelevanceCache.makeKey('m', 'task', body);
    const parts = key.split('\n');
    assert.equal(parts[0], 'm');
    assert.equal(parts[1], createHash('sha256').update('task').digest('hex'));
    assert.equal(parts[2], createHash('sha256').update(body).digest('hex'));
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

test('lockfiles and generated files are skipped unless ignore is configured', async () => {
  assert.equal(isIgnoredPath('package-lock.json', DEFAULT_IGNORE_PATTERNS), true);
  assert.equal(isIgnoredPath('app/yarn.lock', DEFAULT_IGNORE_PATTERNS), true);
  assert.equal(isIgnoredPath('src/app.js', DEFAULT_IGNORE_PATTERNS), false);
  assert.equal(isIgnoredPath('dist/app.js'), true);
  assert.equal(isIgnoredPath('web/dist/main.min.js'), true);
  assert.equal(isIgnoredPath('src/app.min.js'), true);
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

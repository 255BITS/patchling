import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  filterRelevant,
  RelevanceCache,
  parseRelevanceAnswer,
  isBinaryContent,
  isIgnoredPath,
  countTokens,
  DEFAULT_IGNORE_PATTERNS,
  FILTER_PROMPT_VERSION,
  PROMPT_VERSION,
  DEFAULT_FILTER_MAX_OUTPUT_TOKENS,
  DEFAULT_FILTER_REASONING_EFFORT,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/parity/relevance.json', import.meta.url));
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));

const FIXTURE_SHA256 = 'c5f3bd4af43ff2a2036b8012c2ed69c70cd9b2c09281bc58e864fb0194eebe5c';

function lengthPrefixed(parts) {
  const chunks = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    chunks.push(Buffer.from(`${bytes.length}:`, 'utf8'));
    chunks.push(bytes);
    chunks.push(Buffer.from('\n', 'utf8'));
  }
  return Buffer.concat(chunks);
}

function oracleKey(vector) {
  const parts = [
    String(vector.prompt_version),
    String(vector.model),
    String(vector.max_output_tokens),
    vector.effort_sent == null ? '' : String(vector.effort_sent),
    String(vector.task),
    String(vector.path),
    String(vector.mode),
    vector.note == null ? '' : String(vector.note),
    String(vector.content),
  ];
  return createHash('sha256').update(lengthPrefixed(parts)).digest('hex');
}

function fill(template, fields) {
  return template.replace(/\{(\w+)\}/g, (_, name) => fields[name] ?? '');
}

test('parity fixture bytes match the recorded sha256', () => {
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), FIXTURE_SHA256);
});

test('parity fixture: prompt version, token estimate, and ignore list', () => {
  assert.equal(PROMPT_VERSION, fixture.promptVersion);
  assert.equal(FILTER_PROMPT_VERSION, fixture.promptVersion);
  assert.equal(DEFAULT_FILTER_MAX_OUTPUT_TOKENS, fixture.maxOutputTokens);
  assert.equal(DEFAULT_FILTER_REASONING_EFFORT, fixture.reasoningEffort);
  assert.equal(fixture.tokenEstimate.rule, 'ceil(code_points/4)');
  for (const example of fixture.tokenEstimate.examples) {
    assert.equal(countTokens(example.text), example.tokens, JSON.stringify(example.text));
  }
  assert.equal(fixture.ignore.label, 'ignored');
  assert.deepEqual(DEFAULT_IGNORE_PATTERNS, fixture.ignore.patterns);
  assert.ok(fixture.ignore.patterns.includes('**/*.min.js'));
  assert.ok(fixture.ignore.patterns.includes('**/*.min.mjs'));
  for (const example of fixture.ignore.examples) {
    assert.equal(isIgnoredPath(example.path), example.ignored, example.path);
  }
});

test('parity fixture: parser, including quoted, negated, and explanatory answers', () => {
  for (const row of fixture.parser) {
    assert.equal(parseRelevanceAnswer(row.raw).decision, row.decision, row.raw);
  }
  assert.equal(fixture.malformedIsFailedOpen, true);
});

test('parity fixture: cache key hashes mode, note, effort, and content', async () => {
  for (const vector of fixture.cacheKey.vectors) {
    assert.equal(oracleKey(vector), vector.sha256, vector.path + ' ' + vector.mode);
    const key = await RelevanceCache.makeKey({
      model: vector.model,
      task: vector.task,
      path: vector.path,
      content: vector.content,
      mode: vector.mode,
      note: vector.note,
      maxOutputTokens: Number(vector.max_output_tokens),
      reasoningEffort: vector.effort_sent === '' ? null : vector.effort_sent,
      promptVersion: Number(vector.prompt_version),
    });
    assert.equal(key, vector.sha256);
  }
  const full = fixture.cacheKey.vectors.find((vector) => vector.mode === 'full' && vector.content === 'abc');
  const truncated = fixture.cacheKey.vectors.find((vector) => vector.mode === 'truncated' && vector.content === 'abc');
  assert.notEqual(full.sha256, truncated.sha256);
  assert.notEqual(fixture.cacheKey.vectors[0].sha256, fixture.cacheKey.vectors[1].sha256);
});

test('parity fixture: prompt text is task, path, and content', async () => {
  let user = '';
  let system = '';
  await filterRelevant({ 'src/target.py': '' }, 'edit the target', {
    model: 'm',
    cache: false,
    apiKey: 'k',
    callLlm: async (req) => {
      system = req.messages[0].content;
      user = req.messages[1].content;
      return { choices: [{ message: { content: 'yes' } }], usage: {} };
    },
  });
  assert.equal(system, fixture.systemPrompt);
  assert.equal(user, fill(fixture.userPrompt.withoutNote, {
    task: 'edit the target',
    path: 'src/target.py',
    content: '',
  }));
});

test('parity fixture: truncation never emits U+FFFD and keeps code points', async () => {
  for (const row of fixture.truncation) {
    let body = null;
    await filterRelevant({ 'a.py': row.text }, 'task', {
      model: 'm',
      cache: false,
      apiKey: 'k',
      maxBytes: row.maxBytes,
      maxTokens: null,
      onOversize: 'truncate',
      callLlm: async (req) => {
        body = req.messages[1].content.split('File contents:\n')[1]
          .replace(/\n\nIs this file relevant to the task\? yes\/no$/, '');
        return { choices: [{ message: { content: 'no' } }], usage: {} };
      },
    });
    assert.equal(body, row.expected, row.text);
    assert.equal(String(body).includes('\uFFFD'), false);
  }
  for (const row of fixture.tokenTruncation) {
    let body = null;
    await filterRelevant({ 'a.py': row.text }, 'task', {
      model: 'm',
      cache: false,
      apiKey: 'k',
      maxBytes: null,
      maxTokens: row.maxTokens,
      onOversize: 'truncate',
      callLlm: async (req) => {
        body = req.messages[1].content.split('File contents:\n')[1]
          .replace(/\n\nIs this file relevant to the task\? yes\/no$/, '');
        return { choices: [{ message: { content: 'no' } }], usage: {} };
      },
    });
    assert.equal(body, row.expected, row.text);
    assert.equal(String(body).includes('\uFFFD'), false);
  }
});

test('parity fixture: binary detection tolerates only a short trailing sequence', () => {
  for (const row of fixture.binary.cases) {
    const bytes = new Uint8Array(row.pad + row.tail.length);
    bytes.fill(0x61, 0, row.pad);
    bytes.set(row.tail, row.pad);
    assert.equal(isBinaryContent(bytes), row.binary, row.name);
  }
  const kept = fixture.binary.cases.find((row) => row.text != null);
  assert.equal(kept.name, 'truncated tail keeps prefix');
  assert.equal(kept.binary, false);
  assert.equal(kept.text, 'a');
  const late = fixture.binary.cases.find((row) => row.name === '8192 ASCII + 0xff + TAIL');
  assert.ok(late);
  assert.equal(late.binary, true);
});

test('parity fixture: a leading UTF-8 BOM is preserved', async () => {
  assert.equal(countTokens(fixture.bom.text), fixture.bom.tokens);
  assert.equal(fixture.bom.text.charCodeAt(0), 0xfeff);
  assert.equal(fixture.bom.truncated, '\uFEFFhel');
  const bytes = Uint8Array.from(fixture.bom.bytes);
  let body = '';
  const result = await filterRelevant({ 'bom.txt': bytes }, 'edit', {
    model: 'm',
    cache: false,
    apiKey: 'k',
    maxBytes: null,
    maxTokens: null,
    callLlm: async (req) => {
      body = req.messages[1].content;
      return { choices: [{ message: { content: 'yes' } }], usage: {} };
    },
  });
  assert.equal(result.files['bom.txt'], fixture.bom.text);
  assert.equal(result.files['bom.txt'].charCodeAt(0), 0xfeff);
  assert.match(body, new RegExp(fixture.bom.text));
  const truncated = await filterRelevant({ 'bom.txt': fixture.bom.text }, 'edit', {
    model: 'm',
    cache: false,
    apiKey: 'k',
    maxBytes: null,
    maxTokens: fixture.bom.maxTokens,
    onOversize: 'truncate',
    callLlm: async (req) => {
      body = req.messages[1].content.split('File contents:\n')[1]
        .replace(/\n\nIs this file relevant to the task\? yes\/no$/, '');
      return { choices: [{ message: { content: 'no' } }], usage: {} };
    },
  });
  assert.equal(body, fixture.bom.truncated);
  assert.equal(truncated.decisions[0].skippedReason, 'truncated');
  const vector = fixture.cacheKey.vectors.find((row) => row.path === 'bom.txt');
  assert.equal(vector.content, fixture.bom.text);
});

test('parity fixture: valid UTF-8 bytes stay text and changed bytes miss the cache', async () => {
  const seen = [];
  let n = 0;
  const cache = new RelevanceCache();
  const callLlm = async (req) => {
    n += 1;
    seen.push(req.messages[1].content);
    return { choices: [{ message: { content: 'yes' } }], usage: {} };
  };
  const opts = { model: 'm', cache, apiKey: 'k', callLlm, maxBytes: null, maxTokens: null };
  const encoded = new TextEncoder().encode(fixture.bytes.validUtf8);
  const first = await filterRelevant({ 'a.py': encoded }, 'task', opts);
  assert.equal(first.files['a.py'], fixture.bytes.validUtf8);
  assert.notEqual(first.files['a.py'], '');
  assert.equal(first.decisions[0].skippedReason, null);
  assert.match(seen[0], new RegExp(fixture.bytes.validUtf8));

  const [left, right] = fixture.bytes.changed;
  await filterRelevant({ 'a.py': new TextEncoder().encode(left) }, 'task', opts);
  await filterRelevant({ 'a.py': new TextEncoder().encode(right) }, 'task', opts);
  assert.equal(n, 3);

  const invalid = await filterRelevant(
    { 'a.py': Uint8Array.from([0xff]) },
    'task',
    opts,
  );
  assert.equal(invalid.decisions[0].skippedReason, 'binary');
  assert.equal(invalid.decisions[0].decision, 'no');
  assert.equal(n, 3);
});

test('parity fixture: an ignored minified module is labeled ignored', async () => {
  let n = 0;
  const result = await filterRelevant(
    { 'src/app.min.mjs': 'var a=1;\n', 'src/app.js': 'export const a = 1;\n' },
    'task',
    {
      model: 'm',
      cache: false,
      apiKey: 'k',
      callLlm: async () => {
        n += 1;
        return { choices: [{ message: { content: 'yes' } }], usage: {} };
      },
    },
  );
  const skipped = result.decisions.find((decision) => decision.path === 'src/app.min.mjs');
  assert.equal(skipped.decision, 'no');
  assert.equal(skipped.skippedReason, fixture.ignore.label);
  assert.equal(n, 1);
});

test('parity fixture: a negated no fails open and is not cached', async () => {
  let n = 0;
  const cache = new RelevanceCache();
  const callLlm = async () => {
    n += 1;
    return {
      choices: [{ message: { content: 'There is no doubt this file is required' } }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    };
  };
  const opts = { model: 'm', cache, apiKey: 'k', callLlm };
  const first = await filterRelevant({ 'src/target.py': 'x = 1\n' }, 'edit the target', opts);
  const second = await filterRelevant({ 'src/target.py': 'x = 1\n' }, 'edit the target', opts);
  assert.equal(n, 2);
  assert.equal(first.decisions[0].decision, 'yes');
  assert.equal(first.decisions[0].failedOpen, true);
  assert.equal(first.failedOpen, 1);
  assert.equal(second.decisions[0].cached, false);
  assert.equal(fixture.malformedIsFailedOpen, true);
});

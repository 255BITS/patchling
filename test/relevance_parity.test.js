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

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/parity/relevance.json', import.meta.url)),
  'utf8',
));

function lengthPrefixed(parts) {
  const chunks = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    chunks.push(Buffer.from(`${bytes.length}\n`, 'utf8'));
    chunks.push(bytes);
    chunks.push(Buffer.from('\n', 'utf8'));
  }
  return Buffer.concat(chunks);
}

function oracleKey(vector) {
  const parts = [
    String(vector.promptVersion),
    String(vector.model),
    String(vector.tokenLimit),
    vector.effort == null ? '' : String(vector.effort),
    String(vector.intent),
    String(vector.path),
    String(vector.content),
  ];
  return createHash('sha256').update(lengthPrefixed(parts)).digest('hex');
}

function fill(template, fields) {
  return template.replace(/\{(\w+)\}/g, (_, name) => fields[name] ?? '');
}

test('parity fixture: prompt version, token estimate, and ignore list', () => {
  assert.equal(PROMPT_VERSION, fixture.promptVersion);
  assert.equal(FILTER_PROMPT_VERSION, fixture.promptVersion);
  assert.equal(DEFAULT_FILTER_MAX_OUTPUT_TOKENS, fixture.maxOutputTokens);
  assert.equal(DEFAULT_FILTER_REASONING_EFFORT, fixture.reasoningEffort);
  for (const example of fixture.tokenEstimate.examples) {
    assert.equal(countTokens(example.text), example.tokens);
  }
  assert.deepEqual(DEFAULT_IGNORE_PATTERNS, fixture.ignore.patterns);
  for (const example of fixture.ignore.examples) {
    assert.equal(isIgnoredPath(example.path), example.ignored);
  }
});

test('parity fixture: parser, including quoted, negated, and explanatory answers', () => {
  for (const row of fixture.parser) {
    assert.equal(parseRelevanceAnswer(row.raw).decision, row.decision, row.raw);
  }
  assert.equal(fixture.malformedIsFailedOpen, true);
});

test('parity fixture: cache key hashes path, effort, and truncated content', async () => {
  for (const vector of fixture.cacheKey.vectors) {
    assert.equal(oracleKey(vector), vector.sha256, vector.path);
    const key = await RelevanceCache.makeKey({
      model: vector.model,
      intent: vector.intent,
      path: vector.path,
      content: vector.content,
      maxOutputTokens: Number(vector.tokenLimit),
      reasoningEffort: vector.effort === '' ? null : vector.effort,
      promptVersion: Number(vector.promptVersion),
    });
    assert.equal(key, vector.sha256);
  }
  assert.notEqual(fixture.cacheKey.vectors[0].sha256, fixture.cacheKey.vectors[1].sha256);
});

test('parity fixture: prompt text is path, intent, and content', async () => {
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
    intent: 'edit the target',
    path: 'src/target.py',
    content: '',
  }));
});

test('parity fixture: truncation never emits U+FFFD', async () => {
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
});

test('parity fixture: binary detection tolerates only a short trailing sequence', () => {
  for (const row of fixture.binary.cases) {
    const bytes = new Uint8Array(row.pad + row.tail.length);
    bytes.fill(0x61, 0, row.pad);
    bytes.set(row.tail, row.pad);
    assert.equal(isBinaryContent(bytes), row.binary, row.name);
  }
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

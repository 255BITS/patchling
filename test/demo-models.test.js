import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { callLlm, filterRelevant, DEFAULT_FILTER_MODEL } from '../src/index.js';

// Public catalog snapshot: tests never query a provider or spend inference credits.
const catalog = JSON.parse(readFileSync(new URL('./fixtures/demo-models.json', import.meta.url)));
const landing = readFileSync(new URL('../landing/index.html', import.meta.url), 'utf8');
const root = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const declaration = (html, name) => html.match(new RegExp(`const ${name} = [^;]+;`))[0];
const defaults = runInNewContext([
  declaration(landing, 'DEFAULT_MODEL'), declaration(landing, 'APPLY_MODEL'),
  declaration(landing, 'PINNED'), '({ DEFAULT_MODEL, APPLY_MODEL, PINNED })',
].join('\n'));

test('browser defaults and pinned choices are callable, inexpensive text models', () => {
  const rootDefault = runInNewContext(`${declaration(root, 'DEFAULT_MODEL')} DEFAULT_MODEL`);
  assert.equal(root.match(/id="model" value="([^"]+)"/)[1], rootDefault);
  assert.equal(rootDefault, defaults.DEFAULT_MODEL);
  assert.equal(defaults.APPLY_MODEL, defaults.DEFAULT_MODEL);
  assert.equal(new Set(defaults.PINNED).size, defaults.PINNED.length);
  for (const id of [rootDefault, defaults.APPLY_MODEL, DEFAULT_FILTER_MODEL, ...defaults.PINNED]) {
    const model = catalog.text[id];
    assert.ok(model, `missing from verified NanoGPT catalog: ${id}`);
    assert.ok(model.architecture.output_modalities.includes('text'));
    assert.ok(model.pricing.prompt <= 0.5 && model.pricing.completion <= 1);
  }
});

test('previous factory picks migrate, custom saved choices survive', () => {
  const restore = landing.slice(landing.indexOf('const savedModel ='), landing.indexOf('/* ---------- model picker'));
  for (const saved of [null, 'zai-org/glm-5.2:thinking', 'xiaomi/mimo-v2.5-pro-ultraspeed', 'my/custom-model']) {
    const model = runInNewContext(`${declaration(landing, 'DEFAULT_MODEL')}\n${restore}\nMODEL`, {
      localStorage: { getItem: () => saved },
    });
    assert.equal(model, saved === 'my/custom-model' ? saved : defaults.DEFAULT_MODEL);
  }
});

test('landing picker retains creation dates and ranks the newer flagship first', async () => {
  const picker = landing.slice(landing.indexOf('let allModels ='), landing.indexOf('function modelButton'));
  const api = runInNewContext(`${picker}\n({ loadModels })`, {
    DEFAULT_MODEL: defaults.DEFAULT_MODEL, MODEL: defaults.DEFAULT_MODEL,
    localStorage: { setItem() {} }, $: () => ({}), getKey: () => null,
    renderFilterModelRow() {},
    fetch: async () => ({ json: async () => ({ data: [
      { id: 'google/gemini-3-pro', created: 20 },
      { id: 'google/gemini-2-pro', created: 10 },
    ] }) }),
  });
  const models = await api.loadModels();
  assert.equal(models[0].id, 'google/gemini-3-pro');
  assert.equal(models[0].created, 20);
});

test('landing decision call disables MiMo thinking with a supported effort', async () => {
  const collect = landing.match(/async function collectDecisions\([^]*?\n\}/)[0];
  let request;
  const api = runInNewContext(`${declaration(landing, 'decisionEffort')}\n${collect}\ncollectDecisions`, {
    mode: 'real', scenarioKey: 'sample', SCENARIOS: { sample: {} },
    DEFAULT_FILTER_MODEL, $: () => ({}), getKey: () => 'test-key',
    renderDecision() {}, isCurrentRun: () => true,
    filterRelevant: (files, goal, opts) => filterRelevant(files, goal, {
      ...opts, cache: false, callLlm: async (req) => {
        request = req;
        return { choices: [{ message: { content: 'yes' } }] };
      },
    }),
  });
  const decisions = await api({ 'a.js': 'const a = 1;' }, 'edit a', 1, DEFAULT_FILTER_MODEL);
  assert.equal(decisions[0].decision, 'yes');
  assert.equal(request.reasoningEffort, 'none');
  assert.ok(catalog.text[request.model].reasoning_efforts.includes(request.reasoningEffort));
});

test('selected demo models keep the existing chat-completions SSE contract', async () => {
  for (const model of defaults.PINNED) {
    let body;
    const chunks = [];
    const result = await callLlm({
      model, apiKey: 'test-key', messages: [{ role: 'user', content: 'edit' }],
      onToken: (token) => chunks.push(token),
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://nano-gpt.com/api/v1/chat/completions');
        body = JSON.parse(init.body);
        return new Response('data: {"choices":[{"delta":{"content":"diff"}}]}\n\ndata: [DONE]\n\n');
      },
    });
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    assert.equal(body.stream_options.include_usage, true);
    assert.equal(result.choices[0].message.content, 'diff');
    assert.deepEqual(chunks, ['diff']);
  }
});

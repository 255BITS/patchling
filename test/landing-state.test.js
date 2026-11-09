import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../landing/index.html', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function ui() {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', checked: false, style: {}, classList: { add() {} }, appendChild() {} });
    return elements.get(id);
  };
  return { $, document: { querySelector: $ } };
}
function runHarness(mode) {
  const elements = ui(), filtering = deferred(), generation = deferred(), genEntered = deferred();
  const requests = [];
  const context = {
    ...elements, mode, scenarioKey: 'sample', SCENARIOS: { sample: { files: { a: 'original' }, goal: 'recorded goal', reveal: 'recorded explanation' } },
    files: { a: 'original' }, FILTER_MODEL: 'classifier', MODEL: 'initial-diff', APPLY_MODEL: 'initial-apply',
    beginRun: () => 1, isCurrentRun: () => true, priceOf: () => null, renderRun() {},
    renderEditors() {}, renderPreview() {}, getKey: () => 'test-key',
    collectDecisions: async () => { await filtering.promise; return []; },
    makeFakeCallLlm: () => async () => {}, makeFakeApply: () => async () => {},
    callLlm: async () => {},
    callLlmForApply: (_path, _original, _patch, _model, opts) => { requests.push(['strict-apply', opts.callLlm]); },
    generateDiff: async (_env, _goal, opts) => { requests.push(['generate', opts]); genEntered.resolve(); await generation.promise; return 'diff'; },
    smartapply: async (_diff, _files, opts) => { requests.push(['apply', opts]); return { a: 'updated' }; },
    buildEnvironment: (files) => files, filesForDiff: (files) => files,
    renderDiff() {}, parseDiffPerFile: () => [['a', 'diff']],
    fileCard: () => ({ ...elements.$('card'), querySelector: elements.$ }),
    renderVerdict: (...args) => { requests.push(['verdict', args[6]]); },
    formatClassifierCost: () => '', setBadge() {}, resultMsg(message) { throw new Error(message); },
  };
  elements.$('goal').value = 'custom goal'; elements.$('filteron').checked = true;
  const runBody = html.match(/async function run\(\) \{[^]*?\n\}/)[0];
  const setMode = html.match(/function setMode\(m\) \{[^]*?\n\}/)[0];
  const api = runInNewContext(`${setMode}\n${runBody}\n({ run, setMode })`, context);
  return { context, elements, api, filtering, generation, genEntered, requests };
}

for (const mode of ['real', 'demo']) {
  test(`${mode} run keeps its original mode and models across filtering/generation`, async () => {
    const h = runHarness(mode), pending = h.api.run();
    h.api.setMode(mode === 'real' ? 'demo' : 'real');
    h.context.MODEL = 'later-diff'; h.context.APPLY_MODEL = 'later-apply';
    h.filtering.resolve(); await h.genEntered.promise;
    h.api.setMode(mode); h.generation.resolve(); await pending;
    const gen = h.requests.find(([kind]) => kind === 'generate')[1];
    const apply = h.requests.find(([kind]) => kind === 'apply')[1];
    if (mode === 'real') {
      assert.equal(gen.apiKey, 'test-key'); assert.equal(gen.model, 'initial-diff');
      assert.equal(apply.apiKey, 'test-key'); assert.equal(apply.model, 'initial-apply');
      assert.equal(gen.callLlm, h.context.callLlm);
      apply.callLlmForApply('a', 'original', 'diff', 'initial-apply', {});
      assert.equal(h.requests.find(([kind]) => kind === 'strict-apply')[1], h.context.callLlm);
    } else {
      assert.equal(typeof gen.callLlm, 'function'); assert.equal(typeof apply.callLlmForApply, 'function');
      assert.equal(gen.apiKey, undefined); assert.equal(apply.apiKey, undefined);
    }
    assert.equal(h.requests.find(([kind]) => kind === 'verdict')[1], mode);
    assert.equal(h.context.files.a, 'updated');
  });
}

function picker(fetch) {
  const elements = ui(); let key = '';
  const block = html.slice(html.indexOf('let allModels ='), html.indexOf('function modelButton'));
  const api = runInNewContext(`${block}\n({ loadModels, invalidateModels })`, {
    ...elements, DEFAULT_MODEL: 'fallback', MODEL: 'fallback',
    localStorage: { setItem() {} }, getKey: () => key, renderFilterModelRow() {}, fetch,
  });
  return { ...api, ...elements, setKey: (value) => { key = value; api.invalidateModels(); } };
}
const catalog = (id) => ({ ok: true, json: async () => ({ data: [{ id }] }) });

for (const failure of ['offline', 'http', 'empty']) {
  test(`catalog recovers on the next request after ${failure}`, async () => {
    let requests = 0;
    const api = picker(async () => {
      requests += 1;
      if (requests > 1) return catalog('recovered');
      if (failure === 'offline') throw new Error('offline');
      if (failure === 'http') return { ok: false };
      return { ok: true, json: async () => ({ data: [] }) };
    });
    assert.equal((await api.loadModels())[0].id, 'fallback');
    assert.equal((await api.loadModels())[0].id, 'recovered');
    await api.loadModels(); assert.equal(requests, 2);
  });
}

test('concurrent opens share a request, and a late old-account result cannot replace a new one', async () => {
  const first = deferred(); let requests = 0;
  const api = picker(async () => { requests += 1; return requests === 1 ? first.promise : catalog('new-account'); });
  const old = api.loadModels(), duplicate = api.loadModels();
  assert.equal(requests, 1);
  for (const prefix of ['model', 'filtermodel']) {
    api.$(prefix + 'picker').style.display = 'block';
    api.$(prefix + 'list').innerHTML = 'old-account buttons';
    api.$(prefix + 'count').textContent = 'old count';
  }
  api.setKey('new-key');
  for (const prefix of ['model', 'filtermodel']) {
    assert.equal(api.$(prefix + 'picker').style.display, 'none');
    assert.equal(api.$(prefix + 'list').innerHTML, '');
    assert.equal(api.$(prefix + 'count').textContent, '');
  }
  assert.equal((await api.loadModels())[0].id, 'new-account');
  first.resolve(catalog('old-account')); await Promise.all([old, duplicate]);
  assert.equal((await api.loadModels())[0].id, 'new-account');
  assert.equal(requests, 2);
});

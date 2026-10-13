import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateDiff, smartapply, buildEnvironment } from '../src/index.js';

const html = readFileSync(new URL('../landing/index.html', import.meta.url), 'utf8');

function helpers() {
  const start = html.indexOf('/* PLAYGROUND_HELPERS:START */');
  const end = html.indexOf('/* PLAYGROUND_HELPERS:END */');
  assert.ok(start >= 0 && end > start);
  const block = html.slice(start, end);
  return new Function(`${block}\nreturn { beginRun, isCurrentRun, invalidateRun, classifierTokens, classifierCost, formatClassifierCost };`)();
}

test('a newer playground run supersedes an older one', () => {
  const api = helpers();
  const first = api.beginRun();
  const second = api.beginRun();
  assert.equal(api.isCurrentRun(first), false);
  assert.equal(api.isCurrentRun(second), true);
  assert.equal(api.isCurrentRun(first), false);
});

test('classifier cost is the sum of decision tokens, priced when the split is known', () => {
  const api = helpers();
  const canned = [
    { tokens: 48 },
    { tokens: 41 },
    { tokens: 0 },
  ];
  assert.equal(api.classifierTokens(canned), 89);
  assert.equal(api.formatClassifierCost(canned, null), 'classifier 89 tokens · cost unknown');
  assert.equal(api.classifierCost(canned, { prompt: 1, completion: 1 }).dollars, null);
  const live = [
    { tokens: 14, promptTokens: 11, completionTokens: 3 },
    { tokens: 6, promptTokens: 5, completionTokens: 1 },
  ];
  const cost = api.classifierCost(live, { prompt: 0.1, completion: 0.4 });
  assert.equal(cost.tokens, 20);
  assert.equal(cost.unknown, false);
  assert.equal(cost.dollars, (16 * 0.1 + 4 * 0.4) / 1000000);
  assert.match(api.formatClassifierCost(live, { prompt: 0.1, completion: 0.4 }), /classifier 20 tokens · \$/);
});

test('usage with only total_tokens is cost unknown, never $0', () => {
  const api = helpers();
  const price = { prompt: 0.1, completion: 0.4 };
  const totalOnly = [{ tokens: 20, promptTokens: 0, completionTokens: 0 }];
  const cost = api.classifierCost(totalOnly, price);
  assert.equal(cost.tokens, 20);
  assert.equal(cost.unknown, true);
  assert.equal(cost.dollars, null);
  assert.deepEqual(cost.usage, [{ tokens: 20, promptTokens: 0, completionTokens: 0 }]);
  const text = api.formatClassifierCost(totalOnly, price);
  assert.equal(text, 'classifier 20 tokens · cost unknown');
  assert.equal(text.includes('$0'), false);
});

test('changing the scenario or editor invalidates an in-flight playground run', () => {
  const api = helpers();
  const runId = api.beginRun();
  assert.equal(api.isCurrentRun(runId), true);
  api.invalidateRun();
  assert.equal(api.isCurrentRun(runId), false);
  const later = api.beginRun();
  assert.equal(api.isCurrentRun(runId), false);
  assert.equal(api.isCurrentRun(later), true);

  const select = html.slice(html.indexOf('function selectScenario'), html.indexOf('function renderSampleSelection'));
  assert.match(select, /invalidateRun\(\)/);
  const editors = html.slice(html.indexOf('function renderEditors'), html.indexOf('function renderPreview'));
  assert.match(editors, /addEventListener\("input", \(\) => \{[\s\S]*invalidateRun\(\)/);
  const runBody = html.slice(html.indexOf('async function run'), html.indexOf('function filesForDiff'));
  const assignAt = runBody.indexOf('files = { ...updated }');
  assert.ok(assignAt > 0);
  const guardAt = runBody.lastIndexOf('if (!isCurrentRun(runId)) return;', assignAt);
  assert.ok(guardAt > 0);
});

test('a playground run snapshots classifier model and rates', () => {
  const runBody = html.slice(html.indexOf('async function run'), html.indexOf('function filesForDiff'));
  assert.match(runBody, /const runModel = FILTER_MODEL;/);
  assert.match(runBody, /const runPrice = priceOf\(runModel\);/);
  assert.equal(runBody.includes('priceOf(FILTER_MODEL)'), false);
  assert.match(runBody, /formatClassifierCost\(decisions, runPrice\)/);
  assert.match(runBody, /collectDecisions\(inputFiles, goal, runId, runModel\)/);
  const collectAt = html.indexOf('async function collectDecisions');
  const collect = html.slice(collectAt, html.indexOf('for (const btn of document.querySelectorAll("[data-sample]")', collectAt));
  assert.match(collect, /model: runModel/);
  assert.equal(collect.includes('FILTER_MODEL'), false);
});

test('the playground does not skip an empty context and applies onto the original map', () => {
  assert.equal(html.includes('No file was marked relevant, so generateDiff did not run.'), false);
  assert.match(html, /generateDiff\(buildEnvironment\(filesForDiff\(inputFiles, decisions\)\)/);
  assert.match(html, /smartapply\(diff, inputFiles, applyOpts\)/);
  assert.match(html, /if \(!isCurrentRun\(runId\)\) return;/);
  const logo = html.match(/"assets\/logo\.bin": "([^"]+)"/);
  assert.ok(logo);
  assert.ok(logo[1].split('\\u0000').length >= 3, logo[1]);
});

test('an empty relevance context still applies a new file onto the full original map', async () => {
  const original = {
    'keep.txt': 'untouched\n',
    'other.txt': 'also\n',
  };
  let sawKeep = false;
  const diff = await generateDiff(buildEnvironment({}), 'add a note', {
    callLlm: async (req) => {
      const blob = req.messages.map((message) => message.content).join('\n');
      if (blob.includes('keep.txt')) sawKeep = true;
      return {
        choices: [{
          message: {
            content: [
              '```diff',
              'diff --git a/note.txt b/note.txt',
              'new file mode 100644',
              '--- /dev/null',
              '+++ b/note.txt',
              '@@ -0,0 +1 @@',
              '+hello',
              '```',
            ].join('\n'),
          },
        }],
      };
    },
  });
  assert.equal(sawKeep, false);
  const updated = await smartapply(diff, original, {
    callLlmForApply: async () => {
      throw new Error('the new file should apply without a model');
    },
  });
  assert.equal(updated['keep.txt'], 'untouched\n');
  assert.equal(updated['other.txt'], 'also\n');
  assert.match(updated['note.txt'], /^hello\n?$/);
});

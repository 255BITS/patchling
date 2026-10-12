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
  return new Function(`${block}\nreturn { beginRun, isCurrentRun, classifierTokens, classifierCost, formatClassifierCost };`)();
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
  assert.equal(api.formatClassifierCost(canned, null), 'classifier 89 tokens');
  const live = [
    { tokens: 14, promptTokens: 11, completionTokens: 3 },
    { tokens: 6, promptTokens: 5, completionTokens: 1 },
  ];
  const cost = api.classifierCost(live, { prompt: 0.1, completion: 0.4 });
  assert.equal(cost.tokens, 20);
  assert.equal(cost.dollars, (16 * 0.1 + 4 * 0.4) / 1000000);
  assert.match(api.formatClassifierCost(live, { prompt: 0.1, completion: 0.4 }), /classifier 20 tokens · \$/);
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

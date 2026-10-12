/**
 * Mocked-LLM coverage for the NanoGPT smartapply cases, plus the
 * wrong-context safeguard: a model that copies stale context or drops lines
 * the diff did not remove must not win.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { smartapply, applyDiff, callLlmForApply } from '../src/index.js';
import { gradeSmartapplyCase } from './grade-smartapply-case.js';

const cases = JSON.parse(
  readFileSync(new URL('./fixtures/smartapply-live-cases.json', import.meta.url), 'utf8'),
);

/**
 * The failure mode: emit the hunk's context and '+' lines and drop every
 * original line the hunk does not restate.
 *
 * @param {string} fileDiff
 * @returns {string}
 */
function corruptApply(fileDiff) {
  const out = [];
  let inHunk = false;
  for (const line of fileDiff.split('\n')) {
    if (line.replace(/^\s+/, '').startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) out.push(line.slice(1));
    else if (line.startsWith('-')) continue;
    else if (line.startsWith(' ')) out.push(line.slice(1));
    else out.push(line);
  }
  return out.join('\n');
}

test('mocked LLM: harness cases stay correct even when the model copies bad context', async () => {
  const needsLlm = new Set(['sloppy_wrong_context', 'sloppy_ellipsis']);
  for (const c of cases) {
    let calls = 0;
    const mock = async (_path, _original, fileDiff) => {
      calls += 1;
      return corruptApply(fileDiff);
    };
    const result = await smartapply(c.diff, c.files, { callLlmForApply: mock });
    const why = gradeSmartapplyCase(result, c);
    assert.equal(why, '', `${c.id}: ${why}\n${JSON.stringify(result)}`);
    if (needsLlm.has(c.id)) assert.ok(calls > 0, `${c.id} should reach the LLM`);
    else assert.equal(calls, 0, `${c.id} should stay on the deterministic path`);
  }
});

test('wrong context: stale lines are not copied and unrelated lines stay', async () => {
  const c = cases.find((item) => item.id === 'sloppy_wrong_context');
  const original = c.files['cfg.py'];
  const corrupt = "TIMEOUT=30\nRETRIES = 5\nDEBUG = false\n";
  const result = await smartapply(c.diff, { 'cfg.py': original }, {
    callLlmForApply: async () => corrupt,
  });
  const got = result['cfg.py'];
  assert.ok(got.includes('RETRIES = 5'));
  assert.ok(!got.includes('RETRIES = 3'));
  assert.ok(got.includes('TIMEOUT = 30'));
  assert.ok(!got.includes('TIMEOUT=30'));
  assert.ok(got.includes('DEBUG = False'));
  assert.ok(!got.includes('DEBUG = false'));
  assert.ok(got.includes("NAME = 'svc'"));
  assert.equal(c.files['cfg.py'], original, 'input map is not mutated');
});

test('wrong context: a model that only drops unrelated lines is corrected', async () => {
  const c = cases.find((item) => item.id === 'sloppy_wrong_context');
  const result = await smartapply(c.diff, c.files, {
    callLlmForApply: async () => "TIMEOUT = 30\nRETRIES = 5\nDEBUG = False\n",
  });
  assert.ok(result['cfg.py'].includes("NAME = 'svc'"));
  assert.ok(result['cfg.py'].includes('DEBUG = False'));
  assert.ok(result['cfg.py'].includes('RETRIES = 5'));
  assert.ok(!result['cfg.py'].includes('RETRIES = 3'));
});

test('wrong context: echoing the original file still applies the +/- lines', async () => {
  const c = cases.find((item) => item.id === 'sloppy_wrong_context');
  const result = await smartapply(c.diff, c.files, {
    callLlmForApply: async () => c.files['cfg.py'],
  });
  assert.ok(result['cfg.py'].includes('RETRIES = 5'));
  assert.ok(result['cfg.py'].includes('TIMEOUT = 30'));
  assert.ok(result['cfg.py'].includes('DEBUG = False'));
  assert.ok(result['cfg.py'].includes("NAME = 'svc'"));
  assert.ok(!result['cfg.py'].includes('RETRIES = 3'));
});

test('wrong context: a model result that already respects +/- lines is kept', async () => {
  const c = cases.find((item) => item.id === 'sloppy_wrong_context');
  const good = "TIMEOUT = 30\nRETRIES = 5\nDEBUG = False\nNAME = 'svc'\n";
  const result = await smartapply(c.diff, c.files, {
    callLlmForApply: async () => good,
  });
  // stripThinkTags trims; the exact model text (not a rebuilt file) is kept.
  assert.equal(result['cfg.py'], good.trim());
});

test('ellipsis context: unrelated methods survive a model that copies "..."', async () => {
  const c = cases.find((item) => item.id === 'sloppy_ellipsis');
  const result = await smartapply(c.diff, c.files, {
    callLlmForApply: async (_path, _original, fileDiff) => corruptApply(fileDiff),
  });
  const got = result['m.py'];
  assert.ok(got.includes('return 33'));
  assert.ok(got.includes('return 1'));
  assert.ok(got.includes('return 2'));
  assert.ok(!got.includes('...'));
  assert.ok(!got.includes('return 3\n') && !got.endsWith('return 3'), 'old return 3 is removed');
});

test('refuses to write when the model corrupts the file and the diff cannot be anchored', async () => {
  const diff = [
    '--- a/f.py',
    '+++ b/f.py',
    '@@ -1,2 +1,2 @@',
    ' NOT_A_REAL_LINE',
    '-no_such_line',
    '+added',
  ].join('\n');
  const files = { 'f.py': 'alpha\nbeta\n' };
  await assert.rejects(
    () => smartapply(diff, files, {
      callLlmForApply: async () => 'NOT_A_REAL_LINE\nadded\n',
    }),
    /did not add or remove/,
  );
  assert.equal(files['f.py'], 'alpha\nbeta\n');
});

test('exact apply still refuses a hunk whose context does not match', () => {
  const c = cases.find((item) => item.id === 'sloppy_wrong_context');
  const local = applyDiff(c.files, c.diff);
  assert.equal(local.changed, false);
  assert.equal(local.files['cfg.py'], c.files['cfg.py']);
});

test('apply prompt tells the model that only +/- lines may change', async () => {
  let system = '';
  let user = '';
  await callLlmForApply('cfg.py', "TIMEOUT = 30\n", '@@ -1 +1 @@\n-RETRIES = 3\n+RETRIES = 5\n', 'test-model', {
    apiKey: 'sk-test',
    callLlm: async ({ messages }) => {
      system = messages[0].content;
      user = messages[1].content;
      return { choices: [{ message: { content: 'TIMEOUT = 30\n' } }] };
    },
  });
  assert.match(system, /ONLY the changed lines/);
  assert.match(system, /Never copy a context line/);
  assert.match(system, /must be preserved verbatim/);
  assert.match(user, /Apply only the '-' and '\+' lines/);
  assert.match(user, /RETRIES = 5/);
  assert.match(user, /Diff to apply/);
});

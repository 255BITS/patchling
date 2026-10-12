/**
 * Mocked-LLM coverage for the NanoGPT smartapply cases, plus the
 * wrong-context safeguard: a model that copies stale context or drops lines
 * the diff did not remove must not win.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { smartapply, applyDiff, callLlmForApply } from '../src/index.js';
import { diffOutputViolatesIntent } from '../src/applydiff.js';
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
  // hard_renamed_fn / hard_drifted_js need a model that adapts names and
  // anchors; a context-copy cannot be repaired into the graded file.
  const needsLlm = new Set(['sloppy_wrong_context', 'sloppy_ellipsis', 'hard_moved_block']);
  const semantic = new Set(['hard_renamed_fn', 'hard_drifted_js']);
  for (const c of cases) {
    if (semantic.has(c.id)) continue;
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

test('hard_moved_block: indent-shifted class method is accepted, not refused', async () => {
  const c = cases.find((item) => item.id === 'hard_moved_block');
  const original = c.files['calc.py'];
  // What every live model actually returns: the free function is the method,
  // the @@ header is past EOF, and the changed line keeps the file's indent.
  const corrected = original.replace(
    's += it.price * it.qty',
    "s += it.price * it.qty * (1 - getattr(it, 'discount', 0))",
  );
  assert.equal(diffOutputViolatesIntent(original, corrected, c.diff), false);
  const result = await smartapply(c.diff, c.files, {
    callLlmForApply: async () => corrected,
  });
  assert.equal(gradeSmartapplyCase(result, c), '');
  assert.ok(result['calc.py'].includes("            s += it.price * it.qty * (1 - getattr(it, 'discount', 0))"));
  assert.ok(result['calc.py'].includes('def total(self, items)'));
  assert.ok(!result['calc.py'].includes('def total(items)'));
  assert.equal(result['calc.py'], corrected.trim());
});

test('hard_moved_block: a relocated hunk is replayed at the method indent', async () => {
  const c = cases.find((item) => item.id === 'hard_moved_block');
  const result = await smartapply(c.diff, c.files, {
    callLlmForApply: async (_path, _original, fileDiff) => corruptApply(fileDiff),
  });
  assert.equal(gradeSmartapplyCase(result, c), '');
  const got = result['calc.py'];
  assert.ok(got.includes('def total(self, items)'));
  assert.ok(got.includes('s = 0.0'));
  assert.ok(got.includes('self.history.append(s)'));
  assert.ok(got.includes('return round(s, self.precision)'));
  assert.ok(got.includes('def clear(self):'));
  assert.ok(!got.includes('def total(items)'));
  assert.ok(!got.includes('return s\n') && !got.endsWith('return s'));
});

test('hard_moved_block: deleting unrelated lines is still a violation', async () => {
  const c = cases.find((item) => item.id === 'hard_moved_block');
  const original = c.files['calc.py'];
  const dropped = original
    .replace(
      's += it.price * it.qty',
      "s += it.price * it.qty * (1 - getattr(it, 'discount', 0))",
    )
    .replace(/\n\n    def clear\(self\):\n        self\.history = \[\]\n?$/, '\n');
  assert.ok(!dropped.includes('def clear(self)'), 'fixture drops the unrelated method');
  assert.equal(diffOutputViolatesIntent(original, dropped, c.diff), true);
  const result = await smartapply(c.diff, c.files, {
    callLlmForApply: async () => dropped,
  });
  assert.ok(result['calc.py'].includes('def clear(self):'));
  assert.ok(result['calc.py'].includes('self.history.append(s)'));
  assert.ok(result['calc.py'].includes("(1 - getattr(it, 'discount', 0))"));
  assert.equal(c.files['calc.py'], original);
});

test('hard_moved_block: empty model output is still a violation', async () => {
  const c = cases.find((item) => item.id === 'hard_moved_block');
  const original = c.files['calc.py'];
  assert.equal(diffOutputViolatesIntent(original, '', c.diff), true);
  assert.equal(diffOutputViolatesIntent(original, '   \n', c.diff), true);
  const result = await smartapply(c.diff, c.files, {
    callLlmForApply: async () => '',
  });
  assert.ok(result['calc.py'].trim().length > 0);
  assert.equal(gradeSmartapplyCase(result, c), '');
  assert.equal(c.files['calc.py'], original);
});

test('refuses empty output when the diff cannot be anchored', async () => {
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
    () => smartapply(diff, files, { callLlmForApply: async () => '' }),
    /did not add or remove/,
  );
  assert.equal(files['f.py'], 'alpha\nbeta\n');
});

test('hard_drifted_js: an exact insertion into the real handler is kept', async () => {
  const c = cases.find((item) => item.id === 'hard_drifted_js');
  const original = c.files['server.js'];
  const insertion = [
    '  if (!user) {',
    "    return res.status(404).json({ error: 'not found' })",
    '  }',
  ].join('\n');
  const corrected = original.replace('  res.json(user);', `${insertion}\n  res.json(user);`);
  assert.equal(diffOutputViolatesIntent(original, corrected, c.diff), false);
  const result = await smartapply(c.diff, c.files, {
    callLlmForApply: async () => corrected,
  });
  assert.equal(gradeSmartapplyCase(result, c), '');
  assert.ok(result['server.js'].includes('await db.find(req.params.id)'));
  assert.ok(result['server.js'].includes("'/users/:id'"));
});

test('hard_renamed_fn: copying the diff\'s renamed function is not written over the file', async () => {
  const c = cases.find((item) => item.id === 'hard_renamed_fn');
  const original = c.files['svc.py'];
  const result = await smartapply(c.diff, c.files, {
    callLlmForApply: async (_path, _original, fileDiff) => corruptApply(fileDiff),
  });
  const got = result['svc.py'];
  assert.ok(got.includes('def fetch_user_record(uid, db):'));
  assert.ok(got.includes("log.warning('missing %s', uid)"));
  assert.ok(got.includes('def keep_me():'));
  assert.ok(got.includes("return 'kept'"));
  assert.ok(!got.includes('def get_user'));
  assert.ok(!got.includes('database.get'));
  assert.ok(got.includes('raise KeyError'));
  assert.equal(c.files['svc.py'], original);
});

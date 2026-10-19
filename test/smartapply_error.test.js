/**
 * SmartApplyError: smartapply's refusal to write a corrupted file is a typed
 * error (parity with patchling-py's SmartApplyError), while provider/LLM
 * failures still propagate as the original error. All LLM calls are mocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smartapply, callLlmForApply, SmartApplyError } from '../src/index.js';
import { SmartApplyError as SmartApplyErrorFromModule } from '../src/gptdiff.js';

// Context and '-' line are not in the file, so the deterministic paths fail
// and the (mocked) model is consulted.
const UNANCHORED_DIFF = [
  '--- a/f.py',
  '+++ b/f.py',
  '@@ -1,2 +1,2 @@',
  ' NOT_A_REAL_LINE',
  '-no_such_line',
  '+added',
].join('\n');

const REFUSAL_MESSAGE =
  'smartapply: refusing to write "f.py": the model changed lines the diff did not add or remove';

test('SmartApplyError is exported from the package entry and is an Error subclass', () => {
  assert.equal(SmartApplyError, SmartApplyErrorFromModule);
  const err = new SmartApplyError('boom');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof SmartApplyError);
  assert.equal(err.name, 'SmartApplyError');
  assert.equal(err.message, 'boom');
  assert.equal(String(err), 'SmartApplyError: boom');
});

test('a refused model rewrite rejects with SmartApplyError and keeps its message', async () => {
  const files = { 'f.py': 'alpha\nbeta\n' };
  let calls = 0;
  await assert.rejects(
    () => smartapply(UNANCHORED_DIFF, files, {
      callLlmForApply: async () => {
        calls += 1;
        return 'NOT_A_REAL_LINE\nadded\n';
      },
    }),
    (err) => {
      assert.ok(err instanceof SmartApplyError, `expected SmartApplyError, got ${err && err.name}`);
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'SmartApplyError');
      assert.equal(err.message, REFUSAL_MESSAGE);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(files, { 'f.py': 'alpha\nbeta\n' }, 'input map is not mutated');
});

test('an empty model rewrite is refused with SmartApplyError too', async () => {
  await assert.rejects(
    () => smartapply(UNANCHORED_DIFF, { 'f.py': 'alpha\nbeta\n' }, {
      callLlmForApply: async () => '',
    }),
    (err) => err instanceof SmartApplyError && err.message === REFUSAL_MESSAGE,
  );
});

test('a provider error from the applier propagates unchanged, not as SmartApplyError', async () => {
  class ProviderError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ProviderError';
      this.status = status;
    }
  }
  const providerError = new ProviderError('LLM API error 402: insufficient balance', 402);
  await assert.rejects(
    () => smartapply(UNANCHORED_DIFF, { 'f.py': 'alpha\nbeta\n' }, {
      callLlmForApply: async () => { throw providerError; },
    }),
    (err) => {
      assert.equal(err, providerError, 'same error object, not wrapped');
      assert.ok(!(err instanceof SmartApplyError));
      assert.equal(err.name, 'ProviderError');
      assert.equal(err.status, 402);
      return true;
    },
  );
});

test('a plain Error from the LLM client propagates unchanged through callLlmForApply', async () => {
  const networkError = new TypeError('fetch failed');
  await assert.rejects(
    () => callLlmForApply('f.py', 'alpha\n', '@@ -1 +1 @@\n-alpha\n+beta\n', 'test-model', {
      apiKey: 'sk-test',
      callLlm: async () => { throw networkError; },
    }),
    (err) => err === networkError && !(err instanceof SmartApplyError),
  );
});

test('the deterministic fast path never throws SmartApplyError or calls the model', async () => {
  const diff = '--- a/f.py\n+++ b/f.py\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n';
  const result = await smartapply(diff, { 'f.py': 'alpha\nbeta\n' }, {
    callLlmForApply: async () => { throw new Error('model must not be called'); },
  });
  assert.equal(result['f.py'], 'alpha\ngamma\n');
});

/**
 * Opt-in relevance filter against a live cheap model.
 *
 * Skipped unless both of these are set:
 *   LIVE_LLM=1
 *   GPTDIFF_LLM_API_KEY=<NanoGPT key>
 *
 * `npm test` / CI does not set LIVE_LLM, so this file makes no network calls
 * there. Run it with:  npm run test:live:filter
 *
 * Model defaults to the cheap filter model (override with GPTDIFF_FILTER_MODEL).
 * Base URL is the package default (override GPTDIFF_LLM_BASE_URL).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRelevant, buildEnvironment, DEFAULT_FILTER_MODEL } from '../src/index.js';

const apiKey = process.env.GPTDIFF_LLM_API_KEY;
const LIVE = process.env.LIVE_LLM === '1' && !!apiKey;
const MODEL = process.env.GPTDIFF_FILTER_MODEL || DEFAULT_FILTER_MODEL;

test(
  'live: filterRelevant keeps the greeting file and drops the unrelated one',
  {
    skip: LIVE ? false : 'set LIVE_LLM=1 and GPTDIFF_LLM_API_KEY to run',
    timeout: 120_000,
  },
  async () => {
    const files = {
      'greet.py': 'def greet():\n    print("hello")\n',
      'math_utils.py': 'def add(a, b):\n    return a + b\n',
    };
    const task = 'Change the greeting from hello to goodbye. Do not edit unrelated helpers.';
    const result = await filterRelevant(files, task, { model: MODEL, apiKey });
    const by = Object.fromEntries(result.decisions.map((d) => [d.path, d]));

    assert.equal(by['greet.py'].decision, 'yes', JSON.stringify(by['greet.py']));
    assert.equal(by['math_utils.py'].decision, 'no', JSON.stringify(by['math_utils.py']));
    assert.equal(by['greet.py'].skippedReason, null);
    assert.ok(by['greet.py'].raw);
    assert.equal(result.files['greet.py'], files['greet.py']);
    assert.equal('math_utils.py' in result.files, false);

    const env = buildEnvironment(files, { decisions: result.decisions });
    assert.match(env, /File: greet\.py/);
    assert.doesNotMatch(env, /math_utils/);
  },
);

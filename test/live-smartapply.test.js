/**
 * Opt-in end-to-end smartapply cases against NanoGPT.
 *
 * Skipped unless both of these are set:
 *   LIVE_LLM=1
 *   GPTDIFF_LLM_API_KEY=<NanoGPT key>
 *
 * `npm test` / CI does not set LIVE_LLM, so this file makes no network calls
 * there. Run the suite with:  npm run test:live:llm
 *
 * Model defaults to the package default (override with GPTDIFF_MODEL).
 * Base URL defaults to https://nano-gpt.com/api/v1/ (override GPTDIFF_LLM_BASE_URL).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { smartapply } from '../src/index.js';
import { DEFAULT_MODEL } from '../src/env.js';
import { gradeSmartapplyCase } from './grade-smartapply-case.js';

const cases = JSON.parse(
  readFileSync(new URL('./fixtures/smartapply-live-cases.json', import.meta.url), 'utf8'),
);

const apiKey = process.env.GPTDIFF_LLM_API_KEY;
const LIVE = process.env.LIVE_LLM === '1' && !!apiKey;
const MODEL = process.env.GPTDIFF_MODEL || DEFAULT_MODEL;

test(
  'live: smartapply NanoGPT cases',
  {
    skip: LIVE ? false : 'set LIVE_LLM=1 and GPTDIFF_LLM_API_KEY to run',
    timeout: 300_000,
  },
  async () => {
    for (const c of cases) {
      const result = await smartapply(c.diff, c.files, { model: MODEL, apiKey });
      const why = gradeSmartapplyCase(result, c);
      assert.equal(why, '', `${c.id}: ${why}\n${JSON.stringify(result)}`);
    }
  },
);

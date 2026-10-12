/**
 * gptdiff-js — generate and apply git diffs using LLMs, in the browser.
 *
 * Public API mirrors the gptdiff Python package, scoped to generateDiff +
 * smartapply and their building blocks.
 */

export { generateDiff, smartapply, buildEnvironment, callLlmForDiff, callLlmForApply, callLlmForApplyWithThink } from './gptdiff.js';
export {
  filterRelevant,
  createMemoryCache,
  parseRelevanceAnswer,
  DEFAULT_FILTER_MODEL,
  DEFAULT_FILTER_MAX_BYTES,
  DEFAULT_FILTER_CONCURRENCY,
} from './filter.js';

/**
 * @typedef {import('./filter.js').RelevanceDecision} RelevanceDecision
 * @typedef {import('./filter.js').RelevanceCache} RelevanceCache
 * @typedef {import('./filter.js').RelevanceCacheEntry} RelevanceCacheEntry
 */
export { parseDiffPerFile, applyDiff, applyPatchToFile } from './applydiff.js';
export { colorCodeDiff, swallowReasoning, stripBadOutput, extractDiffBlocks, stripThinkTags } from './text.js';
export { callLlm, resolveApiKey, resolveBaseUrl } from './llm.js';
export { getEnv, setEnv, DEFAULT_MODEL, DEFAULT_BASE_URL } from './env.js';
export * as oauth from './oauth.js';

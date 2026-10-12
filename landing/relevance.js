/**
 * Browser entry for the relevance filter on patchling.app.
 *
 * Cloudflare Pages publishes `landing/` only, so this re-exports the package
 * sources vendored in `./lib` (kept identical to `src/` — see
 * test/landing_lib_sync.test.js). The rest of the playground still calls
 * generateDiff / smartapply from the published package.
 */
export {
  filterRelevant,
  createMemoryCache,
  parseRelevanceAnswer,
  DEFAULT_FILTER_MODEL,
  DEFAULT_FILTER_MAX_BYTES,
  DEFAULT_FILTER_CONCURRENCY,
} from './lib/filter.js';

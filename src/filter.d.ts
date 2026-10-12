/**
 * Process-wide in-memory cache used when `filterRelevant` is called without
 * a `cache` option. Pass the result as `cache` to share or inspect it.
 * @returns {RelevanceCache}
 */
export function createMemoryCache(): RelevanceCache;
/**
 * Parse a yes/no classification. Think tags and "> Reasoning" preambles are
 * removed first. The first word wins when it is yes or no. If both words
 * appear, or neither does, the answer is ambiguous and the caller includes
 * the file.
 *
 * @param {unknown} raw
 * @returns {{ decision: 'yes' | 'no', reason: string | null, ambiguous: boolean }}
 */
export function parseRelevanceAnswer(raw: unknown): {
    decision: "yes" | "no";
    reason: string | null;
    ambiguous: boolean;
};
/**
 * Ask a cheap model which files are relevant to `task`.
 *
 * Files are classified with at most `concurrency` calls in flight. Binary
 * files and files over `maxBytes` are not sent. The cache key is
 * `(model, sha256(task), sha256(content))`. Omitting `cache` uses an
 * in-memory cache shared by later calls; `cache: null` disables it.
 *
 * @param {Record<string, string>} files
 * @param {string} task
 * @param {object} [opts]
 * @param {string} [opts.model] cheap classifier; `GPTDIFF_FILTER_MODEL`, else {@link DEFAULT_FILTER_MODEL}
 * @param {number} [opts.concurrency] max in-flight calls (default 8)
 * @param {RelevanceCache | null} [opts.cache] pluggable cache; null disables; default is in-memory
 * @param {number | null} [opts.maxBytes] UTF-8 size cap; null disables; default {@link DEFAULT_FILTER_MAX_BYTES}
 * @param {(decision: RelevanceDecision) => void} [opts.onDecision] called as each file finishes (completion order)
 * @param {string} [opts.apiKey] same resolution as the rest of the package (`GPTDIFF_LLM_API_KEY`)
 * @param {string} [opts.baseUrl] same resolution as the rest of the package (`GPTDIFF_LLM_BASE_URL`)
 * @param {Function} [opts.callLlm] injectable client (tests)
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @returns {Promise<RelevanceDecision[]>} one decision per file, in input order
 */
export function filterRelevant(files: Record<string, string>, task: string, opts?: {
    model?: string;
    concurrency?: number;
    cache?: RelevanceCache | null;
    maxBytes?: number | null;
    onDecision?: (decision: RelevanceDecision) => void;
    apiKey?: string;
    baseUrl?: string;
    callLlm?: Function;
    maxTokens?: number;
    temperature?: number;
}): Promise<RelevanceDecision[]>;
/** Cheap default for yes/no classification. Override with GPTDIFF_FILTER_MODEL. */
export const DEFAULT_FILTER_MODEL: "xiaomi/mimo-v2.5-pro-ultraspeed";
/** Files larger than this (UTF-8 bytes) are skipped unless `maxBytes` is set. */
export const DEFAULT_FILTER_MAX_BYTES: 262144;
/** In-flight classifications per call when `concurrency` is omitted. */
export const DEFAULT_FILTER_CONCURRENCY: 8;
export type RelevanceDecision = {
    path: string;
    /**
     * `yes` files go on to generateDiff.
     * Ambiguous answers and errors are `yes` so a bad classifier cannot drop a
     * file. `skip` files were not sent to the model.
     */
    decision: "yes" | "no" | "skip";
    /**
     * model text, unchanged (think tags included)
     */
    raw: string | null;
    /**
     * total tokens for the call; null when skipped or the call failed
     */
    tokens: number | null;
    /**
     * true when this answer was read from the cache
     */
    cached: boolean;
    skippedReason: "binary" | "too-large" | null;
    /**
     * set for thrown calls and ambiguous answers
     */
    error: string | null;
    /**
     * short reason after the yes/no, when the model gave one
     */
    reason: string | null;
};
export type RelevanceCacheEntry = {
    decision: "yes" | "no";
    raw: string | null;
    tokens: number | null;
    reason: string | null;
};
/**
 * A cache is any object with `get(key)` and `set(key, value)`. Either method
 * may be sync or async. Keys are `${model}\\0${taskHash}\\0${contentHash}`
 * (SHA-256 hex). Pass `cache: null` to disable caching.
 */
export type RelevanceCache = {
    get: (key: string) => RelevanceCacheEntry | undefined | Promise<RelevanceCacheEntry | undefined>;
    set: (key: string, value: RelevanceCacheEntry) => void | Promise<void>;
};

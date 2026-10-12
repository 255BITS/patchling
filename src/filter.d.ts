/**
 * Fresh in-memory cache. Pass one instance as `cache` to share it across calls.
 * @returns {RelevanceCache}
 */
export function createMemoryCache(): RelevanceCache;
/**
 * Parse a yes/no relevance answer.
 *
 * Think tags, one fenced block, and chain-of-thought reasoning are removed
 * first. Whitespace, quotes, markdown bold or backticks, and one `Answer:`
 * or `Decision:` prefix are wrappers. The first token must then be exactly
 * `yes` or `no`, and the next character must be the end of the string,
 * whitespace, or one of `. , ! : ; )`. Anything else is malformed (`null`);
 * callers include the file and do not cache it.
 *
 * @param {unknown} raw
 * @returns {{ decision: 'yes' | 'no' | null, cleaned: string }}
 */
export function parseRelevanceAnswer(raw: unknown): {
    decision: "yes" | "no" | null;
    cleaned: string;
};
/**
 * Code-point stand-in for a tokenizer. Empty text is 0. Otherwise
 * `ceil(codePoints / 4)`. A surrogate pair counts as one code point.
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text: string): number;
/**
 * True when `content` looks like a binary file (NUL or a dense run of
 * non-text controls). Non-text values other than byte arrays are not binary;
 * {@link filterRelevant} rejects them when it coerces the file.
 * @param {unknown} content
 * @returns {boolean}
 */
export function isBinaryContent(content: unknown): boolean;
/**
 * @param {string} filePath
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function isIgnoredPath(filePath: string, patterns?: string[]): boolean;
/**
 * Ask a cheap model which files are relevant to `task`.
 *
 * `files` is a `{ path: content }` map (string or byte array). The returned
 * `files` map contains only the `yes` files, in input order, with their
 * original contents — a truncated preview is what the model saw, not what is
 * forwarded. `decisions` has one entry per input file.
 *
 * `cache` is a {@link RelevanceCache}, a filesystem path (memory plus that
 * JSON file), `true` or omitted (a fresh in-memory cache for this call), or
 * `null` / `false` (disabled). The cache key hashes the prompt version, model,
 * output-token limit, the reasoning effort actually sent, task, path, mode,
 * preview note, and the body that was sent. A cache read failure is a miss.
 * A cache write failure is logged and the run continues. Each path is
 * classified on its own, including paths whose contents match.
 *
 * Binary files and files over `maxBytes` / `maxTokens` are not sent in full.
 * `onBinary` and `onOversize` are `include` (keep, no model call), `exclude`
 * (drop, no model call), or `truncate` (ask about a truncated or redacted
 * preview). Pass `0` or `null` for `maxBytes` or `maxTokens` to disable that
 * limit. Credentials resolve the same way as the rest of the library.
 *
 * @param {Record<string, string | Uint8Array>} files
 * @param {string} task
 * @param {object} [opts]
 * @param {string} [opts.model] `GPTDIFF_FILTER_MODEL`, else {@link DEFAULT_FILTER_MODEL}
 * @param {number} [opts.concurrency] max in-flight calls (default {@link DEFAULT_FILTER_CONCURRENCY})
 * @param {RelevanceCache | string | boolean | null | { get: Function, put?: Function, set?: Function }} [opts.cache]
 * @param {number | null} [opts.maxBytes] UTF-8 cap; `0` or `null` disables; default {@link DEFAULT_FILTER_MAX_BYTES}
 * @param {number | null} [opts.maxTokens] input-token cap; `0` or `null` disables; default {@link DEFAULT_FILTER_MAX_TOKENS}
 * @param {'include' | 'exclude' | 'truncate'} [opts.onOversize] default `truncate`
 * @param {'include' | 'exclude' | 'truncate'} [opts.onBinary] default `exclude`
 * @param {number} [opts.maxOutputTokens] completion cap (default {@link DEFAULT_FILTER_MAX_OUTPUT_TOKENS})
 * @param {string | null} [opts.reasoningEffort] default {@link DEFAULT_FILTER_REASONING_EFFORT}; `null` omits it
 * @param {number} [opts.retries] extra attempts after a timeout, HTTP 5xx, or a billing-reservation error (default 2). A 4xx that names `reasoning_effort` is retried once without that parameter and does not consume one of these attempts.
 * @param {number} [opts.retryBaseMs] backoff base in ms (default 200, doubles, capped at 30s)
 * @param {boolean | string[] | null} [opts.ignore] lockfile and generated-file patterns.
 *   `true` or omitted uses {@link DEFAULT_IGNORE_PATTERNS}. `false` or `null` classifies every path.
 *   An array replaces the default list.
 * @param {(decision: RelevanceDecision) => void} [opts.onDecision] called as each file finishes (completion order)
 * @param {string} [opts.apiKey] `GPTDIFF_LLM_API_KEY` when omitted
 * @param {string} [opts.baseUrl] `GPTDIFF_LLM_BASE_URL` when omitted
 * @param {Function} [opts.callLlm] injectable client (tests)
 * @returns {Promise<FilterRelevantResult>}
 */
export function filterRelevant(files: Record<string, string | Uint8Array>, task: string, opts?: {
    model?: string;
    concurrency?: number;
    cache?: RelevanceCache | string | boolean | null | {
        get: Function;
        put?: Function;
        set?: Function;
    };
    maxBytes?: number | null;
    maxTokens?: number | null;
    onOversize?: "include" | "exclude" | "truncate";
    onBinary?: "include" | "exclude" | "truncate";
    maxOutputTokens?: number;
    reasoningEffort?: string | null;
    retries?: number;
    retryBaseMs?: number;
    ignore?: boolean | string[] | null;
    onDecision?: (decision: RelevanceDecision) => void;
    apiKey?: string;
    baseUrl?: string;
    callLlm?: Function;
}): Promise<FilterRelevantResult>;
/**
 * One-screen summary of a filter pass. Per-file lines when `verbose`.
 * @param {FilterRelevantResult} result
 * @param {boolean} [verbose]
 * @returns {string}
 */
export function formatFilterSummary(result: FilterRelevantResult, verbose?: boolean): string;
/**
 * Write the filter result as JSON so callers can inspect every decision.
 * Decision fields stay camelCase. `files` is the list of kept paths.
 * @param {FilterRelevantResult} result
 * @param {string} path
 * @returns {Promise<void>}
 */
export function dumpDecisions(result: FilterRelevantResult, path: string): Promise<void>;
/** Cheap default for yes/no classification. Override with GPTDIFF_FILTER_MODEL. */
export const DEFAULT_FILTER_MODEL: "xiaomi/mimo-v2.6-flash";
/** In-flight classifications per call when `concurrency` is omitted. */
export const DEFAULT_FILTER_CONCURRENCY: 8;
/** UTF-8 size cap. `0` or `null` disables it. */
export const DEFAULT_FILTER_MAX_BYTES: 200000;
/** Input-token cap (`ceil(code points / 4)`). `0` or `null` disables it. */
export const DEFAULT_FILTER_MAX_TOKENS: 12000;
/**
 * Completion cap for the yes/no call. High enough that a reasoning model's
 * scratchpad does not consume the whole answer. `reasoning_effort` is also
 * sent as `low`.
 */
export const DEFAULT_FILTER_MAX_OUTPUT_TOKENS: 1024;
/** Sent on the filter call so reasoning models keep the yes/no inside the budget. */
export const DEFAULT_FILTER_REASONING_EFFORT: "low";
/**
 * Bumped when the prompt or the yes/no contract changes so an old judgment is
 * not reused. The cache key stringifies this value. `PROMPT_VERSION` is the
 * shared name; `FILTER_PROMPT_VERSION` is the same number.
 */
export const PROMPT_VERSION: 3;
export const FILTER_PROMPT_VERSION: 3;
/**
 * Lockfiles and generated paths skipped unless `ignore` is `false` or a custom list.
 * Patterns are case-insensitive globs (`**` crosses directories, `*` does not).
 */
export const DEFAULT_IGNORE_PATTERNS: string[];
/**
 * @typedef {object} RelevanceDecision
 * @property {string} path
 * @property {'yes' | 'no'} decision `yes` files go on to generateDiff.
 *   Ambiguous answers and errors are `yes`.
 * @property {string} reason short explanation; the cleaned model text when a call was made
 * @property {string | null} raw model text before parsing, or null when no call was made
 * @property {number} tokens total tokens for the call; 0 when no call was made
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {boolean} cached true when this judgment was reused (a cache hit, or a later path in a shared request)
 * @property {'binary' | 'oversize' | 'truncated' | 'ignored' | null} skippedReason
 *   set when the file was not sent in full. `ignored` is a lockfile or generated path.
 * @property {string | null} error set when the call threw or the answer was empty;
 *   the file is still included
 * @property {boolean} failedOpen true when the file was included without a
 *   definitive yes/no (empty, malformed, thrown, or a cache failure that
 *   blocked a decision)
 */
/**
 * @typedef {object} FilterRelevantResult
 * @property {Record<string, string>} files `yes` files in input order, original contents
 * @property {RelevanceDecision[]} decisions one per input file, in input order
 * @property {string} model
 * @property {RelevanceDecision[]} errors decisions whose call threw
 * @property {number} billedTokens sum of `tokens` on decisions that were not cache hits
 * @property {number} billedPromptTokens
 * @property {number} billedCompletionTokens
 * @property {number} failedOpen files included because the call failed, the answer
 *   was empty, or the answer was ambiguous
 */
/**
 * Record stored in a cache. Snake_case so a JSON file matches the Python cache.
 * @typedef {object} RelevanceCacheRecord
 * @property {'yes' | 'no'} decision
 * @property {string} [reason]
 * @property {string | null} [raw]
 * @property {number} [tokens]
 * @property {number} [prompt_tokens]
 * @property {number} [completion_tokens]
 * @property {'binary' | 'oversize' | 'truncated' | null} [skipped_reason]
 * @property {string | null} [error]
 * @property {boolean} [failed_open]
 * @property {string} [cache_key]
 */
/**
 * In-memory relevance cache with an optional on-disk JSON file.
 *
 * The key is the SHA-256 of the exact classification inputs, length-prefixed
 * in this order: prompt version, model, output-token limit, reasoning effort
 * actually sent, task, path, mode (`full`, `truncated`, or `binary`), the
 * preview note (or `""`), and the content actually sent. Two paths never
 * share a key, even when their contents match. A full file and a preview
 * truncated to the same bytes do not share a key either.
 */
export class RelevanceCache {
    /**
     * SHA-256 hex of the length-prefixed classification inputs.
     * Each field is its UTF-8 bytes, written as `byteLength`, a colon, the
     * bytes, and a newline. Field order: prompt version, model, output-token
     * limit, reasoning effort actually sent (`""` when omitted or rejected),
     * task, path, mode (`full`, `truncated`, or `binary`), note (or `""`),
     * content.
     * @param {object} fields
     * @param {string} fields.model
     * @param {string} [fields.intent] task text
     * @param {string} [fields.task] task text when `intent` is omitted
     * @param {string} fields.path
     * @param {string} fields.content body sent to the model, after truncation
     * @param {'full' | 'truncated' | 'binary'} [fields.mode] default `full`
     * @param {string} [fields.note] exact preview note, or empty
     * @param {number} [fields.maxOutputTokens]
     * @param {string | null} [fields.reasoningEffort] effort actually sent
     * @param {number | string} [fields.promptVersion]
     * @returns {Promise<string>}
     */
    static makeKey(fields: {
        model: string;
        intent?: string;
        task?: string;
        path: string;
        content: string;
        mode?: "full" | "truncated" | "binary";
        note?: string;
        maxOutputTokens?: number;
        reasoningEffort?: string | null;
        promptVersion?: number | string;
    }): Promise<string>;
    /**
     * @param {string} [path] JSON file. Omit for memory only.
     *   Loaded on the first read. Corrupt files are ignored.
     */
    constructor(path?: string);
    path: string;
    /** @type {Record<string, RelevanceCacheRecord>} */
    _entries: Record<string, RelevanceCacheRecord>;
    /** @type {Promise<void> | null} */
    _loadPromise: Promise<void> | null;
    /**
     * @param {string} key
     * @returns {Promise<RelevanceCacheRecord | undefined>}
     */
    get(key: string): Promise<RelevanceCacheRecord | undefined>;
    /**
     * @param {string} key
     * @param {RelevanceCacheRecord} record
     * @returns {Promise<void>}
     */
    put(key: string, record: RelevanceCacheRecord): Promise<void>;
    /**
     * Alias of {@link put} so a `{ get, set }` cache and a `RelevanceCache` share a shape.
     * @param {string} key
     * @param {RelevanceCacheRecord} record
     * @returns {Promise<void>}
     */
    set(key: string, record: RelevanceCacheRecord): Promise<void>;
    /** Write `{ version: 1, entries }` atomically. No-op without a path. */
    flush(): Promise<void>;
    /** @returns {Promise<void>} */
    load(): Promise<void>;
    /** @returns {Promise<void>} */
    _load(): Promise<void>;
}
export type RelevanceDecision = {
    path: string;
    /**
     * `yes` files go on to generateDiff.
     * Ambiguous answers and errors are `yes`.
     */
    decision: "yes" | "no";
    /**
     * short explanation; the cleaned model text when a call was made
     */
    reason: string;
    /**
     * model text before parsing, or null when no call was made
     */
    raw: string | null;
    /**
     * total tokens for the call; 0 when no call was made
     */
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    /**
     * true when this judgment was reused (a cache hit, or a later path in a shared request)
     */
    cached: boolean;
    /**
     *   set when the file was not sent in full. `ignored` is a lockfile or generated path.
     */
    skippedReason: "binary" | "oversize" | "truncated" | "ignored" | null;
    /**
     * set when the call threw or the answer was empty;
     * the file is still included
     */
    error: string | null;
    /**
     * true when the file was included without a
     * definitive yes/no (empty, malformed, thrown, or a cache failure that
     * blocked a decision)
     */
    failedOpen: boolean;
};
export type FilterRelevantResult = {
    /**
     * `yes` files in input order, original contents
     */
    files: Record<string, string>;
    /**
     * one per input file, in input order
     */
    decisions: RelevanceDecision[];
    model: string;
    /**
     * decisions whose call threw
     */
    errors: RelevanceDecision[];
    /**
     * sum of `tokens` on decisions that were not cache hits
     */
    billedTokens: number;
    billedPromptTokens: number;
    billedCompletionTokens: number;
    /**
     * files included because the call failed, the answer
     * was empty, or the answer was ambiguous
     */
    failedOpen: number;
};
/**
 * Record stored in a cache. Snake_case so a JSON file matches the Python cache.
 */
export type RelevanceCacheRecord = {
    decision: "yes" | "no";
    reason?: string;
    raw?: string | null;
    tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    skipped_reason?: "binary" | "oversize" | "truncated" | null;
    error?: string | null;
    failed_open?: boolean;
    cache_key?: string;
};

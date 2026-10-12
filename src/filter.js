/**
 * Opt-in relevance filter for large file maps.
 *
 * For each candidate file, a cheap model sees the full contents plus the task
 * and answers "is this file relevant to the task? yes/no". Only `yes`
 * decisions should be passed to `generateDiff` (see `buildEnvironment`'s
 * `decisions` option). `smartapply` still wants the full map so files the
 * diff never mentions stay put.
 *
 * Mirrors the Python package's `filter_relevant` (255BITS/patchling-py):
 *
 *   filter_relevant(files, task, *, model=None, concurrency=8, cache=None,
 *                   max_bytes=262144, on_decision=None, api_key=None,
 *                   base_url=None) -> list[decision]
 *
 *   decision: path, decision ("yes" | "no" | "skip"), raw, tokens, cached,
 *             skipped_reason ("binary" | "too-large" | None), error, reason
 *
 * JS uses camelCase (`maxBytes`, `onDecision`, `skippedReason`) like the rest
 * of this package. Ambiguous answers and per-file errors include the file
 * (`decision: "yes"`) and surface the problem on `error` instead of throwing.
 */

import { stripThinkTags } from './text.js';
import { callLlm as defaultCallLlm, resolveApiKey, resolveBaseUrl } from './llm.js';
import { getEnv } from './env.js';

/** Cheap default for yes/no classification. Override with GPTDIFF_FILTER_MODEL. */
export const DEFAULT_FILTER_MODEL = 'xiaomi/mimo-v2.5-pro-ultraspeed';

/** Files larger than this (UTF-8 bytes) are skipped unless `maxBytes` is set. */
export const DEFAULT_FILTER_MAX_BYTES = 262144;

/** In-flight classifications per call when `concurrency` is omitted. */
export const DEFAULT_FILTER_CONCURRENCY = 8;

const FILTER_SYSTEM_PROMPT = `You decide if one file is relevant to a coding task. Reply with "yes" or "no" as the first word. You may add one short reason after it. Do not quote the file.`;

const AMBIGUOUS = 'ambiguous answer';

/**
 * @typedef {object} RelevanceDecision
 * @property {string} path
 * @property {'yes' | 'no' | 'skip'} decision `yes` files go on to generateDiff.
 *   Ambiguous answers and errors are `yes` so a bad classifier cannot drop a
 *   file. `skip` files were not sent to the model.
 * @property {string | null} raw model text, unchanged (think tags included)
 * @property {number | null} tokens total tokens for the call; null when skipped or the call failed
 * @property {boolean} cached true when this answer was read from the cache
 * @property {'binary' | 'too-large' | null} skippedReason
 * @property {string | null} error set for thrown calls and ambiguous answers
 * @property {string | null} reason short reason after the yes/no, when the model gave one
 */

/**
 * @typedef {object} RelevanceCacheEntry
 * @property {'yes' | 'no'} decision
 * @property {string | null} raw
 * @property {number | null} tokens
 * @property {string | null} reason
 */

/**
 * A cache is any object with `get(key)` and `set(key, value)`. Either method
 * may be sync or async. Keys are `${model}\\0${taskHash}\\0${contentHash}`
 * (SHA-256 hex). Pass `cache: null` to disable caching.
 *
 * @typedef {object} RelevanceCache
 * @property {(key: string) => RelevanceCacheEntry | undefined | Promise<RelevanceCacheEntry | undefined>} get
 * @property {(key: string, value: RelevanceCacheEntry) => void | Promise<void>} set
 */

let sharedMemoryCache;

/**
 * Process-wide in-memory cache used when `filterRelevant` is called without
 * a `cache` option. Pass the result as `cache` to share or inspect it.
 * @returns {RelevanceCache}
 */
export function createMemoryCache() {
  /** @type {Map<string, RelevanceCacheEntry>} */
  const store = new Map();
  return {
    get(key) {
      return store.has(key) ? store.get(key) : undefined;
    },
    set(key, value) {
      store.set(key, value);
    },
  };
}

function memoryCache() {
  if (!sharedMemoryCache) sharedMemoryCache = createMemoryCache();
  return sharedMemoryCache;
}

/**
 * @param {string} text
 * @returns {Promise<string>} hex SHA-256
 */
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * @param {string} model
 * @param {string} taskHash
 * @param {string} contentHash
 * @returns {string}
 */
function cacheKey(model, taskHash, contentHash) {
  return `${model}\0${taskHash}\0${contentHash}`;
}

function resolveFilterModel(model) {
  return model || getEnv('GPTDIFF_FILTER_MODEL') || DEFAULT_FILTER_MODEL;
}

/**
 * @param {unknown} content
 * @returns {boolean}
 */
function looksBinary(content) {
  if (typeof content !== 'string') return true;
  const n = Math.min(content.length, 8192);
  let controls = 0;
  for (let i = 0; i < n; i++) {
    const c = content.charCodeAt(i);
    if (c === 0) return true;
    // C0 controls other than tab, LF, and CR. A dense run is not text.
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) controls++;
  }
  return n > 0 && controls / n > 0.3;
}

/**
 * UTF-8 byte length, stopping once `maxBytes` is exceeded.
 * @param {string} content
 * @param {number} maxBytes
 * @returns {boolean}
 */
function exceedsMaxBytes(content, maxBytes) {
  if (!Number.isFinite(maxBytes)) return false;
  let bytes = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
    if (bytes > maxBytes) return true;
  }
  return false;
}

/**
 * @param {unknown} response
 * @returns {number}
 */
function totalTokens(response) {
  const usage = response && /** @type {{ usage?: Record<string, number> }} */ (response).usage;
  if (!usage) return 0;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return usage.total_tokens ?? prompt + completion;
}

/**
 * Parse a yes/no classification. Think tags and "> Reasoning" preambles are
 * removed first. The first word wins when it is yes or no. If both words
 * appear, or neither does, the answer is ambiguous and the caller includes
 * the file.
 *
 * @param {unknown} raw
 * @returns {{ decision: 'yes' | 'no', reason: string | null, ambiguous: boolean }}
 */
export function parseRelevanceAnswer(raw) {
  const stripped = stripThinkTags(raw == null ? '' : String(raw)).trim();
  const unfenced = stripped.replace(/^```[a-z0-9]*\s*/i, '').replace(/```\s*$/i, '').trim();
  const lines = unfenced.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean);
  const first = (lines[0] || '').replace(/^[*_>"'`]+/, '').replace(/[*_"`']+$/g, '').trim();
  const lead = first.match(/^(yes|no)\b[\s.:,\-—!]*(.*)$/i);

  if (lead) {
    const decision = /** @type {'yes' | 'no'} */ (lead[1].toLowerCase());
    const sameLine = lead[2].trim();
    const reason = [sameLine, lines.slice(1).join(' ')].filter(Boolean).join(' ').trim() || null;
    const firstHasYes = /\byes\b/i.test(first);
    const firstHasNo = /\bno\b/i.test(first);
    if (firstHasYes && firstHasNo) {
      return { decision: 'yes', reason: unfenced || null, ambiguous: true };
    }
    return { decision, reason, ambiguous: false };
  }

  const hasYes = /\byes\b/i.test(unfenced);
  const hasNo = /\bno\b/i.test(unfenced);
  if (hasYes && !hasNo) return { decision: 'yes', reason: unfenced || null, ambiguous: false };
  if (hasNo && !hasYes) return { decision: 'no', reason: unfenced || null, ambiguous: false };
  return { decision: 'yes', reason: unfenced || null, ambiguous: true };
}

/**
 * @param {Array<[string, string]>} items
 * @param {number} limit
 * @param {(item: [string, string], index: number) => Promise<RelevanceDecision>} fn
 * @returns {Promise<RelevanceDecision[]>}
 */
async function mapLimit(items, limit, fn) {
  /** @type {RelevanceDecision[]} */
  const results = new Array(items.length);
  if (!items.length) return results;
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}

/**
 * @param {object} args
 * @param {string} args.path
 * @param {unknown} args.content
 * @param {string} args.task
 * @param {string} args.taskHash
 * @param {string} args.model
 * @param {RelevanceCache | null} args.store
 * @param {number} args.maxBytes
 * @param {string | undefined} args.apiKey
 * @param {string | undefined} args.baseUrl
 * @param {Function} args.callLlm
 * @param {number} args.maxTokens
 * @param {number} args.temperature
 * @returns {Promise<RelevanceDecision>}
 */
async function classifyFile(args) {
  const { path, content, task, taskHash, model, store, maxBytes, apiKey, baseUrl, callLlm, maxTokens, temperature } = args;

  if (looksBinary(content)) {
    return {
      path,
      decision: 'skip',
      raw: null,
      tokens: null,
      cached: false,
      skippedReason: 'binary',
      error: null,
      reason: null,
    };
  }

  const text = /** @type {string} */ (content);
  if (exceedsMaxBytes(text, maxBytes)) {
    return {
      path,
      decision: 'skip',
      raw: null,
      tokens: null,
      cached: false,
      skippedReason: 'too-large',
      error: null,
      reason: null,
    };
  }

  const contentHash = await sha256(text);
  const key = cacheKey(model, taskHash, contentHash);
  if (store) {
    const hit = await store.get(key);
    if (hit && (hit.decision === 'yes' || hit.decision === 'no')) {
      return {
        path,
        decision: hit.decision,
        raw: hit.raw ?? null,
        tokens: hit.tokens ?? null,
        cached: true,
        skippedReason: null,
        error: null,
        reason: hit.reason ?? null,
      };
    }
  }

  const userContent = `Task:\n${task}\n\nFile: ${path}\n${text}\n\nis this file relevant to the task? yes/no`;
  try {
    const response = await callLlm({
      apiKey: resolveApiKey(apiKey),
      baseUrl: resolveBaseUrl(baseUrl),
      model,
      messages: [
        { role: 'system', content: FILTER_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      maxTokens,
      temperature,
    });
    const raw = response?.choices?.[0]?.message?.content ?? '';
    const parsed = parseRelevanceAnswer(raw);
    /** @type {RelevanceDecision} */
    const decision = {
      path,
      decision: parsed.decision,
      raw: raw == null ? '' : String(raw),
      tokens: totalTokens(response),
      cached: false,
      skippedReason: null,
      error: parsed.ambiguous ? AMBIGUOUS : null,
      reason: parsed.ambiguous ? (parsed.reason || null) : parsed.reason,
    };
    // Keep failures and ambiguous answers out of the cache so a later call
    // can try again. Definitive yes/no answers are stable for this content.
    if (store && !parsed.ambiguous) {
      await store.set(key, {
        decision: parsed.decision,
        raw: decision.raw,
        tokens: decision.tokens,
        reason: decision.reason,
      });
    }
    return decision;
  } catch (err) {
    const message = err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : String(err);
    return {
      path,
      decision: 'yes',
      raw: null,
      tokens: null,
      cached: false,
      skippedReason: null,
      error: message,
      reason: null,
    };
  }
}

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
export async function filterRelevant(files, task, opts = {}) {
  const {
    model,
    concurrency = DEFAULT_FILTER_CONCURRENCY,
    cache,
    maxBytes = DEFAULT_FILTER_MAX_BYTES,
    onDecision,
    apiKey,
    baseUrl,
    callLlm = defaultCallLlm,
    maxTokens = 128,
    temperature = 0,
  } = opts;

  const resolvedModel = resolveFilterModel(model);
  const store = cache === undefined ? memoryCache() : cache;
  const cap = maxBytes == null ? Infinity : maxBytes;
  const limit = Math.max(1, Number.isFinite(concurrency) ? Math.floor(concurrency) : DEFAULT_FILTER_CONCURRENCY);
  const taskText = task == null ? '' : String(task);
  const taskHash = await sha256(taskText);
  const entries = Object.entries(files || {});

  return mapLimit(entries, limit, async ([path, content]) => {
    const decision = await classifyFile({
      path,
      content,
      task: taskText,
      taskHash,
      model: resolvedModel,
      store,
      maxBytes: cap,
      apiKey,
      baseUrl,
      callLlm,
      maxTokens,
      temperature,
    });
    if (typeof onDecision === 'function') onDecision(decision);
    return decision;
  });
}

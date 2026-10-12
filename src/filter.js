/**
 * Opt-in relevance filter for large file maps.
 *
 * For each candidate file, a cheap model sees the contents plus the task and
 * answers "is this file relevant to the task? yes/no". Only `yes` files are
 * returned for `generateDiff`. `smartapply` still wants the full map so files
 * the diff never mentions stay put.
 *
 * Mirrors `filter_relevant` in 255BITS/patchling-py (`cursor/relevance-filter-0192`).
 * Field names are camelCase. Ambiguous answers and per-file errors include the
 * file. An error is attached only when the call throws.
 *
 * The disk cache loads `node:fs` on demand so this module stays browser-safe.
 */

import { swallowReasoning } from './text.js';
import { callLlm as defaultCallLlm, resolveApiKey, resolveBaseUrl } from './llm.js';
import { getEnv } from './env.js';

/** Cheap default for yes/no classification. Override with GPTDIFF_FILTER_MODEL. */
export const DEFAULT_FILTER_MODEL = 'gemini-2.0-flash';

/** In-flight classifications per call when `concurrency` is omitted. */
export const DEFAULT_FILTER_CONCURRENCY = 8;

/** UTF-8 size cap. `0` or `null` disables it. */
export const DEFAULT_FILTER_MAX_BYTES = 200_000;

/** Input-token cap (characters / 4 when no tokenizer is bundled). `0` or `null` disables it. */
export const DEFAULT_FILTER_MAX_TOKENS = 12_000;

/** Completion cap for the yes/no call. */
export const DEFAULT_FILTER_MAX_OUTPUT_TOKENS = 256;

const POLICIES = ['include', 'exclude', 'truncate'];

const ANSWER_PREFIX = /^(?:answer|relevance|relevant|decision)\s*[:\-]\s*/i;
const FENCE_LINE = /^```[a-zA-Z0-9_-]*\s*$/;

const SYSTEM_PROMPT = (
  'You are a relevance filter for a code-editing task. '
  + 'Decide whether the given file must be read or edited to accomplish the task, '
  + 'or is necessary context for that edit. '
  + 'Reply with a single line that starts with exactly "yes" or exactly "no", '
  + 'followed by a short reason. '
  + 'Answer "yes" when the file is likely to need changes or is required context. '
  + 'Answer "no" when it is unrelated. Do not write a diff.'
);

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
 * @property {'binary' | 'oversize' | 'truncated' | null} skippedReason
 *   set when the file was not sent in full
 * @property {string | null} error set when the call threw; the file is still included
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
 * @property {string} [cache_key]
 */

/**
 * In-memory relevance cache with an optional on-disk JSON file.
 *
 * Keys are `model`, SHA-256 of the task, SHA-256 of the original contents, and
 * a variant tag (`full`, `binary-preview`, or `truncated:<maxTokens>:<maxBytes>`),
 * separated by newlines. A judgment on a truncated body is not reused as a
 * full-content judgment.
 */
export class RelevanceCache {
  /**
   * @param {string} [path] JSON file. Omit for memory only.
   *   Loaded on the first read. Corrupt files are ignored.
   */
  constructor(path) {
    this.path = path ? String(path) : null;
    /** @type {Record<string, RelevanceCacheRecord>} */
    this._entries = Object.create(null);
    /** @type {Promise<void> | null} */
    this._loadPromise = null;
  }

  /**
   * @param {string} model
   * @param {string} task
   * @param {string} content original file text
   * @param {string} [variant]
   * @returns {Promise<string>}
   */
  static async makeKey(model, task, content, variant = 'full') {
    const taskHash = await sha256(task);
    const contentHash = await sha256(content);
    return `${model}\n${taskHash}\n${contentHash}\n${variant}`;
  }

  /**
   * @param {string} key
   * @returns {Promise<RelevanceCacheRecord | undefined>}
   */
  async get(key) {
    await this.load();
    const record = this._entries[key];
    return record ? { ...record } : undefined;
  }

  /**
   * @param {string} key
   * @param {RelevanceCacheRecord} record
   * @returns {Promise<void>}
   */
  async put(key, record) {
    await this.load();
    this._entries[key] = { ...record };
  }

  /**
   * Alias of {@link put} so a `{ get, set }` cache and a `RelevanceCache` share a shape.
   * @param {string} key
   * @param {RelevanceCacheRecord} record
   * @returns {Promise<void>}
   */
  async set(key, record) {
    await this.put(key, record);
  }

  /** Write `{ version: 1, entries }` atomically. No-op without a path. */
  async flush() {
    if (!this.path) return;
    await this.load();
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const dir = pathMod.dirname(pathMod.resolve(this.path));
    await fs.mkdir(dir, { recursive: true });
    const tmp = pathMod.join(
      dir,
      `.relevance-cache-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    const payload = JSON.stringify({ version: 1, entries: this._entries });
    try {
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, this.path);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** @returns {Promise<void>} */
  async load() {
    if (!this.path) return;
    if (!this._loadPromise) this._loadPromise = this._load();
    await this._loadPromise;
  }

  /** @returns {Promise<void>} */
  async _load() {
    let fs;
    try {
      fs = await import('node:fs/promises');
    } catch {
      throw new Error('A disk-backed relevance cache requires Node (node:fs).');
    }
    let text;
    try {
      text = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return;
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const entries = payload && typeof payload === 'object' ? payload.entries : null;
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      this._entries = entries;
    }
  }
}

/**
 * Fresh in-memory cache. Pass one instance as `cache` to share it across calls.
 * @returns {RelevanceCache}
 */
export function createMemoryCache() {
  return new RelevanceCache();
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
 * Drop `<think>` / `<thinking>` blocks, including an unclosed tail.
 * @param {string} text
 * @returns {string}
 */
function stripFilterThinkTags(text) {
  if (!text) return '';
  let cleaned = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '');
  cleaned = cleaned.replace(/<think\b[^>]*>[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<thinking\b[^>]*>[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<\/think>/gi, '');
  cleaned = cleaned.replace(/<\/thinking>/gi, '');
  return cleaned.trim();
}

/**
 * Parse a yes/no relevance answer.
 *
 * Think tags and chain-of-thought reasoning blocks are removed before the
 * answer is read, so a "no" inside a think tag cannot override a final "yes".
 * A single consistent yes or no wins, including "Answer: yes" and a fenced
 * "NO". Both words, or neither, is ambiguous — callers include the file.
 *
 * @param {unknown} raw
 * @returns {{ decision: 'yes' | 'no' | null, cleaned: string }}
 */
export function parseRelevanceAnswer(raw) {
  let text = stripFilterThinkTags(raw == null ? '' : String(raw));
  const [swallowed] = swallowReasoning(text);
  text = swallowed.trim();
  const fenceLines = text.split(/\r\n|\r|\n/);
  if (
    fenceLines.length >= 2
    && FENCE_LINE.test(fenceLines[0].trim())
    && fenceLines[fenceLines.length - 1].trim() === '```'
  ) {
    text = fenceLines.slice(1, -1).join('\n').trim();
  }
  const cleaned = text.trim().replace(/^`+|`+$/g, '').trim();
  const contentLines = cleaned.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean);
  if (!contentLines.length) return { decision: null, cleaned };

  let answerText = contentLines[0].replace(ANSWER_PREFIX, '').trim();
  if (contentLines.length > 1) {
    answerText = `${answerText}\n${contentLines.slice(1).join('\n')}`;
  }
  const words = answerText.match(/\b(yes|no)\b/gi) || [];
  const lowered = words.map((word) => word.toLowerCase());
  if (lowered.length && new Set(lowered).size === 1) {
    return { decision: /** @type {'yes' | 'no'} */ (lowered[0]), cleaned };
  }
  return { decision: null, cleaned };
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {'include' | 'exclude' | 'truncate'}
 */
function checkPolicy(name, value) {
  if (!POLICIES.includes(/** @type {string} */ (value))) {
    throw new Error(`${name} must be one of ${POLICIES.join(', ')}; got ${JSON.stringify(value)}`);
  }
  return /** @type {'include' | 'exclude' | 'truncate'} */ (value);
}

/**
 * @param {string | undefined} model
 * @returns {string}
 */
function resolveFilterModel(model) {
  return model || getEnv('GPTDIFF_FILTER_MODEL') || DEFAULT_FILTER_MODEL;
}

/**
 * `null` and `false` disable the cache. Omit or pass `true` for a fresh
 * in-memory cache. A string is a JSON file. A `RelevanceCache` is used as-is.
 * An object with `get` and `put`/`set` is a pluggable cache.
 * @param {unknown} cache
 * @returns {RelevanceCache | { get: Function, put?: Function, set?: Function, load?: Function, flush?: Function } | null}
 */
function resolveCache(cache) {
  if (cache === false || cache === null) return null;
  if (cache === undefined || cache === true) return new RelevanceCache();
  if (cache instanceof RelevanceCache) return cache;
  if (typeof cache === 'string') return new RelevanceCache(cache);
  if (
    cache
    && typeof cache === 'object'
    && typeof /** @type {{ get?: unknown }} */ (cache).get === 'function'
    && (
      typeof /** @type {{ put?: unknown }} */ (cache).put === 'function'
      || typeof /** @type {{ set?: unknown }} */ (cache).set === 'function'
    )
  ) {
    return /** @type {{ get: Function, put?: Function, set?: Function }} */ (cache);
  }
  throw new TypeError('cache must be a RelevanceCache, a filesystem path, null, or false');
}

/**
 * Character-length stand-in for a tokenizer (Python's fallback when tiktoken
 * is absent). Empty text is 0; anything else is at least 1.
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.floor(String(text).length / 4));
}

/**
 * @param {string} text
 * @param {number | null} maxBytes
 * @param {number | null} maxTokens
 * @returns {string}
 */
function truncateText(text, maxBytes, maxTokens) {
  let out = text;
  if (maxTokens && countTokens(out) > maxTokens) {
    out = out.slice(0, maxTokens * 4);
  }
  if (maxBytes) out = truncateUtf8(out, maxBytes);
  return out;
}

/**
 * UTF-8 prefix. An incomplete trailing character is dropped, matching
 * Python's `errors="ignore"` on a cut byte string.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateUtf8(text, maxBytes) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const lead = bytes[end - 1];
    const need = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (end - 1 + need > maxBytes) end -= 1;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * @param {string} text
 * @returns {number}
 */
function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * True when `content` looks like a binary file (NUL or a dense run of
 * non-text controls). Non-text values other than byte arrays are not binary;
 * {@link filterRelevant} rejects them when it coerces the file.
 * @param {unknown} content
 * @returns {boolean}
 */
export function isBinaryContent(content) {
  if (content instanceof Uint8Array) return binaryBytes(content);
  if (typeof content !== 'string') return false;
  return textLooksBinary(content.slice(0, 8192));
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function binaryBytes(bytes) {
  const sample = bytes.subarray(0, 8192);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return textLooksBinary(text);
  } catch {
    return true;
  }
}

/**
 * @param {string} sample
 * @returns {boolean}
 */
function textLooksBinary(sample) {
  if (!sample) return false;
  if (sample.includes('\0')) return true;
  let controls = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) controls += 1;
  }
  return controls / sample.length > 0.3;
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function coerceText(content) {
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) {
    return new TextDecoder('utf-8', { fatal: false }).decode(content);
  }
  const name = content === null ? 'null' : typeof content;
  throw new TypeError(`file content must be str or bytes, got ${name}`);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number | null} null disables the limit (`0` or `null`)
 */
function resolveLimit(value, fallback) {
  const chosen = value === undefined ? fallback : value;
  if (chosen === null || chosen === 0) return null;
  const n = Number(chosen);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
/**
 * Tag a limit the way Python's f-string does: omitted uses the default number,
 * `null` is `None`, and `0` stays `0`.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {string}
 */
function rawLimitTag(value, fallback) {
  const chosen = value === undefined ? fallback : value;
  if (chosen === null || chosen === undefined) return 'None';
  return String(chosen);
}

/**
 * @param {object} fields
 * @returns {RelevanceDecision}
 */
function decisionObject(fields) {
  return {
    path: fields.path,
    decision: fields.decision,
    reason: fields.reason ?? '',
    raw: fields.raw ?? null,
    tokens: fields.tokens ?? 0,
    promptTokens: fields.promptTokens ?? 0,
    completionTokens: fields.completionTokens ?? 0,
    cached: !!fields.cached,
    skippedReason: fields.skippedReason ?? null,
    error: fields.error ?? null,
  };
}

/**
 * @param {string} path
 * @param {RelevanceCacheRecord} record
 * @param {boolean} cached
 * @returns {RelevanceDecision}
 */
function decisionFromRecord(path, record, cached) {
  const rec = /** @type {Record<string, any>} */ (record);
  return decisionObject({
    path,
    decision: /** @type {'yes' | 'no'} */ (rec.decision),
    reason: rec.reason || '',
    raw: rec.raw ?? null,
    tokens: Number(rec.tokens || 0),
    promptTokens: Number(rec.prompt_tokens ?? rec.promptTokens ?? 0),
    completionTokens: Number(rec.completion_tokens ?? rec.completionTokens ?? 0),
    cached,
    skippedReason: rec.skipped_reason ?? rec.skippedReason ?? null,
    error: rec.error ?? null,
  });
}

/**
 * @param {string} path
 * @param {'yes' | 'no'} decision
 * @param {'binary' | 'oversize'} skippedReason
 * @param {string} reason
 * @returns {RelevanceDecision}
 */
function skipDecision(path, decision, skippedReason, reason) {
  return decisionObject({
    path,
    decision,
    reason,
    raw: null,
    tokens: 0,
    cached: false,
    skippedReason,
    error: null,
  });
}

/**
 * @param {string} task
 * @param {string[]} paths
 * @param {string} body
 * @param {string | null} note
 * @returns {string}
 */
function buildUserPrompt(task, paths, body, note) {
  const label = paths.length === 1 ? 'File path' : 'File paths';
  const parts = [`Task:\n${task}`, `${label}:\n${paths.join('\n')}`];
  if (note) parts.push(note);
  parts.push(`File contents:\n${body}`);
  parts.push('Is this file relevant to the task? yes/no');
  return parts.join('\n\n');
}

/**
 * @param {unknown} response
 * @returns {{ raw: string, promptTokens: number, completionTokens: number, tokens: number }}
 */
function usageAndText(response) {
  const message = /** @type {{ choices?: Array<{ message?: { content?: string | null } }>, usage?: Record<string, number> }} */ (response);
  const content = message?.choices?.[0]?.message?.content ?? '';
  const usage = message?.usage || {};
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const tokens = Number(usage.total_tokens ?? (promptTokens + completionTokens));
  return {
    raw: content || '',
    promptTokens,
    completionTokens,
    tokens,
  };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * @param {Array<string>} items
 * @param {number} limit
 * @param {(item: string) => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function mapLimit(items, limit, fn) {
  if (!items.length) return;
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => run()));
}

/**
 * @param {{ get: Function, put?: Function, set?: Function }} store
 * @param {string} key
 * @returns {Promise<RelevanceCacheRecord | undefined>}
 */
async function cacheGet(store, key) {
  const hit = await store.get(key);
  return hit || undefined;
}

/**
 * @param {{ put?: Function, set?: Function }} store
 * @param {string} key
 * @param {RelevanceCacheRecord} record
 * @returns {Promise<void>}
 */
async function cachePut(store, key, record) {
  if (typeof store.put === 'function') await store.put(key, record);
  else await store.set(key, record);
}

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
 * `null` / `false` (disabled). The cache key is the model, a hash of the task,
 * a hash of the original file contents, and a truncation variant.
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
 * @param {(decision: RelevanceDecision) => void} [opts.onDecision] called as each file finishes (completion order)
 * @param {string} [opts.apiKey] `GPTDIFF_LLM_API_KEY` when omitted
 * @param {string} [opts.baseUrl] `GPTDIFF_LLM_BASE_URL` when omitted
 * @param {Function} [opts.callLlm] injectable client (tests)
 * @returns {Promise<FilterRelevantResult>}
 */
export async function filterRelevant(files, task, opts = {}) {
  if (files == null || typeof files !== 'object' || Array.isArray(files)) {
    throw new TypeError('files must be an object of path -> content');
  }
  if (typeof task !== 'string' || task.trim() === '') {
    throw new Error('task is required');
  }
  const concurrency = Math.trunc(Number(opts.concurrency === undefined ? DEFAULT_FILTER_CONCURRENCY : opts.concurrency));
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be >= 1');
  }
  const onOversize = checkPolicy('onOversize', opts.onOversize === undefined ? 'truncate' : opts.onOversize);
  const onBinary = checkPolicy('onBinary', opts.onBinary === undefined ? 'exclude' : opts.onBinary);
  const maxBytes = resolveLimit(opts.maxBytes, DEFAULT_FILTER_MAX_BYTES);
  const maxTokens = resolveLimit(opts.maxTokens, DEFAULT_FILTER_MAX_TOKENS);
  const maxOutputTokens = opts.maxOutputTokens === undefined
    ? DEFAULT_FILTER_MAX_OUTPUT_TOKENS
    : opts.maxOutputTokens;

  const model = resolveFilterModel(opts.model);
  const store = resolveCache(opts.cache);
  const callLlm = opts.callLlm || defaultCallLlm;
  const apiKey = opts.apiKey == null ? resolveApiKey(undefined) : opts.apiKey;
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const onDecision = opts.onDecision;

  /** @type {Map<string, RelevanceDecision>} */
  const byPath = new Map();
  /** @type {Map<string, Array<{ path: string, body: string, note: string | null, skippedReason: 'truncated' | null }>>} */
  const groups = new Map();
  /** @type {string[]} */
  const groupOrder = [];
  const entries = Object.entries(files);

  /**
   * @param {string} key
   * @param {{ path: string, body: string, note: string | null, skippedReason: 'truncated' | null }} item
   */
  function enqueue(key, item) {
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key).push(item);
  }

  /**
   * @param {RelevanceDecision} decision
   * @returns {RelevanceDecision}
   */
  function emit(decision) {
    if (typeof onDecision === 'function') onDecision(decision);
    return decision;
  }

  for (const [path, content] of entries) {
    const binary = isBinaryContent(content);
    const text = coerceText(content);
    if (binary) {
      if (onBinary === 'truncate') {
        const nbytes = content instanceof Uint8Array ? content.length : utf8ByteLength(text);
        const note = 'Note: this file is binary. Its bytes are not shown; judge relevance from the path and this note.';
        const body = `[binary file, ${nbytes} bytes, contents omitted]`;
        const key = await RelevanceCache.makeKey(model, task, text, 'binary-preview');
        enqueue(key, { path, body, note, skippedReason: 'truncated' });
      } else {
        const decision = onBinary === 'include' ? 'yes' : 'no';
        const verb = decision === 'yes' ? 'included' : 'excluded';
        const made = skipDecision(path, decision, 'binary', `binary file; ${verb} without a model call`);
        byPath.set(path, made);
        emit(made);
      }
      continue;
    }

    const nBytes = utf8ByteLength(text);
    const nTokens = countTokens(text);
    const overBytes = !!maxBytes && nBytes > maxBytes;
    const overTokens = !!maxTokens && nTokens > maxTokens;
    if (overBytes || overTokens) {
      if (onOversize === 'truncate') {
        const body = truncateText(text, maxBytes, maxTokens);
        const note = (
          'Note: this file was truncated to fit the relevance check '
          + `(${nBytes} bytes, ${nTokens} tokens). Judge from the portion shown.`
        );
        const variant = `truncated:${rawLimitTag(opts.maxTokens, DEFAULT_FILTER_MAX_TOKENS)}:${rawLimitTag(opts.maxBytes, DEFAULT_FILTER_MAX_BYTES)}`;
        const key = await RelevanceCache.makeKey(model, task, text, variant);
        enqueue(key, { path, body, note, skippedReason: 'truncated' });
      } else {
        const decision = onOversize === 'include' ? 'yes' : 'no';
        const verb = decision === 'yes' ? 'included' : 'excluded';
        const made = skipDecision(
          path,
          decision,
          'oversize',
          `over size threshold (${nBytes} bytes, ${nTokens} tokens); ${verb} without a model call`,
        );
        byPath.set(path, made);
        emit(made);
      }
      continue;
    }

    const key = await RelevanceCache.makeKey(model, task, text, 'full');
    enqueue(key, { path, body: text, note: null, skippedReason: null });
  }

  if (store && typeof store.load === 'function') await store.load();

  /**
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async function cached(key) {
    if (!store) return false;
    const hit = await cacheGet(store, key);
    return !!(hit && (hit.decision === 'yes' || hit.decision === 'no') && !hit.error);
  }

  let needsCall = false;
  for (const key of groupOrder) {
    if (!(await cached(key))) {
      needsCall = true;
      break;
    }
  }
  if (needsCall && !apiKey) {
    throw new Error(
      'GPTDIFF_LLM_API_KEY is required for the relevance filter. '
      + 'Set it in the environment or pass apiKey.',
    );
  }

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  async function runGroup(key) {
    const items = groups.get(key);
    if (store) {
      const hit = await cacheGet(store, key);
      if (hit && (hit.decision === 'yes' || hit.decision === 'no') && !hit.error) {
        for (const item of items) {
          const decision = decisionFromRecord(item.path, { ...hit, cache_key: key }, true);
          byPath.set(item.path, decision);
          emit(decision);
        }
        return;
      }
    }

    const sample = items[0];
    let raw;
    let promptTokens;
    let completionTokens;
    let totalTokens;
    try {
      const userPrompt = buildUserPrompt(task, items.map((item) => item.path), sample.body, sample.note);
      let userContent = userPrompt;
      if (model && model.includes('gemini')) userContent = `${SYSTEM_PROMPT}\n${userPrompt}`;
      const response = await callLlm({
        apiKey,
        baseUrl,
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        maxTokens: maxOutputTokens,
        temperature: 0,
        budgetTokens: null,
      });
      ({ raw, promptTokens, completionTokens, tokens: totalTokens } = usageAndText(response));
    } catch (err) {
      const message = errorMessage(err);
      for (const item of items) {
        const decision = decisionObject({
          path: item.path,
          decision: 'yes',
          reason: `error; included by default: ${message}`,
          raw: null,
          tokens: 0,
          cached: false,
          skippedReason: item.skippedReason,
          error: message,
        });
        byPath.set(item.path, decision);
        emit(decision);
      }
      return;
    }

    const parsed = parseRelevanceAnswer(raw);
    /** @type {'yes' | 'no'} */
    let decisionName;
    /** @type {string} */
    let reason;
    if (parsed.decision == null) {
      decisionName = 'yes';
      reason = parsed.cleaned
        ? `ambiguous answer; included by default: ${parsed.cleaned}`
        : 'ambiguous answer; included by default';
    } else {
      decisionName = parsed.decision;
      reason = parsed.cleaned;
    }
    /** @type {RelevanceCacheRecord} */
    const record = {
      decision: decisionName,
      reason,
      raw,
      tokens: totalTokens,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      skipped_reason: sample.skippedReason,
      error: null,
      cache_key: key,
    };
    if (store) await cachePut(store, key, record);
    items.forEach((item, index) => {
      const decision = decisionObject({
        path: item.path,
        decision: decisionName,
        reason,
        raw,
        tokens: totalTokens,
        promptTokens,
        completionTokens,
        cached: index > 0,
        skippedReason: item.skippedReason,
        error: null,
      });
      byPath.set(item.path, decision);
      emit(decision);
    });
  }

  try {
    await mapLimit(groupOrder, concurrency, runGroup);
  } finally {
    if (store && typeof store.flush === 'function') await store.flush();
  }

  /** @type {RelevanceDecision[]} */
  const decisions = entries.map(([path]) => byPath.get(path));
  /** @type {Record<string, string>} */
  const included = {};
  for (const [path, content] of entries) {
    if (byPath.get(path).decision === 'yes') {
      included[path] = typeof content === 'string' ? content : coerceText(content);
    }
  }
  const errors = decisions.filter((decision) => decision.error);
  let billedTokens = 0;
  let billedPromptTokens = 0;
  let billedCompletionTokens = 0;
  for (const decision of decisions) {
    if (decision.cached) continue;
    billedTokens += decision.tokens;
    billedPromptTokens += decision.promptTokens;
    billedCompletionTokens += decision.completionTokens;
  }
  return {
    files: included,
    decisions,
    model,
    errors,
    billedTokens,
    billedPromptTokens,
    billedCompletionTokens,
  };
}

/**
 * One-screen summary of a filter pass. Per-file lines when `verbose`.
 * @param {FilterRelevantResult} result
 * @param {boolean} [verbose]
 * @returns {string}
 */
export function formatFilterSummary(result, verbose = false) {
  const total = result.decisions.length;
  const kept = Object.keys(result.files).length;
  const errorCount = result.errors.length;
  let line = `Relevance filter (${result.model}): kept ${kept}/${total} files, ${result.billedTokens} tokens`;
  if (errorCount) line += `, ${errorCount} error${errorCount === 1 ? '' : 's'}`;
  const lines = [line];
  for (const decision of result.decisions) {
    if (decision.error) {
      lines.push(`  error ${decision.path}: ${decision.error} (included by default)`);
    } else if (verbose) {
      const flags = [];
      if (decision.cached) flags.push('cached');
      if (decision.skippedReason) flags.push(decision.skippedReason);
      const suffix = flags.length ? ` (${flags.join(', ')})` : '';
      lines.push(`  ${decision.decision.padEnd(3, ' ')} ${decision.path}${suffix}`);
    } else if (decision.skippedReason && decision.decision === 'no') {
      lines.push(`  skip  ${decision.path} (${decision.skippedReason})`);
    }
  }
  return lines.join('\n');
}

/**
 * Write the filter result as JSON so callers can inspect every decision.
 * Decision fields stay camelCase. `files` is the list of kept paths.
 * @param {FilterRelevantResult} result
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function dumpDecisions(result, path) {
  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const destination = String(path);
  const directory = pathMod.dirname(pathMod.resolve(destination));
  if (directory) await fs.mkdir(directory, { recursive: true });
  const payload = {
    model: result.model,
    files: Object.keys(result.files),
    decisions: result.decisions,
    billedTokens: result.billedTokens,
    billedPromptTokens: result.billedPromptTokens,
    billedCompletionTokens: result.billedCompletionTokens,
    errors: result.errors,
  };
  await fs.writeFile(destination, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

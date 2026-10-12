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
export const DEFAULT_FILTER_MODEL = 'xiaomi/mimo-v2.6-flash';

/** In-flight classifications per call when `concurrency` is omitted. */
export const DEFAULT_FILTER_CONCURRENCY = 8;

/** UTF-8 size cap. `0` or `null` disables it. */
export const DEFAULT_FILTER_MAX_BYTES = 200_000;

/** Input-token cap (`ceil(code points / 4)`). `0` or `null` disables it. */
export const DEFAULT_FILTER_MAX_TOKENS = 12_000;

/**
 * Completion cap for the yes/no call. High enough that a reasoning model's
 * scratchpad does not consume the whole answer. `reasoning_effort` is also
 * sent as `low`.
 */
export const DEFAULT_FILTER_MAX_OUTPUT_TOKENS = 1024;

/** Sent on the filter call so reasoning models keep the yes/no inside the budget. */
export const DEFAULT_FILTER_REASONING_EFFORT = 'low';

/**
 * Bumped when the prompt or the yes/no contract changes so an old judgment is
 * not reused. The cache key stringifies this value. `PROMPT_VERSION` is the
 * shared name; `FILTER_PROMPT_VERSION` is the same number.
 */
export const PROMPT_VERSION = 3;
export const FILTER_PROMPT_VERSION = PROMPT_VERSION;

/**
 * Lockfiles and generated paths skipped unless `ignore` is `false` or a custom list.
 * Patterns are case-insensitive globs (`**` crosses directories, `*` does not).
 */
export const DEFAULT_IGNORE_PATTERNS = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock',
  '**/bun.lockb',
  '**/npm-shrinkwrap.json',
  '**/Cargo.lock',
  '**/Gemfile.lock',
  '**/poetry.lock',
  '**/Pipfile.lock',
  '**/composer.lock',
  '**/go.sum',
  '**/uv.lock',
  '**/pdm.lock',
  '**/flake.lock',
  '**/pubspec.lock',
  '**/packages.lock.json',
  '**/Package.resolved',
  '**/*.min.js',
  '**/*.min.mjs',
  '**/*.min.css',
  '**/*.map',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/*.pyo',
  '**/*.generated.*',
];

const POLICIES = ['include', 'exclude', 'truncate'];

const LEADING_WRAPPER = /^(?:answer|decision)\s*:\s*|^[\s"'`*_“”‘’]+/i;
const TRAILING_WRAPPER = /[\s"'`*_“”‘’]+$/;
const YES_NO_TOKEN = /^(yes|no)(?=$|\s|[.,!:;)])/i;
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
  static async makeKey(fields) {
    const promptVersion = String(
      fields.promptVersion === undefined ? FILTER_PROMPT_VERSION : fields.promptVersion,
    );
    const model = String(fields.model);
    const tokenLimit = String(
      fields.maxOutputTokens === undefined ? DEFAULT_FILTER_MAX_OUTPUT_TOKENS : fields.maxOutputTokens,
    );
    const effort = fields.reasoningEffort == null || fields.reasoningEffort === undefined
      ? ''
      : String(fields.reasoningEffort);
    const task = String(fields.task ?? fields.intent ?? '');
    const path = String(fields.path);
    const mode = fields.mode == null || fields.mode === undefined ? 'full' : String(fields.mode);
    const note = fields.note == null || fields.note === undefined ? '' : String(fields.note);
    const content = String(fields.content);
    return sha256(lengthPrefixed([
      promptVersion, model, tokenLimit, effort, task, path, mode, note, content,
    ]));
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
 * Browsers and Node 19+ expose Web Crypto as `globalThis.crypto`. Node 18
 * keeps the same API on `node:crypto` as `webcrypto`. That module is imported
 * only when the global is missing, so this file still loads in the browser.
 * @returns {Promise<{ subtle: { digest: Function } }>}
 */
async function getWebCrypto() {
  const exposed = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (exposed && exposed.subtle) return exposed;
  try {
    const mod = await import('node:crypto');
    if (mod.webcrypto && mod.webcrypto.subtle) return /** @type {{ subtle: { digest: Function } }} */ (mod.webcrypto);
  } catch {
    // A browser without `globalThis.crypto`, or a host that cannot load node:crypto.
  }
  throw new Error('Web Crypto (crypto.subtle) is required to hash relevance cache keys.');
}

/**
 * Length-prefixed UTF-8 encoding shared with the Python filter.
 * Each part is `decimalByteLength + ":" + utf8 + "\\n"`.
 * @param {string[]} parts
 * @returns {Uint8Array}
 */
function lengthPrefixed(parts) {
  const encoder = new TextEncoder();
  const encoded = parts.map((part) => encoder.encode(part));
  let size = 0;
  for (const bytes of encoded) size += String(bytes.length).length + 1 + bytes.length + 1;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const bytes of encoded) {
    const header = encoder.encode(`${bytes.length}:`);
    out.set(header, offset);
    offset += header.length;
    out.set(bytes, offset);
    offset += bytes.length;
    out[offset] = 0x0a;
    offset += 1;
  }
  return out;
}

/**
 * @param {string | Uint8Array} data
 * @returns {Promise<string>} hex SHA-256
 */
async function sha256(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const webcrypto = await getWebCrypto();
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
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
 * Strip a leading `Answer:` / `Decision:` prefix and surrounding quotes,
 * markdown bold, and backticks. Repeats so `Answer: **yes**` unwraps fully.
 * @param {string} text
 * @returns {string}
 */
function unwrapAnswerWrappers(text) {
  let value = text.trim();
  for (let i = 0; i < 8; i++) {
    const next = value.replace(LEADING_WRAPPER, '').replace(TRAILING_WRAPPER, '').trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

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
  const cleaned = text.trim();
  const unwrapped = unwrapAnswerWrappers(cleaned);
  if (!unwrapped) return { decision: null, cleaned };
  const match = YES_NO_TOKEN.exec(unwrapped);
  if (!match) return { decision: null, cleaned };
  return { decision: /** @type {'yes' | 'no'} */ (match[1].toLowerCase()), cleaned };
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
 * Code-point stand-in for a tokenizer. Empty text is 0. Otherwise
 * `ceil(codePoints / 4)`. A surrogate pair counts as one code point.
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  if (text == null || text === '') return 0;
  const codePoints = Array.from(String(text)).length;
  if (!codePoints) return 0;
  return Math.ceil(codePoints / 4);
}

/**
 * First `count` Unicode code points. Never splits a surrogate pair.
 * @param {string} text
 * @param {number} count
 * @returns {string}
 */
function takeCodePoints(text, count) {
  if (count <= 0) return '';
  return Array.from(text).slice(0, count).join('');
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
    out = takeCodePoints(out, maxTokens * 4);
  }
  if (maxBytes) out = truncateUtf8(out, maxBytes);
  return out;
}

/**
 * UTF-8 prefix cut on a code-point boundary. Never emits U+FFFD: a character
 * that does not fit entirely inside `maxBytes` is dropped.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateUtf8(text, maxBytes) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes || maxBytes <= 0) return maxBytes <= 0 ? '' : text;
  let end = maxBytes;
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const leadIndex = end - 1;
    const lead = bytes[leadIndex];
    const need = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    const have = maxBytes - leadIndex;
    if (have < need) end = leadIndex;
    else end = leadIndex + need;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
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
  return binaryBytes(utf8Prefix(content, 8192));
}

/**
 * First `maxBytes` UTF-8 bytes of `text`, which may end on an incomplete
 * code point when the next character does not fit.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {Uint8Array}
 */
function utf8Prefix(text, maxBytes) {
  const encoder = new TextEncoder();
  /** @type {number[]} */
  const out = [];
  let n = 0;
  for (const ch of text) {
    if (n >= maxBytes) break;
    const bytes = encoder.encode(ch);
    for (const byte of bytes) out.push(byte);
    n += bytes.length;
  }
  return Uint8Array.from(out).subarray(0, maxBytes);
}

/**
 * @param {number} lead
 * @returns {number} expected sequence length, or 0 when `lead` cannot start one
 */
function utf8SequenceLength(lead) {
  if (lead <= 0x7f) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/**
 * Decode `sample` as UTF-8. An incomplete trailing sequence of at most 3
 * bytes is dropped. Genuinely invalid bytes return null.
 * @param {Uint8Array} sample
 * @returns {string | null}
 */
function decodeUtf8AllowingShortTail(sample) {
  const fatal = () => new TextDecoder('utf-8', { fatal: true });
  try {
    return fatal().decode(sample);
  } catch {
    // The sample is not well-formed. A cut at 8192 may end inside one character.
  }
  let index = sample.length - 1;
  let continuations = 0;
  while (continuations < 3 && index >= 0 && (sample[index] & 0xc0) === 0x80) {
    continuations += 1;
    index -= 1;
  }
  if (index < 0) return null;
  const need = utf8SequenceLength(sample[index]);
  const have = sample.length - index;
  if (!need || have >= need || need - have > 3 || continuations !== have - 1) return null;
  try {
    return fatal().decode(sample.subarray(0, index));
  } catch {
    return null;
  }
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
  const text = decodeUtf8AllowingShortTail(sample);
  if (text == null) return true;
  if (sample.length > 0 && text === '') return true;
  return textLooksBinary(text);
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
    const text = decodeUtf8AllowingShortTail(content);
    if (text != null) return text;
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
    failedOpen: !!fields.failedOpen,
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
    failedOpen: !!(rec.failed_open ?? rec.failedOpen),
  });
}

/**
 * @param {string} path
 * @param {'yes' | 'no'} decision
 * @param {'binary' | 'oversize' | 'ignored'} skippedReason
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
 * @param {string} path
 * @param {string} body
 * @param {string | null} note
 * @returns {string}
 */
function buildUserPrompt(task, path, body, note) {
  const parts = [`Task:\n${task}`, `File path:\n${path}`];
  if (note) parts.push(note);
  parts.push(`File contents:\n${body}`);
  parts.push('Is this file relevant to the task? yes/no');
  return parts.join('\n\n');
}

/**
 * A response that is not a chat-completion envelope. The caller fails that
 * file open and does not retry it.
 * @param {string} detail
 * @returns {Error}
 */
function envelopeError(detail) {
  const err = new Error(detail);
  /** @type {{ envelope?: boolean }} */ (err).envelope = true;
  return err;
}

/**
 * @param {unknown} response
 * @returns {{ raw: string, promptTokens: number, completionTokens: number, tokens: number }}
 */
function usageAndText(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw envelopeError('relevance response was not JSON');
  }
  const body = /** @type {{ choices?: unknown, usage?: Record<string, number> }} */ (response);
  if (!Array.isArray(body.choices) || body.choices.length === 0) {
    throw envelopeError('relevance response envelope was incomplete');
  }
  const message = /** @type {{ message?: { content?: unknown } }} */ (body.choices[0]).message;
  if (!message || message.content == null) {
    throw envelopeError('relevance response envelope was incomplete');
  }
  const content = typeof message.content === 'string' ? message.content : String(message.content);
  const usage = body.usage || {};
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const tokens = Number(usage.total_tokens ?? (promptTokens + completionTokens));
  return {
    raw: content,
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
 * Timeouts and HTTP 5xx (including 503). Other failures fail open immediately.
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientFilterError(err) {
  const status = err && typeof err === 'object'
    ? (/** @type {{ status?: number, statusCode?: number }} */ (err).status
      ?? /** @type {{ statusCode?: number }} */ (err).statusCode)
    : undefined;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  const code = err && typeof err === 'object'
    ? (/** @type {{ code?: string, cause?: { code?: string } }} */ (err).code
      || /** @type {{ cause?: { code?: string } }} */ (err).cause?.code)
    : undefined;
  if (typeof code === 'string' && /^(ETIMEDOUT|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/.test(code)) {
    return true;
  }
  const name = err && typeof err === 'object' ? /** @type {{ name?: string }} */ (err).name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const message = errorMessage(err);
  if (/timeout|timed out/i.test(message)) return true;
  if (/\b5\d\d\b/.test(message)) return true;
  if (/billing reservation/i.test(message)) return true;
  return false;
}

/**
 * A 4xx that names `reasoning_effort`. The filter retries that call once
 * without the parameter.
 * @param {unknown} err
 * @returns {boolean}
 */
function isReasoningEffortRejected(err) {
  const message = errorMessage(err);
  if (!/reasoning[_ ]effort/i.test(message)) return false;
  const status = err && typeof err === 'object'
    ? (/** @type {{ status?: number, statusCode?: number }} */ (err).status
      ?? /** @type {{ statusCode?: number }} */ (err).statusCode)
    : undefined;
  if (typeof status === 'number') return status >= 400 && status < 500;
  return /\b4\d\d\b/.test(message);
}

/**
 * @param {unknown} err
 */
function logCacheError(err) {
  const message = errorMessage(err);
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`relevance cache error: ${message}`);
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function resolveRetries(value) {
  if (value === undefined) return 2;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) throw new Error('retries must be >= 0');
  return n;
}

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  const src = pattern.replace(/\\/g, '/').toLowerCase();
  while (i < src.length) {
    if (src.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (src.startsWith('**', i)) {
      re += '.*';
      i += 2;
      continue;
    }
    const ch = src[i];
    if (ch === '*') re += '[^/]*';
    else {
      if (/[\\^$+?.()|{}[\]]/.test(ch)) re += '\\';
      re += ch;
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {string} filePath
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function isIgnoredPath(filePath, patterns = DEFAULT_IGNORE_PATTERNS) {
  const normalized = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

/**
 * @param {unknown} ignore
 * @returns {string[]}
 */
function resolveIgnore(ignore) {
  if (ignore === false || ignore === null) return [];
  if (ignore === undefined || ignore === true) return DEFAULT_IGNORE_PATTERNS;
  if (Array.isArray(ignore)) return ignore.map(String);
  throw new TypeError('ignore must be true, false, or an array of patterns');
}

/**
 * Included without a definitive yes/no: a thrown call, an empty answer, or an
 * ambiguous answer.
 * @param {RelevanceDecision} decision
 * @returns {boolean}
 */
function isFailedOpen(decision) {
  if (!decision) return false;
  if (decision.failedOpen) return true;
  if (decision.error) return true;
  return typeof decision.reason === 'string' && (
    decision.reason.startsWith('ambiguous answer; included by default')
    || decision.reason.startsWith('malformed answer; included by default')
  );
}

/**
 * A stored judgment is reusable only when it is a definitive yes or no.
 * Fallbacks and errors are not, even if an older cache file still holds them.
 * @param {RelevanceCacheRecord | undefined} hit
 * @returns {boolean}
 */
function reusableHit(hit) {
  if (!hit || (hit.decision !== 'yes' && hit.decision !== 'no') || hit.error) return false;
  if (hit.failed_open || /** @type {{ failedOpen?: boolean }} */ (hit).failedOpen) return false;
  const reason = hit.reason || '';
  if (
    reason.startsWith('ambiguous answer')
    || reason.startsWith('malformed answer')
    || reason.startsWith('error; included by default')
  ) return false;
  return true;
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
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
  const reasoningEffort = opts.reasoningEffort === undefined
    ? DEFAULT_FILTER_REASONING_EFFORT
    : opts.reasoningEffort;
  const retries = resolveRetries(opts.retries);
  const retryBaseMs = opts.retryBaseMs === undefined ? 200 : Math.max(0, Number(opts.retryBaseMs) || 0);
  const ignorePatterns = resolveIgnore(opts.ignore);

  const model = resolveFilterModel(opts.model);
  const store = resolveCache(opts.cache);
  const callLlm = opts.callLlm || defaultCallLlm;
  const apiKey = opts.apiKey == null ? resolveApiKey(undefined) : opts.apiKey;
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const onDecision = opts.onDecision;

  /** @type {Map<string, RelevanceDecision>} */
  const byPath = new Map();
  /**
   * @typedef {object} PendingFile
   * @property {string} path
   * @property {string} body content sent to the model
   * @property {string} note exact preview note, or ""
   * @property {'full' | 'truncated' | 'binary'} mode
   * @property {'truncated' | null} skippedReason
   */
  /** @type {PendingFile[]} */
  const pending = [];
  const entries = Object.entries(files);

  /**
   * @param {RelevanceDecision} decision
   * @returns {RelevanceDecision}
   */
  function emit(decision) {
    if (typeof onDecision === 'function') onDecision(decision);
    return decision;
  }

  for (const [path, content] of entries) {
    if (isIgnoredPath(path, ignorePatterns)) {
      const made = skipDecision(
        path,
        'no',
        'ignored',
        'lockfile or generated file; excluded without a model call',
      );
      byPath.set(path, made);
      emit(made);
      continue;
    }

    let binary = isBinaryContent(content);
    /** @type {string} */
    let text = '';
    if (!binary) {
      text = coerceText(content);
      if (content instanceof Uint8Array && content.length > 0 && text === '') binary = true;
    }
    if (binary) {
      if (onBinary === 'truncate') {
        const nbytes = content instanceof Uint8Array
          ? content.length
          : utf8ByteLength(typeof content === 'string' ? content : text);
        const note = 'Note: this file is binary. Its bytes are not shown; judge relevance from the path and this note.';
        const body = `[binary file, ${nbytes} bytes, contents omitted]`;
        pending.push({ path, body, note, mode: 'binary', skippedReason: 'truncated' });
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
        pending.push({ path, body, note, mode: 'truncated', skippedReason: 'truncated' });
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

    pending.push({ path, body: text, note: '', mode: 'full', skippedReason: null });
  }

  if (store && typeof store.load === 'function') {
    try {
      await store.load();
    } catch (err) {
      logCacheError(err);
    }
  }

  /**
   * @param {string} key
   * @returns {Promise<RelevanceCacheRecord | undefined>}
   */
  async function readCache(key) {
    if (!store) return undefined;
    try {
      return await cacheGet(store, key);
    } catch (err) {
      logCacheError(err);
      return undefined;
    }
  }

  const configuredEffort = reasoningEffort || null;

  /**
   * Key for a lookup before the call, using the configured reasoning effort.
   * @param {PendingFile} item
   * @param {string | null} effort
   * @returns {Promise<string>}
   */
  function keyFor(item, effort) {
    return RelevanceCache.makeKey({
      model,
      intent: task,
      path: item.path,
      content: item.body,
      mode: item.mode,
      note: item.note || '',
      maxOutputTokens,
      reasoningEffort: effort,
      promptVersion: FILTER_PROMPT_VERSION,
    });
  }

  /**
   * The configured effort is tried first. A judgment stored after the
   * provider rejected that parameter lives under the empty effort.
   * @param {PendingFile} item
   * @returns {Promise<{ hit: RelevanceCacheRecord, key: string } | null>}
   */
  async function loadReusable(item) {
    const primaryKey = await keyFor(item, configuredEffort);
    const primary = await readCache(primaryKey);
    if (primary && reusableHit(primary)) return { hit: primary, key: primaryKey };
    if (configuredEffort) {
      const fallbackKey = await keyFor(item, null);
      const fallback = await readCache(fallbackKey);
      if (fallback && reusableHit(fallback)) return { hit: fallback, key: fallbackKey };
    }
    return null;
  }

  let needsCall = false;
  for (const item of pending) {
    if (!(await loadReusable(item))) {
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
   * @param {PendingFile} item
   * @returns {Promise<void>}
   */
  async function runOne(item) {
    const cached = await loadReusable(item);
    if (cached) {
      const decision = decisionFromRecord(item.path, { ...cached.hit, cache_key: cached.key }, true);
      byPath.set(item.path, decision);
      emit(decision);
      return;
    }

    let raw;
    let promptTokens;
    let completionTokens;
    let totalTokens;
    /** @type {unknown} */
    let lastError = null;
    /** @type {string | null} */
    let effortUsed = configuredEffort;
    const userPrompt = buildUserPrompt(task, item.path, item.body, item.note);
    let userContent = userPrompt;
    if (model && model.includes('gemini')) userContent = `${SYSTEM_PROMPT}\n${userPrompt}`;
    const attempts = retries + 1;
    let strippedEffort = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
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
          reasoningEffort: effortUsed,
          maxRetries: 0,
        });
        ({ raw, promptTokens, completionTokens, tokens: totalTokens } = usageAndText(response));
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (err && typeof err === 'object' && /** @type {{ envelope?: boolean }} */ (err).envelope) {
          break;
        }
        if (!strippedEffort && effortUsed && isReasoningEffortRejected(err)) {
          effortUsed = null;
          strippedEffort = true;
          attempt -= 1;
          continue;
        }
        const again = attempt + 1 < attempts && isTransientFilterError(err);
        if (!again) break;
        const wait = Math.min(retryBaseMs * 2 ** attempt, 30_000);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    if (lastError) {
      const message = errorMessage(lastError);
      const decision = decisionObject({
        path: item.path,
        decision: 'yes',
        reason: `error; included by default: ${message}`,
        raw: null,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cached: false,
        skippedReason: item.skippedReason,
        error: message,
        failedOpen: true,
      });
      byPath.set(item.path, decision);
      emit(decision);
      return;
    }

    const parsed = parseRelevanceAnswer(raw);
    /** @type {'yes' | 'no'} */
    let decisionName;
    /** @type {string} */
    let reason;
    /** @type {string | null} */
    let error = null;
    let cacheable = false;
    let failedOpen = false;
    if (parsed.decision == null && !parsed.cleaned) {
      decisionName = 'yes';
      error = 'empty answer';
      reason = `error; included by default: ${error}`;
      failedOpen = true;
    } else if (parsed.decision == null) {
      decisionName = 'yes';
      reason = `malformed answer; included by default: ${parsed.cleaned}`;
      failedOpen = true;
    } else {
      decisionName = parsed.decision;
      reason = parsed.cleaned;
      cacheable = true;
    }
    const storeKey = await keyFor(item, effortUsed);
    if (store && cacheable) {
      /** @type {RelevanceCacheRecord} */
      const record = {
        decision: decisionName,
        reason,
        raw,
        tokens: totalTokens,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        skipped_reason: item.skippedReason,
        error: null,
        cache_key: storeKey,
        failed_open: false,
      };
      try {
        await cachePut(store, storeKey, record);
      } catch (err) {
        logCacheError(err);
      }
    }
    const decision = decisionObject({
      path: item.path,
      decision: decisionName,
      reason,
      raw,
      tokens: totalTokens,
      promptTokens,
      completionTokens,
      cached: false,
      skippedReason: item.skippedReason,
      error,
      failedOpen,
    });
    byPath.set(item.path, decision);
    emit(decision);
  }

  try {
    await mapLimit(pending, concurrency, runOne);
  } finally {
    if (store && typeof store.flush === 'function') {
      try {
        await store.flush();
      } catch (err) {
        logCacheError(err);
      }
    }
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
  const failedOpen = decisions.filter(isFailedOpen).length;
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
    failedOpen,
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
  const failedOpen = Number.isFinite(result.failedOpen)
    ? result.failedOpen
    : result.decisions.filter(isFailedOpen).length;
  let line = `Relevance filter (${result.model}): kept ${kept}/${total} files, ${result.billedTokens} tokens`;
  if (errorCount) line += `, ${errorCount} error${errorCount === 1 ? '' : 's'}`;
  if (failedOpen) line += `, ${failedOpen} failed open`;
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
    failedOpen: result.failedOpen,
    errors: result.errors,
  };
  await fs.writeFile(destination, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

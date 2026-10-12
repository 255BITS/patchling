/**
 * gptdiff-js core: generateDiff + smartapply.
 *
 * A browser-first port of the gptdiff Python package, scoped to the two main
 * APIs. LLM access is injectable (`opts.callLlm` / `opts.callLlmForApply`) so
 * the logic is fully unit-testable without network access.
 */

import {
  parseDiffPerFile,
  applyPatchToFile,
  applyAdaptedIdentifiers,
  applyIntentIgnoringBadContext,
  diffOutputViolatesIntent,
} from './applydiff.js';
import {
  swallowReasoning,
  stripBadOutput,
  stripThinkTags,
  extractDiffBlocks,
} from './text.js';
import {
  callLlm as defaultCallLlm,
  resolveApiKey,
  resolveBaseUrl,
} from './llm.js';
import { getEnv, DEFAULT_MODEL } from './env.js';

const DIFF_TOOL_PROMPT = `Save the calculated diff as used in 'git apply'. Should include the file and line number. For example:
\`\`\`diff
a/file.py b/file.py
--- a/file.py
+++ b/file.py
@@ -1,2 +1,2 @@
-def old():
+def new():
\`\`\`

You must include the '--- file' and/or '+++ file' part of the diff. File modifications should include both.
`;

const APPLY_SYSTEM_PROMPT = `Please apply the diff to this file. Return the full file contents.

1. Apply ONLY the changed lines. A line beginning with '-' is removed and a line beginning with '+' is inserted. Those are the only edits you may make.
2. Context lines (a leading space, or a bare line that is not '+' or '-') are location hints and are often wrong: wrong whitespace, stale values, or ellipsis ("..."). Never copy a context line from the diff into the file. If a context line does not already match the file exactly, keep the file's original line character for character.
3. Do not delete, rewrite, reorder, or drop any line the diff does not remove with a '-' line. Lines the diff never mentions, including lines before and after the hunk, must be preserved verbatim.
4. Only return the final file content. Do not add any additional markup and do not add a code block.
5. You must return the entire file. It overwrites the existing file.`;

/**
 * Decisions from `filterRelevant`, or a bare array of them.
 * `null` means "include every file" (the default).
 * @param {object | Array<{ path?: string, decision?: string }> | undefined} opts
 * @returns {Array<{ path?: string, decision?: string }> | null}
 */
function decisionsFrom(opts) {
  if (!opts) return null;
  if (Array.isArray(opts)) return opts;
  if (Array.isArray(opts.decisions)) return opts.decisions;
  return null;
}

/**
 * Rebuild the environment string from a `{ path: content }` map.
 *
 * Opt-in relevance filter: pass `{ decisions }` from `filterRelevant` and
 * only files whose decision is `"yes"` are included. An array of those
 * decisions is also accepted as the second argument. Omit it and every file
 * is included, in insertion order. Every other file stays out of the
 * string that `generateDiff` sees.
 *
 * @param {Record<string, string>} filesDict
 * @param {{ decisions?: Array<{ path?: string, decision?: string }> } | Array<{ path?: string, decision?: string }>} [opts]
 *   `{ decisions }` from `filterRelevant`, or that array itself.
 * @returns {string}
 */
export function buildEnvironment(filesDict, opts) {
  let entries = Object.entries(filesDict || {});
  const decisions = decisionsFrom(opts);
  if (decisions) {
    const yes = new Set();
    for (const decision of decisions) {
      if (decision && decision.decision === 'yes' && decision.path) yes.add(decision.path);
    }
    entries = entries.filter(([path]) => yes.has(path));
  }
  const env = [];
  for (const [path, content] of entries) {
    env.push(`File: ${path}`);
    env.push('Content:');
    env.push(content);
  }
  return env.join('\n');
}

function resolveModel(model) {
  return model || getEnv('GPTDIFF_MODEL', DEFAULT_MODEL) || DEFAULT_MODEL;
}

function usageFrom(response) {
  const usage = response && response.usage;
  if (!usage) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * Build the prompt, call the LLM, and extract the unified diff from the
 * ```diff fenced blocks of the response.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {string} filesContent
 * @param {string} model
 * @param {object} [opts]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.budgetTokens]
 * @param {Array} [opts.images]
 * @param {(text: string) => void} [opts.onToken] stream callback, called per content delta
 * @param {Function} [opts.callLlm]
 * @returns {Promise<{ fullResponse: string, diff: string, promptTokens: number,
 *   completionTokens: number, totalTokens: number }>}
 */
export async function callLlmForDiff(systemPrompt, userPrompt, filesContent, model, opts = {}) {
  const {
    temperature = 1.0,
    maxTokens = null,
    apiKey,
    baseUrl,
    budgetTokens = null,
    images = null,
    onToken = null,
    callLlm = defaultCallLlm,
  } = opts;

  const fullSystemPrompt = systemPrompt + '\n' + DIFF_TOOL_PROMPT;

  let effectiveUserPrompt = userPrompt;
  if (model && model.includes('gemini')) {
    effectiveUserPrompt = fullSystemPrompt + '\n' + userPrompt;
  }

  const userText = effectiveUserPrompt + '\n' + filesContent;
  /** @type {string | Array<{type: string, text?: string, image_url?: {url: string}}>} */
  let userContent = userText;
  if (images && images.length) {
    /** @type {Array<{type: string, text?: string, image_url?: {url: string}}>} */
    const blocks = [{ type: 'text', text: userText }];
    for (const image of images) {
      const dataUrl = `data:${image.media_type};base64,${image.data}`;
      blocks.push({ type: 'image_url', image_url: { url: dataUrl } });
    }
    userContent = blocks;
  }

  const messages = [
    { role: 'system', content: fullSystemPrompt },
    { role: 'user', content: userContent },
  ];

  const response = await callLlm({
    apiKey: resolveApiKey(apiKey),
    baseUrl: resolveBaseUrl(baseUrl),
    model,
    messages,
    maxTokens,
    temperature,
    budgetTokens,
    onToken,
  });

  const { promptTokens, completionTokens, totalTokens } = usageFrom(response);

  let fullResponse = (response.choices[0].message.content || '').trim();
  const [stripped] = swallowReasoning(fullResponse);
  fullResponse = stripped;

  const diff = extractDiffBlocks(fullResponse).join('\n');

  return { fullResponse, diff, promptTokens, completionTokens, totalTokens };
}

/**
 * Generate a git diff from an environment string and a goal.
 *
 * @param {string} environment  the codebase as a string (see buildEnvironment)
 * @param {string} goal         natural-language instruction
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.prepend]    text prepended to the system prompt
 * @param {number} [opts.budgetTokens]
 * @param {Array}  [opts.images]
 * @param {(text: string) => void} [opts.onToken] stream callback — when
 *   provided, the LLM response is streamed and this is called once per token
 *   (content delta) as it arrives. Tokens are the raw model output (which may
 *   include prose around the ```diff block); the resolved value is still the
 *   extracted diff.
 * @param {Function} [opts.callLlm]  injectable LLM client (for testing)
 * @param {(usage: { promptTokens: number, completionTokens: number,
 *   totalTokens: number }) => void} [opts.onUsage]  optional callback invoked
 *   with token usage after the LLM call completes, so callers can surface
 *   cost/usage without changing the return type of this function.
 * @returns {Promise<string>} the unified diff text
 */
export async function generateDiff(environment, goal, opts = {}) {
  const model = resolveModel(opts.model);
  const prepend = opts.prepend ? opts.prepend + '\n' : '';
  const systemPrompt = prepend + 'Output a full unified git diff into a "```diff" block.';

  const { diff, promptTokens, completionTokens, totalTokens } = await callLlmForDiff(
    systemPrompt,
    goal,
    environment,
    model,
    {
      temperature: opts.temperature ?? 1.0,
      // No default cap: let the model emit its full diff (avoids silent truncation
      // that produces an unparseable diff). Callers may still pass an explicit maxTokens.
      maxTokens: opts.maxTokens ?? null,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      budgetTokens: opts.budgetTokens ?? null,
      images: opts.images ?? null,
      onToken: opts.onToken ?? null,
      callLlm: opts.callLlm,
    },
  );

  if (typeof opts.onUsage === 'function') {
    opts.onUsage({ promptTokens, completionTokens, totalTokens });
  }

  return diff;
}

/**
 * AI-powered application of a single-file diff. Returns the full LLM response
 * (before think/reasoning stripping).
 *
 * @param {string} filePath
 * @param {string} originalContent
 * @param {string} fileDiff
 * @param {string} model
 * @param {object} [opts]
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.extraPrompt] appended to the user prompt
 * @param {number} [opts.maxTokens]
 * @param {(text: string) => void} [opts.onToken] stream callback, called once
 *   per token of the rewritten file as it arrives. Note the streamed text is
 *   the raw model output — `<think>` blocks are only stripped from the final
 *   result by {@link callLlmForApplyWithThink}.
 * @param {Function} [opts.callLlm] injectable LLM client (for testing)
 * @returns {Promise<string>}
 */
export async function callLlmForApply(filePath, originalContent, fileDiff, model, opts = {}) {
  const {
    apiKey,
    baseUrl,
    extraPrompt = null,
    maxTokens = null,
    onToken = null,
    callLlm = defaultCallLlm,
  } = opts;

  let userPrompt = `File: ${filePath}
File contents:
\`\`\`
${originalContent}
\`\`\`

Diff to apply:
\`\`\`diff
${fileDiff}
\`\`\``;
  userPrompt += `

Apply only the '-' and '+' lines. Context lines may be wrong; never copy them into the file, and do not delete or rewrite any line the diff does not remove.`;
  if (extraPrompt) userPrompt += `\n\n${extraPrompt}`;
  if (model && model.includes('gemini')) {
    userPrompt = APPLY_SYSTEM_PROMPT + '\n' + userPrompt;
  }

  const messages = [
    { role: 'system', content: APPLY_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const response = await callLlm({
    apiKey: resolveApiKey(apiKey),
    baseUrl: resolveBaseUrl(baseUrl),
    model,
    messages,
    maxTokens,
    temperature: 0.0,
    onToken,
  });
  return response.choices[0].message.content;
}

/**
 * Apply a diff to a single file's content, stripping `<think>` blocks and
 * reasoning preambles from the LLM response.
 *
 * @param {string} filePath
 * @param {string} originalContent
 * @param {string} fileDiff
 * @param {string} model
 * @param {object} [opts]
 * @returns {Promise<string>} the cleaned file content
 */
export async function callLlmForApplyWithThink(filePath, originalContent, fileDiff, model, opts = {}) {
  const applyFn = opts.callLlmForApply || callLlmForApply;
  const fullResponse = await applyFn(filePath, originalContent, fileDiff, model, opts);
  return stripThinkTags(fullResponse);
}

/**
 * Apply unified diffs to a map of file contents. Handles creations,
 * modifications, and deletions. Returns a new map (the input is not mutated).
 * Deleted files are omitted.
 *
 * Each file is processed in parallel. By default, every file is first applied
 * deterministically (no LLM call) via {@link applyPatchToFile}; only files
 * whose patch does not apply cleanly fall back to AI-powered conflict
 * resolution. Set `opts.forceLlm` to skip the deterministic fast path and send
 * every file to the LLM.
 *
 * When the diff's context lines are not in the file, the model result is
 * checked against the diff's `+`/`-` lines. An indentation shift, or a hunk
 * that matches somewhere other than its `@@` line, still counts as context.
 * A diff name that pairs with a different name already in the file
 * (`user_id` beside `uid`) is rewritten onto the file's name before any
 * model call. A result that copies stale context, deletes any other line,
 * or is empty is discarded. The same edit is then replayed from the `+`/`-`
 * lines (at the file's indent, with those names); if that cannot be done
 * without guessing, this throws instead of writing the file.
 *
 * @param {string} diffText
 * @param {Record<string, string>} files
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.maxTokens]
 * @param {boolean} [opts.forceLlm] skip the deterministic fast path
 * @param {(text: string, path: string) => void} [opts.onToken] stream
 *   callback for LLM-resolved files. Files are processed concurrently, so
 *   token calls for different files interleave; the second argument is the
 *   file path the token belongs to, letting callers demultiplex. Files taken
 *   by the deterministic fast path emit no tokens (no LLM call is made).
 * @param {Function} [opts.callLlmForApply] injectable single-file applier
 * @returns {Promise<Record<string, string>>}
 */
export async function smartapply(diffText, files, opts = {}) {
  const model = resolveModel(opts.model);
  const parsedDiffs = parseDiffPerFile(diffText);
  const result = { ...files };

  const applyOpts = {
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    maxTokens: opts.maxTokens,
    callLlmForApply: opts.callLlmForApply,
  };

  await Promise.all(
    parsedDiffs.map(async ([path, patch]) => {
      const original = Object.prototype.hasOwnProperty.call(result, path) ? result[path] : '';
      if (patch.includes('+++ /dev/null')) {
        delete result[path];
        return;
      }
      // Fast path: try to apply the patch deterministically, no LLM call.
      // A clean hunk wins first. A rename that the diff's context already
      // reveals (`user_id` in the hunk, `uid` in the file) is applied from
      // the +/- lines alone, so the model cannot leave the diff's name behind.
      if (!opts.forceLlm) {
        const deterministic = applyPatchToFile(original, patch)
          ?? applyAdaptedIdentifiers(original, patch);
        if (deterministic !== null) {
          result[path] = deterministic;
          return;
        }
      }
      // Fallback: the patch did not apply cleanly, let the LLM resolve it.
      // Bind the file path into the stream callback so concurrent per-file
      // streams can be told apart by the caller: onToken(text, path).
      const fileOpts = opts.onToken
        ? { ...applyOpts, onToken: (text) => opts.onToken(text, path) }
        : applyOpts;
      const updated = await callLlmForApplyWithThink(path, original, patch, model, fileOpts);
      const cleaned = stripBadOutput(updated, original);
      if (!diffOutputViolatesIntent(original, cleaned, patch)) {
        result[path] = cleaned;
        return;
      }
      // The model copied stale context or edited a line the diff did not
      // add or remove. Replay only the +/- lines, or refuse the write.
      const intent = applyIntentIgnoringBadContext(original, patch);
      if (intent == null || diffOutputViolatesIntent(original, intent, patch)) {
        throw new Error(
          `smartapply: refusing to write ${JSON.stringify(path)}: the model changed lines the diff did not add or remove`,
        );
      }
      result[path] = intent;
    }),
  );

  return result;
}

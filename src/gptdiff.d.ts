/**
 * Rebuild the environment string from a `{ path: content }` map.
 * @param {Record<string, string>} filesDict
 * @returns {string}
 */
export function buildEnvironment(filesDict: Record<string, string>): string;
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
export function callLlmForDiff(systemPrompt: string, userPrompt: string, filesContent: string, model: string, opts?: {
    temperature?: number;
    maxTokens?: number;
    apiKey?: string;
    baseUrl?: string;
    budgetTokens?: number;
    images?: any[];
    onToken?: (text: string) => void;
    callLlm?: Function;
}): Promise<{
    fullResponse: string;
    diff: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}>;
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
export function generateDiff(environment: string, goal: string, opts?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    apiKey?: string;
    baseUrl?: string;
    prepend?: string;
    budgetTokens?: number;
    images?: any[];
    onToken?: (text: string) => void;
    callLlm?: Function;
    onUsage?: (usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    }) => void;
}): Promise<string>;
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
export function callLlmForApply(filePath: string, originalContent: string, fileDiff: string, model: string, opts?: {
    apiKey?: string;
    baseUrl?: string;
    extraPrompt?: string;
    maxTokens?: number;
    onToken?: (text: string) => void;
    callLlm?: Function;
}): Promise<string>;
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
export function callLlmForApplyWithThink(filePath: string, originalContent: string, fileDiff: string, model: string, opts?: object): Promise<string>;
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
export function smartapply(diffText: string, files: Record<string, string>, opts?: {
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    maxTokens?: number;
    forceLlm?: boolean;
    onToken?: (text: string, path: string) => void;
    callLlmForApply?: Function;
}): Promise<Record<string, string>>;

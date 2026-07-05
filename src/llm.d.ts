/**
 * Call a chat-completions endpoint.
 *
 * @param {object} opts
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseUrl]
 * @param {string} opts.model
 * @param {Array<object>} opts.messages
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {number} [opts.budgetTokens] Anthropic extended-thinking budget
 * @param {(text: string) => void} [opts.onToken] when provided, the request is
 *   made with `stream: true` and this is called once per content delta as
 *   tokens arrive. The resolved value keeps the exact non-streaming shape
 *   (`{ choices: [{ message: { content } }], usage }`), so callers work
 *   unchanged. Ignored on the Anthropic branch (which stays non-streaming).
 * @param {typeof fetch} [opts.fetchImpl] override for testing
 * @param {number} [opts.maxRetries] retries on transient 429/5xx (default 3)
 * @param {number} [opts.retryBaseMs] base backoff in ms (default 1500, exponential, capped 30s)
 * @returns {Promise<{choices: Array<{message: {content: string}}>, usage: object}>}
 */
export function callLlm({ apiKey, baseUrl, model, messages, maxTokens, temperature, budgetTokens, onToken, fetchImpl, maxRetries, retryBaseMs, }: {
    apiKey?: string;
    baseUrl?: string;
    model: string;
    messages: Array<object>;
    maxTokens?: number;
    temperature?: number;
    budgetTokens?: number;
    onToken?: (text: string) => void;
    fetchImpl?: typeof fetch;
    maxRetries?: number;
    retryBaseMs?: number;
}): Promise<{
    choices: Array<{
        message: {
            content: string;
        };
    }>;
    usage: object;
}>;
/**
 * Resolve the effective API key, preferring an explicit override then the
 * GPTDIFF_LLM_API_KEY environment variable.
 * @param {string} [apiKey]
 * @returns {string | undefined}
 */
export function resolveApiKey(apiKey?: string): string | undefined;
/**
 * Resolve the effective base URL, preferring an explicit override then the
 * GPTDIFF_LLM_BASE_URL environment variable, then the NanoGPT default.
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function resolveBaseUrl(baseUrl?: string): string;
/**
 * @param {string} baseUrl
 * @returns {string}
 */
export function domainForUrl(baseUrl: string): string;

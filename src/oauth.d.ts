/**
 * Base64url-encode an ArrayBuffer or Uint8Array (no padding).
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {string}
 */
export function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string;
/** Generate a high-entropy PKCE code verifier (base64url, 43+ chars). */
export function generateCodeVerifier(byteLength?: number): string;
/**
 * Compute the S256 code challenge for a verifier.
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export function generateCodeChallenge(verifier: string): Promise<string>;
/** Generate a random CSRF `state` value. */
export function generateState(byteLength?: number): string;
/** Generate a complete PKCE pair: `{ verifier, challenge }`. */
export function generatePkce(): Promise<{
    verifier: string;
    challenge: string;
}>;
/**
 * Dynamically register a public client with NanoGPT.
 * @param {object} [opts]
 * @param {string} [opts.clientName]
 * @param {string} [opts.redirectUri]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ client_id: string, [k: string]: any }>}
 */
export function registerClient({ clientName, redirectUri, fetchImpl }?: {
    clientName?: string;
    redirectUri?: string;
    fetchImpl?: typeof fetch;
}): Promise<{
    client_id: string;
    [k: string]: any;
}>;
/**
 * Build the authorization URL the user's browser should be sent to.
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.redirectUri
 * @param {string} [opts.scope]
 * @param {string} opts.state
 * @param {string} opts.codeChallenge
 * @returns {string}
 */
export function buildAuthorizeUrl({ clientId, redirectUri, scope, state, codeChallenge, }: {
    clientId: string;
    redirectUri: string;
    scope?: string;
    state: string;
    codeChallenge: string;
}): string;
/**
 * Exchange an authorization code for an access token.
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.redirectUri
 * @param {string} opts.code
 * @param {string} opts.codeVerifier
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ access_token: string, token_type: string, scope: string }>}
 */
export function exchangeCodeForToken({ clientId, redirectUri, code, codeVerifier, fetchImpl, }: {
    clientId: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
    fetchImpl?: typeof fetch;
}): Promise<{
    access_token: string;
    token_type: string;
    scope: string;
}>;
/**
 * Start the sign-in redirect. Stores the PKCE verifier, state, client_id and
 * redirect_uri in sessionStorage and navigates the browser to NanoGPT.
 *
 * @param {object} opts
 * @param {string} [opts.clientId]  a pre-registered NanoGPT client_id (ngpt_...)
 * @param {string} [opts.redirectUri] defaults to the current page URL
 * @param {string} [opts.scope]
 * @param {boolean} [opts.redirect=true] navigate automatically
 * @returns {Promise<string>} the authorization URL
 */
export function beginSignIn({ clientId, redirectUri, scope, redirect, }?: {
    clientId?: string;
    redirectUri?: string;
    scope?: string;
    redirect?: boolean;
}): Promise<string>;
/**
 * Complete the sign-in after NanoGPT redirects back with `?code=...&state=...`.
 * Validates state, exchanges the code, registers the access token as the
 * GPTDIFF_LLM_API_KEY override, and clears the URL query string.
 *
 * @param {object} [opts]
 * @param {string} [opts.search] query string to parse (defaults to window.location.search)
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<string | null>} the access token, or null if no code present
 */
export function completeSignIn({ search, fetchImpl }?: {
    search?: string;
    fetchImpl?: typeof fetch;
}): Promise<string | null>;
export const NANOGPT_ORIGIN: "https://nano-gpt.com";
export const REGISTER_URL: "https://nano-gpt.com/oauth/register";
export const AUTHORIZE_URL: "https://nano-gpt.com/oauth/authorize";
export const TOKEN_URL: "https://nano-gpt.com/oauth/token";
export const DEFAULT_SCOPE: "api.use models.read";

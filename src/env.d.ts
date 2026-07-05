/**
 * Set an environment-style override (used in the browser where there is no
 * `process.env`). Pass `undefined` to clear an override.
 * @param {string} name
 * @param {string | undefined} value
 */
export function setEnv(name: string, value: string | undefined): void;
/**
 * Read an environment variable. Overrides take precedence over `process.env`.
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string | undefined}
 */
export function getEnv(name: string, fallback?: string): string | undefined;
export const DEFAULT_MODEL: "xiaomi/mimo-v2.5-pro-ultraspeed";
export const DEFAULT_BASE_URL: "https://nano-gpt.com/api/v1/";

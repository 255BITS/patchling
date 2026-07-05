/**
 * Pure text utilities ported from gptdiff's Python implementation.
 *
 * These have no I/O and run identically in the browser and Node.
 */
/**
 * Split a string into lines while keeping the line-ending characters attached,
 * mirroring Python's `str.splitlines(keepends=True)` for `\n`, `\r`, `\r\n`.
 *
 * @param {string} s
 * @returns {string[]}
 */
export function splitLinesKeepEnds(s: string): string[];
/**
 * Split a string into lines WITHOUT keeping line endings, mirroring Python's
 * `str.splitlines()` — notably, a single trailing newline does not produce a
 * trailing empty element.
 *
 * @param {string} s
 * @returns {string[]}
 */
export function splitLines(s: string): string[];
/**
 * Color-code a diff for terminal output: lines starting with '-' in red and
 * lines starting with '+' in green. Other lines are untouched.
 *
 * @param {string} diffText
 * @returns {string}
 */
export function colorCodeDiff(diffText: string): string;
/**
 * Extract and remove the chain-of-thought reasoning block from an LLM response.
 *
 * The reasoning block begins with a line containing "> Reasoning" and ends with
 * a "Reasoned ... seconds" marker. Multiple blocks are supported.
 *
 * @param {string} fullResponse
 * @returns {[string, string]} tuple of [finalContent, reasoning]
 */
export function swallowReasoning(fullResponse: string): [string, string];
/**
 * If the LLM wrapped the file content in a Markdown code fence, unwrap it.
 *
 * Uses line-based fence detection (open on the first ``` line, close on the
 * LAST ``` line) so inner triple-backticks inside the file content do not
 * truncate the result. File content — including a trailing newline — is
 * preserved verbatim.
 *
 * @param {string} updated
 * @param {string} original
 * @returns {string}
 */
export function stripBadOutput(updated: string, original: string): string;
/**
 * Extract the bodies of all ```diff fenced code blocks from `text`.
 * Mirrors the MarkdownParser + "diff" tool collection in the Python source.
 *
 * @param {string} text
 * @returns {string[]} block bodies in document order
 */
export function extractDiffBlocks(text: string): string[];
/**
 * Remove `<think>...</think>` blocks from a response, returning the content
 * outside any think tool. Mirrors call_llm_for_apply_with_think_tool_available.
 *
 * @param {string} response
 * @returns {string}
 */
export function stripThinkTags(response: string): string;

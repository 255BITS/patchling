/**
 * Parse unified diff text into individual per-file patches.
 *
 * Handles file creations (`+++ /dev/null`), deletions (`--- /dev/null` or
 * "deleted file mode"), standard modifications, headerless LLM diffs, and the
 * `*** Begin Patch` / `*** Update File:` delimiter style.
 *
 * @param {string} diffText
 * @returns {Array<[string, string]>} list of [filePath, patch] tuples
 */
export function parseDiffPerFile(diffText: string): Array<[string, string]>;
/**
 * Apply a single-file unified diff patch to `originalContent`.
 *
 * Each hunk is located by matching its context+deletion lines against the
 * original rather than trusting the `@@` line numbers, which LLM-generated
 * diffs frequently get slightly wrong. The `@@` start line is used only as a
 * hint to disambiguate between multiple matching positions. The full block of
 * context and deletion lines must match exactly, so a hunk that does not apply
 * cleanly returns `null` instead of silently corrupting the file.
 *
 * @param {string} originalContent
 * @param {string} patch
 * @returns {string | null} the patched content, or null if the patch fails
 */
export function applyPatchToFile(originalContent: string, patch: string): string | null;
/**
 * Apply a unified diff to an in-memory file map.
 *
 * @param {Record<string, string>} files map of path -> content
 * @param {string} diffText unified diff string
 * @returns {{ changed: boolean, files: Record<string, string> }}
 *   `changed` is true iff at least one file was created, modified, or deleted.
 *   `files` is a new map; on failure it equals the input (no partial changes).
 */
export function applyDiff(files: Record<string, string>, diffText: string): {
    changed: boolean;
    files: Record<string, string>;
};

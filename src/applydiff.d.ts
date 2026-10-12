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
/**
 * Parse the hunks of a single-file patch.
 *
 * Returns null when a body line is ambiguous (`++`, which is either a doubled
 * add marker or a literal line that starts with `+`). A non-standard hunk
 * header such as `@@ ... @@` is kept and anchored at the start of the file.
 * {@link applyPatchToFile} refuses that header instead; this parser exists so
 * a later intent check can still see the `+`/`-` lines.
 *
 * @param {string} patch
 * @returns {Array<{ hint: number, ops: Array<{ kind: string, text: string }> }> | null}
 */
export function parsePatchHunks(patch: string): Array<{
    hint: number;
    ops: Array<{
        kind: string;
        text: string;
    }>;
}> | null;
/**
 * Whether `updatedContent` does something other than apply this diff's
 * `+`/`-` lines to `originalContent`.
 *
 * Armed when a context line does not occur anywhere in the original file —
 * the case where a model copies the diff's stale context in, or drops lines
 * the hunk never removed. A context line that differs only by a uniform
 * indentation shift, or a hunk that matches somewhere other than its `@@`
 * line, still counts as context: the edit is accepted at the file's indent.
 * A result that deletes any other line, or an empty rewrite of a non-empty
 * file, is still a violation.
 *
 * A `-` line that merely fails to match (quotes, whitespace) does not by
 * itself arm the check when every context line is present as written, so a
 * fuzzy model rewrite of that line can still stand.
 *
 * @param {string} originalContent
 * @param {string} updatedContent
 * @param {string} patch
 * @returns {boolean}
 */
export function diffOutputViolatesIntent(originalContent: string, updatedContent: string, patch: string): boolean;
/**
 * Apply only the `+`/`-` lines of a patch, ignoring context lines that are
 * not actually in the file.
 *
 * A context or `-` line may match with a uniform indentation shift, and the
 * hunk may sit somewhere other than the `@@` line. Added lines are written
 * at that same indent. Returns null when a `-` line cannot be found even
 * then, when a pure insertion has no matching context to anchor it, or when
 * a body line is ambiguous. Never writes a context line that was not already
 * in the original.
 *
 * @param {string} originalContent
 * @param {string} patch
 * @returns {string | null}
 */
export function applyIntentIgnoringBadContext(originalContent: string, patch: string): string | null;

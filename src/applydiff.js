/**
 * Diff parsing and in-memory diff application, ported from gptdiff's
 * applydiff.py. The browser has no filesystem, so `applyDiff` operates on a
 * plain `{ path: content }` map instead of a project directory on disk.
 */

import { splitLines } from './text.js';

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
export function parseDiffPerFile(diffText) {
  /**
   * @param {Array<[string, string]>} diffs
   * @returns {Array<[string, string]>}
   */
  const dedupDiffs = (diffs) => {
    const groups = new Map();
    for (const [key, value] of diffs) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(value);
    }
    return Array.from(groups.entries()).map(([key, values]) => /** @type {[string, string]} */ ([key, values.join('\n')]));
  };

  // Special case: handle LLM-style patch delimiters.
  if (diffText.includes('*** Begin Patch')) {
    const lines = splitLines(diffText);
    /** @type {Array<[string, string]>} */
    const diffs = [];
    let currentLines = [];
    let currentFile = null;
    let inPatch = false;
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped === '*** Begin Patch') {
        inPatch = true;
        currentLines = [];
        currentFile = null;
      } else if (stripped === '*** End Patch') {
        if (currentFile !== null) diffs.push([currentFile, currentLines.join('\n')]);
        inPatch = false;
      } else if (inPatch) {
        if (stripped.startsWith('*** Update File:')) {
          currentFile = stripped.split(':').slice(1).join(':').trim();
        } else {
          currentLines.push(line);
        }
      }
    }
    return dedupDiffs(diffs);
  }

  const headerRe = /^(?:diff --git\s+)?(a\/[^ ]+)\s+(b\/[^ ]+)\s*$/;
  const lines = splitLines(diffText);

  // Check if any header line exists.
  if (!lines.some((line) => headerRe.test(line))) {
    // Fallback strategy: detect file headers from '---' / '+++' pairs.
    /** @type {Array<[string, string]>} */
    const diffs = [];
    let currentLines = [];
    let currentFile = null;
    let deletionMode = false;
    let fromHeader = null;
    // File headers tolerate 2-3 markers because LLMs emit malformed `--`/`++`
    // headers. To avoid misreading a hunk body line that deletes/adds content
    // starting with `-`/`+` (e.g. a markdown list item `- [ ] ...` appears as
    // `-- [ ] ...` in the diff) as a new file header, a `---`/`--` line only
    // counts as a from-header when the *next* line is a `+++`/`++` to-header —
    // unified diffs always pair them. A real deletion body line is followed by
    // an ordinary `+`/context line instead, so it stays in the patch body.
    const headerFromRe = /^-{2,3}\s+(.*)$/;
    const headerToRe = /^\+{2,3}\s+(.*)$/;

    const stripPrefix = (p) => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const fromMatch = line.match(headerFromRe);
      const next = idx + 1 < lines.length ? lines[idx + 1] : null;
      const nextTo = next !== null ? next.match(headerToRe) : null;

      if (fromMatch && nextTo) {
        if (currentFile !== null && currentLines.length) {
          if (deletionMode && !currentLines.some((l) => l.startsWith('+++ /dev/null'))) {
            currentLines.push('+++ /dev/null');
          }
          diffs.push([currentFile, currentLines.join('\n')]);
        }
        // Start the new file and consume the paired to-header in one step.
        currentLines = [line, next];
        deletionMode = false;
        currentFile = null;
        fromHeader = fromMatch[1].trim();
        const fileTo = nextTo[1].trim();
        if (fileTo === '/dev/null') {
          deletionMode = true;
          if (fromHeader && fromHeader !== '/dev/null') {
            currentFile = stripPrefix(fromHeader);
          }
        } else {
          currentFile = stripPrefix(fileTo);
        }
        idx += 1; // skip the to-header line we just consumed
        continue;
      }

      currentLines.push(line);
      if (line.includes('deleted file mode')) deletionMode = true;
    }

    if (currentFile !== null && currentLines.length) {
      if (deletionMode && !currentLines.some((l) => l.startsWith('+++ '))) {
        currentLines.push('+++ /dev/null');
      }
      diffs.push([currentFile, currentLines.join('\n')]);
    }
    return dedupDiffs(diffs);
  }

  // Header-based strategy.
  /** @type {Array<[string, string]>} */
  const diffs = [];
  let currentLines = [];
  let currentFile = null;
  let deletionMode = false;
  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      if (currentFile !== null && currentLines.length) {
        if (deletionMode && !currentLines.some((l) => l.startsWith('+++ '))) {
          currentLines.push('+++ /dev/null');
        }
        diffs.push([currentFile, currentLines.join('\n')]);
      }
      currentLines = [line];
      deletionMode = false;
      const fileTo = m[2]; // e.g. "b/index.html"
      currentFile = fileTo.startsWith('b/') ? fileTo.slice(2) : fileTo;
    } else {
      currentLines.push(line);
      if (line.includes('deleted file mode')) deletionMode = true;
      if (line.startsWith('+++ ')) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const fileTo = parts[1].trim();
          if (fileTo !== '/dev/null') {
            currentFile = fileTo.startsWith('a/') || fileTo.startsWith('b/') ? fileTo.slice(2) : fileTo;
          }
        }
      }
    }
  }
  if (currentFile !== null && currentLines.length) {
    if (deletionMode && !currentLines.some((l) => l.startsWith('+++ '))) {
      currentLines.push('+++ /dev/null');
    }
    diffs.push([currentFile, currentLines.join('\n')]);
  }
  return dedupDiffs(diffs);
}

const HUNK_HEADER_RE = /^@@(?: -(\d+)(?:,(\d+))?)?(?: \+(\d+)(?:,(\d+))?)? @@/;

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
export function applyPatchToFile(originalContent, patch) {
  // Work with newline-free lines and re-join with '\n' at the end. This keeps a
  // file's last line (which may lack a trailing newline) on equal footing with
  // the rest, so additions after it do not swallow a blank line.
  const originalLines = splitLines(originalContent || '');
  const patchLines = splitLines(patch);

  // Parse the patch into hunks: { hint, ops: [{ kind, text }] } where kind is
  // 'context' | 'del' | 'add'.
  const hunks = [];
  let i = 0;
  while (i < patchLines.length) {
    const line = patchLines[i];
    if (line.replace(/^\s+/, '').startsWith('@@')) {
      let origStart;
      let declaredNewCount = null;
      if (line.trim() === '@@') {
        origStart = 1;
      } else {
        const m = line.trim().match(HUNK_HEADER_RE);
        if (!m) return null;
        origStart = m[1] !== undefined ? parseInt(m[1], 10) : 1;
        if (m[3] !== undefined) {
          declaredNewCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
        }
      }
      /** @type {Array<{kind: string, text: string, noNewline?: boolean}>} */
      const ops = [];
      i += 1;
      while (i < patchLines.length && !patchLines[i].replace(/^\s+/, '').startsWith('@@')) {
        const pline = patchLines[i];
        if (pline.startsWith('\\')) {
          // "\ No newline at end of file" marker — record it on the op it
          // annotates (the previous body line) so the collapse rule below can
          // recognize git's end-of-file newline-change pattern and the final
          // assembly step knows not to append a trailing newline there.
          if (ops.length) ops[ops.length - 1].noNewline = true;
        } else if (pline.startsWith(' ')) {
          ops.push({ kind: 'context', text: pline.slice(1) });
        } else if (pline.startsWith('++') && !pline.startsWith('+++')) {
          // A `++`-prefixed body line is ambiguous: it may be a malformed
          // double-plus addition (LLM emitted `++foo` meaning "add foo") or a
          // legitimate addition of a line whose content itself starts with
          // `+`. Applying either reading risks silent corruption under the
          // other, so refuse and let the caller fall back to the LLM.
          return null;
        } else if (pline.startsWith('-')) {
          ops.push({ kind: 'del', text: pline.slice(1) });
        } else if (pline.startsWith('+')) {
          ops.push({ kind: 'add', text: pline.slice(1) });
        } else {
          // Bare context line without a leading space (LLM-style).
          ops.push({ kind: 'context', text: pline });
        }
        i += 1;
      }

      // Git's "last line loses its trailing newline" pattern is canonically a
      // del/add pair with identical text plus `\ No newline` markers. Sloppy
      // diffs write the old copy as *context* instead, leaving a trailing
      // `+<line>` that duplicates the last context line:
      //     ` const Retries = 3`      <- kept line
      //     `-const Debug = true`     <- \ No newline at end of file
      //     `+const Retries = 3`      <- \ No newline at end of file
      // Applied literally this duplicates "const Retries = 3". When the final
      // op is such a no-newline add restating the last context line across
      // only deletions, and the @@ header's new-line count confirms the
      // collapsed reading (one line fewer than the literal reading), drop the
      // redundant add — it only re-states the kept line's newline status.
      if (declaredNewCount !== null && ops.length) {
        const last = ops[ops.length - 1];
        if (last.kind === 'add' && last.noNewline) {
          let ctxIdx = -1;
          for (let j = ops.length - 2; j >= 0; j--) {
            if (ops[j].kind === 'context') {
              ctxIdx = j;
              break;
            }
            if (ops[j].kind !== 'del') break; // only deletions may intervene
          }
          if (ctxIdx !== -1 && ctxIdx < ops.length - 2 && ops[ctxIdx].text === last.text) {
            const literalNewCount = ops.filter((o) => o.kind !== 'del').length;
            if (declaredNewCount === literalNewCount - 1) ops.pop();
          }
        }
      }

      hunks.push({ hint: origStart - 1, ops });
    } else {
      i += 1;
    }
  }

  // The lines that must already exist in the original, in order, for a hunk.
  const oldBlockOf = (ops) =>
    ops.filter((o) => o.kind !== 'add').map((o) => o.text);

  // Find where `block` occurs in originalLines at index >= minPos, choosing the
  // occurrence nearest to `hint`. Returns null if there is no exact match.
  const findBlock = (block, minPos, hint) => {
    if (block.length === 0) {
      // Pure-addition hunk (e.g. new file / append): anchor at the hint.
      return Math.min(Math.max(hint, minPos), originalLines.length);
    }
    let best = null;
    for (let p = minPos; p + block.length <= originalLines.length; p++) {
      let matched = true;
      for (let j = 0; j < block.length; j++) {
        if (originalLines[p + j] !== block[j]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      if (best === null || Math.abs(p - hint) < Math.abs(best - hint)) best = p;
    }
    return best;
  };

  // Track whether the final line pushed to `newLines` should be left without a
  // trailing newline in the reassembled output. This is true either because
  // the patch explicitly marks that line with "\ No newline at end of file",
  // or because the line is carried over verbatim from the original file's own
  // unmodified last line and the original file itself had no trailing newline.
  const originalNoTrailingNewline =
    !!originalContent && originalContent.length > 0 && !/[\n\r]$/.test(originalContent);
  let endsWithoutNewline = false;

  const newLines = [];
  let cursor = 0;

  const pushOriginal = (k) => {
    newLines.push(originalLines[k]);
    endsWithoutNewline = k === originalLines.length - 1 && originalNoTrailingNewline;
  };

  for (const hunk of hunks) {
    const block = oldBlockOf(hunk.ops);
    const pos = findBlock(block, cursor, hunk.hint);
    if (pos === null) return null;

    // Copy untouched lines between the previous hunk and this one.
    for (let k = cursor; k < pos; k++) pushOriginal(k);

    let idx = pos;
    for (const op of hunk.ops) {
      if (op.kind === 'add') {
        newLines.push(op.text);
        endsWithoutNewline = !!op.noNewline;
      } else if (op.kind === 'del') {
        idx += 1; // consume the original line without emitting it
      } else {
        pushOriginal(idx); // context: keep the original line
        if (op.noNewline) endsWithoutNewline = true;
        idx += 1;
      }
    }
    cursor = idx;
  }

  // Append remaining original lines.
  for (let k = cursor; k < originalLines.length; k++) pushOriginal(k);

  let content = newLines.join('\n');
  if (content && !endsWithoutNewline) content += '\n';
  return content;
}

/**
 * Apply a unified diff to an in-memory file map.
 *
 * @param {Record<string, string>} files map of path -> content
 * @param {string} diffText unified diff string
 * @returns {{ changed: boolean, files: Record<string, string> }}
 *   `changed` is true iff at least one file was created, modified, or deleted.
 *   `files` is a new map; on failure it equals the input (no partial changes).
 */
export function applyDiff(files, diffText) {
  const filePatches = parseDiffPerFile(diffText);
  if (!filePatches.length) {
    return { changed: false, files: { ...files } };
  }

  const original = { ...files };
  const working = { ...files };

  for (const [filePath, patch] of filePatches) {
    if (patch.includes('+++ /dev/null')) {
      // Deletion patch.
      delete working[filePath];
    } else {
      const result = applyPatchToFile(
        Object.prototype.hasOwnProperty.call(working, filePath) ? working[filePath] : '',
        patch,
      );
      if (result === null) {
        return { changed: false, files: { ...original } };
      }
      working[filePath] = result;
    }
  }

  // Verify that at least one file actually changed.
  let anyChange = false;
  for (const [filePath, patch] of filePatches) {
    if (patch.includes('+++ /dev/null')) {
      if (!Object.prototype.hasOwnProperty.call(working, filePath)) anyChange = true;
    } else {
      const had = Object.prototype.hasOwnProperty.call(original, filePath);
      if (!had || original[filePath] !== working[filePath]) anyChange = true;
    }
  }

  if (!anyChange) {
    return { changed: false, files: { ...original } };
  }
  return { changed: true, files: working };
}

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
export function parsePatchHunks(patch) {
  const patchLines = splitLines(patch || '');
  /** @type {Array<{ hint: number, ops: Array<{ kind: string, text: string }> }>} */
  const hunks = [];
  let i = 0;
  while (i < patchLines.length) {
    const line = patchLines[i];
    if (!line.replace(/^\s+/, '').startsWith('@@')) {
      i += 1;
      continue;
    }
    let origStart = 1;
    const trimmed = line.trim();
    if (trimmed !== '@@') {
      const m = trimmed.match(HUNK_HEADER_RE);
      if (m && m[1] !== undefined) origStart = parseInt(m[1], 10);
    }
    /** @type {Array<{ kind: string, text: string }>} */
    const ops = [];
    i += 1;
    while (i < patchLines.length && !patchLines[i].replace(/^\s+/, '').startsWith('@@')) {
      const pline = patchLines[i];
      i += 1;
      if (pline.startsWith('\\')) continue;
      if (pline.startsWith('++') && !pline.startsWith('+++')) return null;
      if (pline.startsWith('-')) ops.push({ kind: 'del', text: pline.slice(1) });
      else if (pline.startsWith('+')) ops.push({ kind: 'add', text: pline.slice(1) });
      else if (pline.startsWith(' ')) ops.push({ kind: 'context', text: pline.slice(1) });
      else ops.push({ kind: 'context', text: pline });
    }
    hunks.push({ hint: Math.max(origStart - 1, 0), ops });
  }
  return hunks;
}

/**
 * @param {string[]} lines
 * @returns {Map<string, number>}
 */
function lineCounts(lines) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
  return counts;
}

/**
 * @param {Map<string, number>} budget
 * @param {string} text
 * @returns {boolean}
 */
function takeOne(budget, text) {
  const n = budget.get(text) || 0;
  if (n <= 0) return false;
  if (n === 1) budget.delete(text);
  else budget.set(text, n - 1);
  return true;
}

/**
 * True when `updatedLines` is `originalLines` with only the budgeted `-`
 * lines removed and the budgeted `+` lines inserted, in an order that keeps
 * every surviving line in its original relative order.
 *
 * @param {string[]} originalLines
 * @param {string[]} updatedLines
 * @param {Map<string, number>} delCounts
 * @param {Map<string, number>} addCounts
 * @returns {boolean}
 */
function isPlusMinusEdit(originalLines, updatedLines, delCounts, addCounts) {
  const delLeft = new Map(delCounts);
  const addLeft = new Map(addCounts);
  let i = 0;
  let j = 0;
  while (i < originalLines.length && j < updatedLines.length) {
    if (originalLines[i] === updatedLines[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (takeOne(addLeft, updatedLines[j])) {
      j += 1;
      continue;
    }
    if (takeOne(delLeft, originalLines[i])) {
      i += 1;
      continue;
    }
    return false;
  }
  while (i < originalLines.length) {
    if (!takeOne(delLeft, originalLines[i])) return false;
    i += 1;
  }
  while (j < updatedLines.length) {
    if (!takeOne(addLeft, updatedLines[j])) return false;
    j += 1;
  }
  return true;
}

/**
 * Whether `updatedContent` does something other than apply this diff's
 * `+`/`-` lines to `originalContent`.
 *
 * Armed only when a context line does not occur anywhere in the original
 * file — the case where a model copies the diff's stale context in, or drops
 * lines the hunk never removed. A `-` line that merely fails to match
 * (quotes, whitespace) does not arm the check, so a fuzzy model rewrite of
 * that line can still stand.
 *
 * @param {string} originalContent
 * @param {string} updatedContent
 * @param {string} patch
 * @returns {boolean}
 */
export function diffOutputViolatesIntent(originalContent, updatedContent, patch) {
  const hunks = parsePatchHunks(patch);
  if (!hunks || hunks.length === 0) return false;

  const originalLines = splitLines(originalContent || '');
  const updatedLines = splitLines(updatedContent || '');
  const present = new Set(originalLines);
  /** @type {Map<string, number>} */
  const delCounts = new Map();
  /** @type {Map<string, number>} */
  const addCounts = new Map();
  let badContext = false;
  for (const hunk of hunks) {
    for (const op of hunk.ops) {
      if (op.kind === 'context') {
        if (!present.has(op.text)) badContext = true;
      } else if (op.kind === 'del') {
        delCounts.set(op.text, (delCounts.get(op.text) || 0) + 1);
      } else if (op.kind === 'add') {
        addCounts.set(op.text, (addCounts.get(op.text) || 0) + 1);
      }
    }
  }
  if (!badContext) return false;
  if (!isPlusMinusEdit(originalLines, updatedLines, delCounts, addCounts)) return true;

  const origCounts = lineCounts(originalLines);
  const updCounts = lineCounts(updatedLines);
  for (const [text, n] of delCounts) {
    if (addCounts.has(text)) continue;
    const have = origCounts.get(text) || 0;
    if (have === 0) continue;
    const left = updCounts.get(text) || 0;
    if (left > have - Math.min(have, n)) return true;
  }
  for (const [text, n] of addCounts) {
    if (delCounts.has(text)) continue;
    const have = origCounts.get(text) || 0;
    const got = updCounts.get(text) || 0;
    if (got < have + n) return true;
  }
  return false;
}

/**
 * Best `+`/`-` alignment of one hunk against `fileLines`, starting at `start`.
 * Context ops may be skipped when they do not equal the current file line, so
 * a stale context line is never written. File lines inside the matched span
 * are only kept (matched context) or dropped (a `-` line).
 *
 * @param {Array<{ kind: string, text: string }>} ops
 * @param {string[]} fileLines
 * @param {number} start
 * @returns {{ matchedContext: number, end: number, replacement: string[] } | null}
 */
function alignHunkAt(ops, fileLines, start) {
  const consumable = ops.reduce((n, op) => n + (op.kind === 'add' ? 0 : 1), 0);
  const last = Math.min(fileLines.length, start + consumable);
  /** @type {Map<number, { matchedContext: number, end: number, replacement: string[] } | null>} */
  const memo = new Map();
  const width = fileLines.length + 1;

  /**
   * @param {number} opIdx
   * @param {number} i
   * @returns {{ matchedContext: number, end: number, replacement: string[] } | null}
   */
  const rec = (opIdx, i) => {
    const key = opIdx * width + i;
    if (memo.has(key)) return memo.get(key) ?? null;
    /** @type {{ matchedContext: number, end: number, replacement: string[] } | null} */
    let result = null;
    if (opIdx === ops.length) {
      result = { matchedContext: 0, end: i, replacement: [] };
    } else if (i > last) {
      result = null;
    } else {
      const op = ops[opIdx];
      if (op.kind === 'add') {
        const rest = rec(opIdx + 1, i);
        if (rest) {
          result = {
            matchedContext: rest.matchedContext,
            end: rest.end,
            replacement: [op.text, ...rest.replacement],
          };
        }
      } else if (op.kind === 'del') {
        if (i < last && i < fileLines.length && fileLines[i] === op.text) {
          const rest = rec(opIdx + 1, i + 1);
          if (rest) result = rest;
        }
      } else {
        const skipped = rec(opIdx + 1, i);
        /** @type {{ matchedContext: number, end: number, replacement: string[] } | null} */
        let matched = null;
        if (i < last && i < fileLines.length && fileLines[i] === op.text) {
          const rest = rec(opIdx + 1, i + 1);
          if (rest) {
            matched = {
              matchedContext: rest.matchedContext + 1,
              end: rest.end,
              replacement: [fileLines[i], ...rest.replacement],
            };
          }
        }
        if (matched && skipped) {
          result = matched.matchedContext >= skipped.matchedContext ? matched : skipped;
        } else {
          result = matched || skipped;
        }
      }
    }
    memo.set(key, result);
    return result;
  };

  return rec(0, start);
}

/**
 * Apply only the `+`/`-` lines of a patch, ignoring context lines that are
 * not actually in the file.
 *
 * Returns null when a `-` line cannot be found, when a pure insertion has no
 * matching context to anchor it, or when a body line is ambiguous. Never
 * writes a context line that was not already in the original.
 *
 * @param {string} originalContent
 * @param {string} patch
 * @returns {string | null}
 */
export function applyIntentIgnoringBadContext(originalContent, patch) {
  const hunks = parsePatchHunks(patch);
  if (!hunks || hunks.length === 0) return null;

  const originalLines = splitLines(originalContent || '');
  const originalNoTrailingNewline =
    !!originalContent && originalContent.length > 0 && !/[\n\r]$/.test(originalContent);
  let endsWithoutNewline = false;
  /** @type {string[]} */
  const newLines = [];
  let cursor = 0;

  const pushOriginal = (k) => {
    newLines.push(originalLines[k]);
    endsWithoutNewline = k === originalLines.length - 1 && originalNoTrailingNewline;
  };

  for (const hunk of hunks) {
    const ops = hunk.ops;
    const nDel = ops.reduce((n, op) => n + (op.kind === 'del' ? 1 : 0), 0);
    const nAdd = ops.reduce((n, op) => n + (op.kind === 'add' ? 1 : 0), 0);
    const nCtx = ops.reduce((n, op) => n + (op.kind === 'context' ? 1 : 0), 0);
    if (nDel === 0 && nAdd === 0) continue;

    /** @type {{ start: number, end: number, replacement: string[], matchedContext: number } | null} */
    let best = null;
    const needles = new Set();
    for (const op of ops) {
      if (op.kind === 'context' || op.kind === 'del') needles.add(op.text);
    }
    /** @type {number[]} */
    const starts = [];
    for (let s = cursor; s < originalLines.length; s++) {
      if (needles.has(originalLines[s])) starts.push(s);
    }
    if (nAdd > 0) starts.push(originalLines.length);

    for (const start of starts) {
      const found = alignHunkAt(ops, originalLines, start);
      if (!found || found.end < start) continue;
      const candidate = {
        start,
        end: found.end,
        replacement: found.replacement,
        matchedContext: found.matchedContext,
      };
      if (!best) {
        best = candidate;
        continue;
      }
      const closer = Math.abs(candidate.start - hunk.hint) < Math.abs(best.start - hunk.hint);
      const nearerTie =
        Math.abs(candidate.start - hunk.hint) === Math.abs(best.start - hunk.hint) &&
        candidate.start < best.start;
      if (
        candidate.matchedContext > best.matchedContext ||
        (candidate.matchedContext === best.matchedContext && (closer || nearerTie))
      ) {
        best = candidate;
      }
    }

    if (!best) return null;
    // A pure insertion whose context matched nothing has no safe anchor.
    // (`@@` hint insertion is left to the exact applier / the model.)
    if (nDel === 0 && best.matchedContext === 0 && nCtx > 0) return null;
    if (nDel === 0 && nCtx === 0) {
      const at = Math.min(Math.max(hunk.hint, cursor), originalLines.length);
      best = {
        start: at,
        end: at,
        replacement: ops.filter((op) => op.kind === 'add').map((op) => op.text),
        matchedContext: 0,
      };
    }

    for (let k = cursor; k < best.start; k++) pushOriginal(k);
    for (const line of best.replacement) {
      newLines.push(line);
      endsWithoutNewline = false;
    }
    cursor = best.end;
  }

  for (let k = cursor; k < originalLines.length; k++) pushOriginal(k);

  let content = newLines.join('\n');
  if (content && !endsWithoutNewline) content += '\n';
  return content;
}

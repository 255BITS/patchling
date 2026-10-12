/**
 * Grade a smartapply result the same way the NanoGPT harness does.
 *
 * @param {Record<string, string>} files
 * @param {{ files: Record<string, string>, expect: Record<string, string[]>,
 *   reject?: Record<string, string[]>, deleted?: string[] }} c
 * @returns {string} empty when the result passes
 */
export function gradeSmartapplyCase(files, c) {
  const why = [];
  for (const [p, needles] of Object.entries(c.expect || {})) {
    if (!Object.prototype.hasOwnProperty.call(files, p) || files[p] == null) {
      why.push(`missing ${p}`);
      continue;
    }
    for (const n of needles) {
      if (!files[p].includes(n)) why.push(`${p} lacks ${JSON.stringify(n)}`);
    }
  }
  for (const [p, needles] of Object.entries(c.reject || {})) {
    for (const n of needles) {
      if (Object.prototype.hasOwnProperty.call(files, p) && files[p] && files[p].includes(n)) {
        why.push(`${p} still has ${JSON.stringify(n)}`);
      }
    }
  }
  for (const p of c.deleted || []) {
    if (Object.prototype.hasOwnProperty.call(files, p) && files[p] != null && files[p] !== '') {
      why.push(`${p} not deleted`);
    }
  }
  const extra = Object.keys(files).filter(
    (p) => !Object.prototype.hasOwnProperty.call(c.files, p) && !Object.prototype.hasOwnProperty.call(c.expect, p),
  );
  if (extra.length) why.push(`extra files ${extra.sort()}`);
  return why.join('; ');
}

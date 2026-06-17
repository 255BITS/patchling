/**
 * Deterministic-apply benchmark.
 *
 * Runs the corpus in benchmark/diff-corpus.json through the same per-file logic
 * as `smartapply`'s fast path (deletion -> delete; otherwise applyPatchToFile),
 * and reports how often the deterministic path:
 *   - clean-correct: applied with no LLM and matched the expected output
 *   - clean-wrong:   applied with no LLM but produced WRONG output (silent
 *                    corruption — the dangerous case worth watching)
 *   - fallback:      could not apply (returned null) -> would call the LLM
 *
 * Counts are reported per file and per example, broken down by category, plus
 * how the deterministic outcome lines up with each example's `expectFallback`
 * label from the generator.
 *
 * Usage: node benchmark/run.js [path-to-corpus.json]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseDiffPerFile, applyPatchToFile } from '../src/applydiff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(process.argv[2] || join(__dirname, 'diff-corpus.json'));

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const examples = Array.isArray(corpus) ? corpus : corpus.examples;
if (!Array.isArray(examples)) {
  console.error('Corpus must be an array of examples or { examples: [...] }');
  process.exit(1);
}

const normalize = (s) => {
  // The deterministic applier normalizes a trailing newline; compare modulo a
  // single optional trailing newline so we measure semantic, not byte, parity.
  return (s ?? '').replace(/\n+$/, '\n').replace(/\n$/, '');
};

const FILE = { cleanCorrect: 0, cleanWrong: 0, fallback: 0 };
const byCategory = new Map();
const exampleOutcomes = { allCleanCorrect: 0, anyFallback: 0, anyWrong: 0 };
const wrongSamples = [];

function catBucket(cat) {
  if (!byCategory.has(cat)) {
    byCategory.set(cat, { cleanCorrect: 0, cleanWrong: 0, fallback: 0, files: 0 });
  }
  return byCategory.get(cat);
}

for (const ex of examples) {
  const cat = ex.category || 'unknown';
  const bucket = catBucket(cat);
  const patches = parseDiffPerFile(ex.diff);
  const result = { ...(ex.original || {}) };

  let exFallback = false;
  let exWrong = false;

  for (const [path, patch] of patches) {
    bucket.files += 1;

    if (patch.includes('+++ /dev/null')) {
      // Deletion: always deterministic, no LLM.
      delete result[path];
      const stillThere = Object.prototype.hasOwnProperty.call(ex.expected || {}, path);
      if (stillThere) {
        FILE.cleanWrong += 1;
        bucket.cleanWrong += 1;
        exWrong = true;
      } else {
        FILE.cleanCorrect += 1;
        bucket.cleanCorrect += 1;
      }
      continue;
    }

    const original = Object.prototype.hasOwnProperty.call(result, path) ? result[path] : '';
    const applied = applyPatchToFile(original, patch);

    if (applied === null) {
      FILE.fallback += 1;
      bucket.fallback += 1;
      exFallback = true;
      continue;
    }

    result[path] = applied;
    const want = (ex.expected || {})[path];
    if (normalize(applied) === normalize(want)) {
      FILE.cleanCorrect += 1;
      bucket.cleanCorrect += 1;
    } else {
      FILE.cleanWrong += 1;
      bucket.cleanWrong += 1;
      exWrong = true;
      if (wrongSamples.length < 8) {
        wrongSamples.push({ name: ex.name, path, expectFallback: ex.expectFallback });
      }
    }
  }

  if (exFallback) exampleOutcomes.anyFallback += 1;
  if (exWrong) exampleOutcomes.anyWrong += 1;
  if (!exFallback && !exWrong) exampleOutcomes.allCleanCorrect += 1;
}

const totalFiles = FILE.cleanCorrect + FILE.cleanWrong + FILE.fallback;
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : '—');

console.log(`\nCorpus: ${examples.length} examples, ${totalFiles} file-patches`);
console.log(`Source: ${corpusPath}\n`);

console.log('Per-file deterministic outcome:');
console.log(`  clean-correct : ${FILE.cleanCorrect}  (${pct(FILE.cleanCorrect, totalFiles)})`);
console.log(`  clean-WRONG   : ${FILE.cleanWrong}  (${pct(FILE.cleanWrong, totalFiles)})`);
console.log(`  fallback->LLM : ${FILE.fallback}  (${pct(FILE.fallback, totalFiles)})\n`);

console.log('Per-example outcome:');
console.log(`  fully clean & correct (no LLM) : ${exampleOutcomes.allCleanCorrect}  (${pct(exampleOutcomes.allCleanCorrect, examples.length)})`);
console.log(`  needed >=1 LLM fallback        : ${exampleOutcomes.anyFallback}  (${pct(exampleOutcomes.anyFallback, examples.length)})`);
console.log(`  had >=1 silent wrong apply     : ${exampleOutcomes.anyWrong}  (${pct(exampleOutcomes.anyWrong, examples.length)})\n`);

console.log('By category (files):');
const rows = [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log('  ' + 'category'.padEnd(24) + 'files  correct  wrong  fallback');
for (const [cat, b] of rows) {
  console.log(
    '  ' +
      cat.padEnd(24) +
      String(b.files).padStart(5) +
      String(b.cleanCorrect).padStart(9) +
      String(b.cleanWrong).padStart(7) +
      String(b.fallback).padStart(10),
  );
}

if (wrongSamples.length) {
  console.log('\nSample silent-wrong applies (review these — fast path corrupted output):');
  for (const w of wrongSamples) {
    console.log(`  - ${w.name} :: ${w.path}  (author expectFallback=${w.expectFallback})`);
  }
}
console.log('');

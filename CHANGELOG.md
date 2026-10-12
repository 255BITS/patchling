# Changelog

## [0.2.1] — Unreleased

Not tagged and not published. `package.json` is `0.2.1`; the only release tag and the npm `latest` dist-tag are still `0.2.0` (`gptdiff-js`).

### smartapply

- Refuse to write a model rewrite that copies a diff's stale context or edits any line the diff did not add or remove. When the context is wrong, replay only the `+`/`-` lines, and throw instead of guessing when those lines cannot be anchored.
- Count a uniform indentation shift, and a hunk that matches somewhere other than its `@@` line, as context. A free function in the diff can land on the indented method it actually describes (`hard_moved_block`) without the intent guard discarding the file. Deleting an unrelated line, or returning an empty file, is still a violation.
- Rewrite a diff's renamed identifiers onto the names the file already uses, so `raise KeyError(user_id)` lands as `raise KeyError(uid)` inside `fetch_user_record(uid, db)` without a model call.
- NanoGPT cases, including the `hard_*` set, live in `test/fixtures/smartapply-live-cases.json` and run with `npm run test:live:llm` (`LIVE_LLM=1`). Mocked-LLM coverage keeps `npm test` offline.

### Applying diffs

- `applyPatchToFile` no longer applies a hunk cleanly when the result would be wrong: ambiguous `++` body lines fall back to the model, and a final `\ No newline` add that only restates the last kept line is collapsed when the hunk header agrees.
- Preserve a file's trailing-newline state, including a last line that loses its newline.

### API

- `filterRelevant(files, task, opts)` asks a cheap model, per file, whether that file is relevant to the task. Bounded concurrency, a pluggable cache keyed by model + task hash + content hash (in-memory by default), and a skip for binary and oversized files. Ambiguous answers and errors include the file and are reported on the decision. `buildEnvironment(files, { decisions })` keeps only the `yes` files for `generateDiff`.
- Renamed the package from `gptdiff-js` to `patchling` (npm name `patchling`; an intermediate publish used `gptdiff`).
- `generateDiff` and `smartapply` stream tokens through `opts.onToken`. `generateDiff` reports token usage through `opts.onUsage`.
- Ship JSDoc-generated `.d.ts` files, with `types` conditions on the package exports.
- `prepublishOnly` runs the test suite. README install docs and repository URLs point at the patchling repo and [patchling.app](https://patchling.app).

### Site

- `patchling.app` landing page: in-browser playground (canned demo and live NanoGPT), model picker, and Open Graph card.
- The playground can run `filterRelevant` before the diff: a toggle, a decision-model picker, and a per-file yes/no view (reasons, tokens, skips). Bundled sample projects exercise it without leaving the page.
- README links that 404'd after the repo rename now point at patchling.app and the Python package.

### CI

- Test on Node 18, 20, and 22, plus the deterministic apply benchmark.
- A pushed `vX.Y.Z` tag fails the workflow when it is not `package.json`'s version.
- On `main`, `package.json` must match the latest `vX.Y.Z` tag, or be newer and have an unreleased changelog entry for that version.

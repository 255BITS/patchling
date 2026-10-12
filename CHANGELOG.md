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

- `filterRelevant` validates the whole file as UTF-8. Invalid bytes past the first 8192, including `0xff` before a later tail, are binary; an include keeps those original bytes. A leading UTF-8 BOM is preserved in the decoded text, the token count, and the cache key. Message content that is not a string fails open and is not cached. A quoted `yes` or `no` followed by a reason is that decision.
- `filterRelevant(files, task, opts)` asks a cheap model, per file, whether that file is relevant to the task. The default model is `xiaomi/mimo-v2.6-flash` (`GPTDIFF_FILTER_MODEL`), with concurrency 8. `onOversize` and `onBinary` are `include`, `exclude`, or `truncate` (defaults `truncate` and `exclude`). `maxBytes` (200000) and `maxTokens` (12000, `ceil(code points / 4)`) cap what is sent; `0` disables either limit. A truncated `yes` still forwards the original file, and the cut stays on a code-point boundary. The completion cap is 1024 and the call sends `reasoning_effort: low`. A 4xx that names that parameter is retried once without it. An empty answer, and any answer that is not a leading standalone yes/no, fails open and is not cached. Timeouts, HTTP 5xx, and billing-reservation errors are retried with backoff. Lockfiles and generated files are skipped unless `ignore` is turned off or replaced (case-insensitive; the canonical list is `DEFAULT_IGNORE_PATTERNS`). Prompt version is 3. The cache key hashes prompt version, model, output-token limit, the reasoning effort actually sent, task, path, mode (`full`, `truncated`, or `binary`), the preview note, and the body that was sent. Each field is length-prefixed as `byteLength:utf8\n`. A lookup tries the configured effort, then the empty effort used when that parameter was rejected. Each path is classified on its own. A cache read or write error is logged and does not abort the run. Cache-key hashing uses Web Crypto, and on Node 18 (where `crypto` is not a global) the `webcrypto` export of `node:crypto`. `failedOpen` on each decision, and the `failedOpen` count on the result, include malformed answers. Decisions use camelCase: `promptTokens`, `completionTokens`, `skippedReason` (`binary`, `oversize`, `truncated`, `ignored`). `buildEnvironment(files, { decisions })` keeps only the `yes` files for `generateDiff`. Reported pallets/flask figures (recall 1.0, about 0.8× the tokens of a full-context read) are UNVERIFIED.
- Renamed the package from `gptdiff-js` to `patchling` (npm name `patchling`; an intermediate publish used `gptdiff`).
- `generateDiff` and `smartapply` stream tokens through `opts.onToken`. `generateDiff` reports token usage through `opts.onUsage`.
- Ship JSDoc-generated `.d.ts` files, with `types` conditions on the package exports.
- `prepublishOnly` runs the test suite. README install docs and repository URLs point at the patchling repo and [patchling.app](https://patchling.app).

### Site

- `patchling.app` landing page: in-browser playground (canned demo and live NanoGPT), model picker, and Open Graph card.
- The playground can run `filterRelevant` before the diff: a toggle, a decision-model picker (default `xiaomi/mimo-v2.6-flash`), and a per-file yes/no view (reasons, tokens, binary, oversize, and ignored skips, truncated previews). Bundled sample projects exercise it without leaving the page. Switching scenario or editing a file cancels the in-flight run so its result cannot overwrite the new files. Classifier cost uses the model and rates from the start of the run; usage that has only `total_tokens` is shown as cost unknown.

- README links that 404'd after the repo rename now point at patchling.app and the Python package.

### CI

- Test on Node 18, 20, and 22, plus the deterministic apply benchmark.
- A pushed `vX.Y.Z` tag fails the workflow when it is not `package.json`'s version.
- On `main`, `package.json` must match the latest `vX.Y.Z` tag, or be newer and have an unreleased changelog entry for that version.

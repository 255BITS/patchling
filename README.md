# patchling

<p align="center">
  <img src="infographic.svg" alt="patchling: Smart Diffs, Applied Intelligently — generateDiff creates a unified diff from your files and goal, smartapply resolves conflicts per-file with LLM, and you iterate until done" width="100%">
</p>

> _Formerly **gptdiff-js**._

**Natural-language code transformation, browser-first.** Hand patchling an in-memory `{ path: content }` file map plus a plain-English goal; **`generateDiff`** returns a unified git diff, and **`smartapply`** melds that diff into your source — even when `git apply` would reject it (drifted lines, fuzzy hunks, renames, new files, deletions). It's a bounded primitive you embed in your own app, not an open-ended coding agent. Wired to [NanoGPT](https://nano-gpt.com) for completions (including "Sign in with NanoGPT" OAuth PKCE).

Everything runs in the browser (and in Node 18+): no filesystem, no build step, zero runtime dependencies. The diff engine is a faithful port of the [Python patchling](https://github.com/255BITS/patchling-py) (formerly gptdiff); it operates on an in-memory file map instead of a directory on disk.

See it in action: **[patchling.app](https://patchling.app)** (live demo on the homepage) · **[live browser demos →](https://255bits.github.io/patchling-examples/)**

> **The family** —
> [**patchling.app**](https://patchling.app) (project home + live demo) ·
> **patchling** (this package — the browser/Node runtime, [npm](https://www.npmjs.com/package/patchling)) ·
> [**patchling for Python**](https://github.com/255BITS/patchling-py) (library + CLI, [PyPI](https://pypi.org/project/patchling/)) ·
> [**nanoodle.com**](https://nanoodle.com) (visual AI workflow editor built on it)

```js
import { generateDiff, smartapply, buildEnvironment } from 'patchling';

const files = { 'greet.py': 'def greet():\n    print("hello")\n' };

// 1. Ask the model for a unified diff
const diff = await generateDiff(buildEnvironment(files), 'Say goodbye instead of hello');

// 2. Apply it with AI-powered conflict resolution
const updated = await smartapply(diff, files);
console.log(updated['greet.py']);
```

## Install / run

```bash
npm install patchling
```

```js
import { generateDiff, smartapply } from 'patchling';
```

**Browser, no build step** — it's zero-dependency ESM, so a CDN import works directly:

```js
import { generateDiff, smartapply } from 'https://esm.sh/patchling';
```

**Run from source** — point an import at `src/index.js`, or open `index.html` from a static server:

```bash
npx serve .        # then visit the printed URL and try the demo
npm test           # run the unit suite (Node's built-in test runner)
npm run test:live  # hit NanoGPT for real (requires env vars, see below)
```

## Configuration

Configuration comes from environment variables (Node) or `setEnv(...)` overrides (browser). OAuth sign-in sets the API key override for you.

| Variable | Purpose | Default |
| --- | --- | --- |
| `GPTDIFF_LLM_API_KEY` | NanoGPT API key (`sk-nano-…`) | — (required for live calls) |
| `GPTDIFF_LLM_BASE_URL` | OpenAI-compatible base URL | `https://nano-gpt.com/api/v1/` |
| `GPTDIFF_MODEL` | Model id | `xiaomi/mimo-v2.5-pro-ultraspeed` |
| `GPTDIFF_FILTER_MODEL` | Cheap model for `filterRelevant` | `xiaomi/mimo-v2.5-pro-ultraspeed` |

```js
import { setEnv } from 'patchling';
setEnv('GPTDIFF_LLM_API_KEY', 'sk-nano-…'); // browser, no process.env
```

## Sign in with NanoGPT (OAuth 2.0 + PKCE)

`src/oauth.js` implements the [NanoGPT OAuth PKCE flow](https://nano-gpt.com/blog/sign-in-with-nanogpt-oauth-pkce) using Web Crypto. In a browser:

```js
import { registerClient, beginSignIn, completeSignIn } from 'patchling/oauth';

// On page load — finishes the redirect and stores the access token as
// the GPTDIFF_LLM_API_KEY override automatically:
await completeSignIn();

// To start sign-in (clientId from a one-time dynamic registration):
const { client_id } = await registerClient({
  clientName: 'My App',
  redirectUri: location.origin + location.pathname,
});
await beginSignIn({ clientId: client_id }); // redirects to NanoGPT
```

Low-level helpers are also exported: `generatePkce`, `buildAuthorizeUrl`, `exchangeCodeForToken`, `generateCodeChallenge`.

## API

### `generateDiff(environment, goal, opts?) → Promise<string>`
Builds the prompt, calls the LLM, and returns the unified diff extracted from the ` ```diff ` block(s) of the response.

- `opts.model`, `opts.temperature`, `opts.maxTokens`, `opts.apiKey`, `opts.baseUrl`, `opts.prepend`, `opts.images`
- `opts.onToken` — `(text) => void` streaming callback. When provided, the completion is streamed (SSE) and called once per token as it arrives; the returned promise still resolves to the extracted diff. Tokens are the raw model output, which may include prose around the ` ```diff ` block.
- `opts.callLlm` — inject a custom/mock completion client (used heavily in tests).
- `opts.onUsage` — optional callback invoked with `{ promptTokens, completionTokens, totalTokens }` after the LLM call completes, so callers can surface cost/usage without changing the `Promise<string>` return type.

### `filterRelevant(files, task, opts?) → Promise<Decision[]>`
Opt-in pass for a large file map. Each candidate file is sent, in full, with the task to a cheap model that answers `is this file relevant to the task? yes/no`. Only `yes` files should be handed to `generateDiff`. `smartapply` still takes the full map, so files the diff never mentions are left as they were.

```js
import { filterRelevant, buildEnvironment, generateDiff, smartapply } from 'patchling';

const decisions = await filterRelevant(files, task, {
  model: 'xiaomi/mimo-v2.5-pro-ultraspeed', // GPTDIFF_FILTER_MODEL, else this cheap default
  concurrency: 8,                           // max in-flight calls
  // cache: null,                           // default is an in-memory cache
  // maxBytes: 262144,                      // skip larger files; null disables
  onDecision(d) { console.log(d.path, d.decision); },
});
const diff = await generateDiff(buildEnvironment(files, { decisions }), task, { model });
const next = await smartapply(diff, files);
```

- `opts.model`, `opts.apiKey`, `opts.baseUrl` — same key and base URL resolution as `generateDiff` (`GPTDIFF_LLM_API_KEY`, `GPTDIFF_LLM_BASE_URL`).
- `opts.concurrency` — at most this many classifications in flight (default 8).
- `opts.cache` — `get(key)` / `set(key, value)`, sync or async. The key is `model`, SHA-256 of the task, and SHA-256 of the contents, separated by NUL. Omit it for a process-wide in-memory cache (`createMemoryCache()` builds another). `null` turns caching off. Definitive yes/no answers are stored; errors and ambiguous answers are not.
- `opts.maxBytes` — UTF-8 size cap (default 262144). Larger files, and files that look binary (a NUL, or a dense run of control bytes), are not sent.
- `opts.onDecision` — called as each file finishes, in completion order. The returned array stays in input order.
- `opts.callLlm` — inject a mock client.

Each decision is `{ path, decision, raw, tokens, cached, skippedReason, error, reason }`.

- `decision` is `"yes"`, `"no"`, or `"skip"`.
- `skippedReason` is `"binary"`, `"too-large"`, or `null`.
- Ambiguous text (after `<think>` blocks are stripped) and a thrown call become `"yes"` with `error` set, so a bad answer cannot drop a file. `error` is `"ambiguous answer"` or the thrown message.
- `buildEnvironment(files, { decisions })` keeps only `"yes"` paths. Passing the decisions array itself does the same. With no second argument, every file is included.

Python (`filter_relevant` in [patchling-py](https://github.com/255BITS/patchling-py)) takes the same arguments in snake_case: `max_bytes`, `on_decision`, and `skipped_reason` on each decision. `build_environment(files, decisions=decisions)` keeps the `"yes"` files.

### `smartapply(diffText, files, opts?) → Promise<{ path: content }>`
Applies a diff to an in-memory file map with per-file, LLM-assisted conflict resolution (runs files concurrently). Handles creation, modification, and deletion; `<think>…</think>` and reasoning preambles are stripped automatically. Returns a **new** map; deleted files are omitted.

- `opts.model`, `opts.apiKey`, `opts.baseUrl`, `opts.maxTokens`
- `opts.onToken` — `(text, path) => void` streaming callback for LLM-resolved files. Files stream concurrently, so calls for different files interleave; use the `path` argument to demultiplex. Files applied by the deterministic fast path emit no tokens.
- `opts.callLlmForApply` — inject a custom/mock single-file applier.

### `applyDiff(files, diffText) → { changed, files }`
Deterministic, no-LLM patch application (the strict "basic" applier). `changed` is `true` iff something was created, modified, or deleted; `files` is the updated map (equal to the input on failure — no partial writes).

### Other exports
`parseDiffPerFile`, `buildEnvironment`, `filterRelevant`, `createMemoryCache`, `parseRelevanceAnswer`, `colorCodeDiff`, `swallowReasoning`, `stripBadOutput`, `extractDiffBlocks`, `callLlm`, `resolveApiKey`, `resolveBaseUrl`, `getEnv`, `setEnv`, and the `oauth` namespace.

## Differences from the Python package

- **No filesystem.** `applyDiff`/`smartapply` take and return a `{ path: content }` map rather than reading/writing a project directory.
- **Scope.** Only `generateDiff` + `smartapply` (and their dependencies) are ported — not the Python package's CLIs (`patchling`, `patchling-apply`).
- **Dependency injection** replaces Python's `monkeypatch`: pass `callLlm` / `callLlmForApply` to test without a network.
- **`fetch` + Web Crypto** replace `openai`/`requests`/`tiktoken`.

## License

MIT

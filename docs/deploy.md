# Deploying patchling.app

patchling.app is a Cloudflare Pages project (`patchling`) connected to
`255BITS/patchling` through the Cloudflare Workers and Pages GitHub app.
There is no `wrangler.toml` and no deploy workflow in this repo: Cloudflare
builds from Git on its side.

## Expected Pages settings

| Setting | Expected value |
| --- | --- |
| Git repository | `255BITS/patchling` |
| Production branch | `main` |
| Automatic production deployments | enabled |
| Preview deployments | `all` |
| PR preview comments | enabled |
| Build command | *(none)* |
| Build output directory | `landing` |
| Root directory | *(repo root)* |
| Custom domains (exact set) | `patchling.app`, `patchling.pages.dev` |

`scripts/check-pages-settings.mjs` holds these values as `EXPECTED`, and
`test/check_pages_settings.test.js` fails if this table and `EXPECTED`
disagree. "Preview deployments `all`" means every non-production branch gets
a preview, and "PR preview comments" (`pr_comments_enabled`) posts its URL
on each PR. The domain set is exact: a
missing or extra domain is drift.

Because the build output is `landing/` with no build step, everything the
page loads must live under `landing/`. `landing/lib/*.js` are byte-identical
copies of `src/*.js`.

## What CI checks (from the repo alone)

`test/deploy_config.test.js` asserts:

- there is no `wrangler.toml` / `wrangler.json(c)` that could override the
  dashboard settings;
- `landing/index.html` exists;
- every relative import under `landing/` resolves to a file inside `landing/`
  (nothing reaches into `src/` or `node_modules`, which Pages would not serve);
- `test/landing_lib_sync.test.js` keeps `landing/lib/` identical to `src/`.

CI cannot see the dashboard settings above.

## Checking the dashboard settings

Read-only, with an API token that has *Cloudflare Pages: Read*:

```sh
CF_ACCOUNT_ID=9a79801cc6e129d0ab3447ff14820c4a node scripts/check-pages-settings.mjs
```

Or check a saved response from
`GET /accounts/{account}/pages/projects/patchling`:

```sh
node scripts/check-pages-settings.mjs --from-file response.json
node scripts/check-pages-settings.mjs --from-file - < response.json
```

It prints one line per row of the table above and exits 1 if any differs
(production branch, automatic production deployments, preview setting,
PR preview comments,
build command, output directory, root directory, the exact domain set, or
the repository). It exits 2 on an API or input error, including a saved
or live envelope that is not `success: true` with an object `result`
(`success: false`, a missing `success` or `result`, `result: null`, or
invalid JSON), even when the project data would match. It never writes.
`npm test` runs it offline against `test/fixtures/pages/` with a negative case
for each check.

## Verify a production merge

After an intended production merge without `[CF-Pages-Skip]`, pass the full
merge commit SHA. The verifier checks the active deployment and succeeds once
Cloudflare reports a successful GitHub `main` deployment of that exact commit.
The same flag works on a saved API response.

```sh
CF_ACCOUNT_ID=9a79801cc6e129d0ab3447ff14820c4a \
  node scripts/check-pages-settings.mjs --expect-production-sha "$MERGE_SHA"
```

A preview can build the same `landing/` files while the production deployment
still serves an earlier commit. On 2026-11-19, Cloudflare reported production
at `b8b7936` and recorded explicit commit-message skips on the four newer
merges. The `042959c6.patchling.pages.dev` preview served all seven files from
the `landing/` tree at `main` commit `25c5d21`.

# Deploying patchling.app

patchling.app is a Cloudflare Pages project (`patchling`) connected to
`255BITS/patchling` through the Cloudflare Workers and Pages GitHub app.
There is no `wrangler.toml` and no deploy workflow in this repo: Cloudflare
builds from Git on its side, running `scripts/build-site.sh`.

## What the build produces

`bash scripts/build-site.sh` writes `dist/`:

| Path | Source |
| --- | --- |
| `/` | `landing/` copied as-is (the demo page) |
| `/py/` | `255BITS/patchling-py` `main` docs (`mkdocs.yml`, `site_url` set to `https://patchling.app/py/`) |
| `/js/` | this repo's `README.md`, `CHANGELOG.md` and `docs/*.md`, rendered with `scripts/site/mkdocs.js.yml` |
| `/docs/*` | 301 to `/py/*` (`scripts/site/_redirects`) |

It makes a shallow public clone of patchling-py (no token) and installs
`mkdocs-material==9.6.22` into a throwaway venv under `.site-build/`. That's
the same version pinned by patchling-py's Deploy Documentation workflow.
Nothing is added to `package.json`. The npm package still ships only `src/`.
`PATCHLING_PY_REF` picks another patchling-py branch or tag.

Each Pages build fetches patchling-py `main` fresh. patchling-py's "Trigger
patchling.app deploy" workflow calls a Pages deploy hook when its docs or
package change on `main`. That rebuilds this site with the new `/py/` docs,
without a push here.

## Expected Pages settings

| Setting | Expected value |
| --- | --- |
| Git repository | `255BITS/patchling` |
| Production branch | `main` |
| Automatic production deployments | enabled |
| Preview deployments | `all` |
| PR preview comments | enabled |
| Build command | `bash scripts/build-site.sh` |
| Build output directory | `dist` |
| Root directory | *(repo root)* |
| Custom domains (exact set) | `patchling.app`, `patchling.pages.dev` |

Environment variable (production and preview): `PYTHON_VERSION` = `3.12`.
The checker below does not read environment variables.

`scripts/check-pages-settings.mjs` holds these values as `EXPECTED`, and
`test/check_pages_settings.test.js` fails if this table and `EXPECTED`
disagree. "Preview deployments `all`" means every non-production branch gets
a preview, and "PR preview comments" (`pr_comments_enabled`) posts its URL
on each PR. The domain set is exact: a
missing or extra domain is drift.

Everything the landing page loads must live under `landing/`.
`landing/lib/*.js` are byte-identical copies of `src/*.js`. `landing/` must
not contain `py/`, `js/` or `docs/`, because the build owns those paths.

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

Last verified 2026-10-13 via the API, before the `dist/` build: production branch `main`,
automatic production deployments enabled, preview deployments `all`,
build output `landing`, no build command, domains `patchling.pages.dev` and
`patchling.app`, latest production deployment = `main` @ `58a3858` (#5).

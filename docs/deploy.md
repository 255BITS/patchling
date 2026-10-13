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
| Preview deployments | all non-production branches (PRs get a preview comment) |
| Build command | *(none)* |
| Build output directory | `landing` |
| Root directory | *(repo root)* |
| Custom domains | `patchling.app`, `patchling.pages.dev` |

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
CF_ACCOUNT_ID=9a79801cc6e129d0ab3447ff14820c4a scripts/check-pages-settings.sh
```

It prints the production branch, whether production deployments are enabled,
the build output directory, the domains, and the latest production commit,
and exits non-zero if any differs from the table above. It never writes.

Last verified 2026-10-13 via the API: production branch `main`,
automatic production deployments enabled, preview deployments `all`,
build output `landing`, no build command, domains `patchling.pages.dev` and
`patchling.app`, latest production deployment = `main` @ `58a3858` (#5).

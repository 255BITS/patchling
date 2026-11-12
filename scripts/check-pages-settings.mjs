#!/usr/bin/env node
/**
 * Read-only check of the Cloudflare Pages settings for patchling.app.
 * The expected values are the table in docs/deploy.md; any drift exits 1.
 *
 *   node scripts/check-pages-settings.mjs                  # live: CLOUDFLARE_API_TOKEN + CF_ACCOUNT_ID
 *   node scripts/check-pages-settings.mjs --from-file r.json   # a saved API response
 *   node scripts/check-pages-settings.mjs --from-file -        # the response on stdin
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EXPECTED = Object.freeze({
  repo: '255BITS/patchling',
  productionBranch: 'main',
  productionDeploymentsEnabled: true,
  previewDeploymentSetting: 'all',
  prCommentsEnabled: true,
  buildCommand: 'bash scripts/build-site.sh',
  destinationDir: 'dist',
  rootDir: '',
  domains: Object.freeze(['patchling.app', 'patchling.pages.dev']),
});

/**
 * Compare a Pages project API response (`{ result }` or the bare project)
 * to {@link EXPECTED}.
 * @param {any} response
 * @returns {{ ok: boolean, checks: { name: string, ok: boolean, got: unknown, want: unknown }[], info: string }}
 */
export function checkPagesProject(response) {
  const r = (response && response.result) || response || {};
  const src = (r.source && r.source.config) || {};
  const bc = r.build_config || {};
  const domains = Array.isArray(r.domains) ? [...r.domains].sort() : null;
  const got = {
    repo: src.owner && src.repo_name ? `${src.owner}/${src.repo_name}` : null,
    productionBranch: r.production_branch ?? src.production_branch ?? null,
    productionDeploymentsEnabled: src.production_deployments_enabled ?? null,
    previewDeploymentSetting: src.preview_deployment_setting ?? null,
    prCommentsEnabled: src.pr_comments_enabled ?? null,
    buildCommand: bc.build_command ?? '',
    destinationDir: bc.destination_dir ?? null,
    rootDir: bc.root_dir ?? '',
    domains,
  };
  const checks = Object.entries(EXPECTED).map(([name, want]) => {
    const value = got[name];
    const ok = Array.isArray(want)
      ? Array.isArray(value) && JSON.stringify(value) === JSON.stringify([...want].sort())
      : value === want;
    return { name, ok, got: value, want: Array.isArray(want) ? [...want] : want };
  });
  // Both the top-level and source production branch must agree when present.
  if (src.production_branch != null && src.production_branch !== r.production_branch) {
    checks.push({ name: 'source.productionBranch', ok: false, got: src.production_branch, want: EXPECTED.productionBranch });
  }
  const dep = r.canonical_deployment || {};
  const meta = (dep.deployment_trigger && dep.deployment_trigger.metadata) || {};
  const info = `latest production: ${meta.branch ?? '?'} @ ${String(meta.commit_hash || '').slice(0, 7)} ${dep.created_on || ''}`.trim();
  return { ok: checks.every((c) => c.ok), checks, info };
}

/**
 * Validate a Cloudflare API envelope and return its project. Live mode and
 * --from-file share this: anything but `success: true` with an object
 * `result` throws, and the CLI exits 2.
 * @param {any} body
 * @returns {object}
 */
export function unwrapEnvelope(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('API response is not a JSON object');
  }
  if (body.success !== true) {
    const detail = body.success === false ? `success:false ${JSON.stringify(body.errors || [])}` : 'missing or non-boolean success';
    throw new Error(`API envelope rejected: ${detail}`);
  }
  if (body.result == null || typeof body.result !== 'object' || Array.isArray(body.result)) {
    throw new Error('API envelope rejected: missing or non-object result');
  }
  return body.result;
}

/** @param {ReturnType<typeof checkPagesProject>} report */
export function formatReport(report) {
  const lines = report.checks.map((c) =>
    `${c.ok ? 'ok  ' : 'FAIL'} ${c.name} = ${JSON.stringify(c.got)}${c.ok ? '' : ` (want ${JSON.stringify(c.want)})`}`);
  lines.push(`info ${report.info}`);
  return lines.join('\n');
}

async function load(argv) {
  const i = argv.indexOf('--from-file');
  if (i !== -1) {
    const path = argv[i + 1];
    if (!path) throw new Error('--from-file needs a path or -');
    return JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8'));
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  const project = process.env.CF_PAGES_PROJECT || 'patchling';
  if (!token || !account) throw new Error('set CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID, or pass --from-file');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Cloudflare API ${res.status}: response is not JSON`);
  }
  if (!res.ok) throw new Error(`Cloudflare API ${res.status}: ${JSON.stringify((body && body.errors) || [])}`);
  return body;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = checkPagesProject(unwrapEnvelope(await load(process.argv.slice(2))));
    console.log(formatReport(report));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
}

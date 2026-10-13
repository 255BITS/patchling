#!/usr/bin/env bash
# Read-only check of the Cloudflare Pages settings for patchling.app.
# Needs CLOUDFLARE_API_TOKEN (Pages: Read) and CF_ACCOUNT_ID. See docs/deploy.md.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
PROJECT="${CF_PAGES_PROJECT:-patchling}"
curl -fsS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${PROJECT}" |
node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const r = JSON.parse(s).result || {};
  const src = (r.source && r.source.config) || {};
  const bc = r.build_config || {};
  const dep = r.canonical_deployment || {};
  const meta = (dep.deployment_trigger && dep.deployment_trigger.metadata) || {};
  const got = {
    repo: `${src.owner}/${src.repo_name}`,
    production_branch: r.production_branch,
    production_deployments_enabled: src.production_deployments_enabled,
    destination_dir: bc.destination_dir,
    build_command: bc.build_command || "",
    has_patchling_app: (r.domains || []).includes("patchling.app"),
  };
  const want = { repo: "255BITS/patchling", production_branch: "main", production_deployments_enabled: true,
    destination_dir: "landing", build_command: "", has_patchling_app: true };
  let ok = true;
  for (const [k, v] of Object.entries(want)) {
    const pass = got[k] === v;
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${k} = ${JSON.stringify(got[k])}${pass ? "" : ` (want ${JSON.stringify(v)})`}`);
  }
  console.log(`info latest production: ${meta.branch} @ ${(meta.commit_hash || "").slice(0, 7)} ${dep.created_on || ""}`);
  process.exit(ok ? 0 : 1);
});'

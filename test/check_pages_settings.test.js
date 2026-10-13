/** Offline fixtures for scripts/check-pages-settings.mjs (see docs/deploy.md). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPagesProject, EXPECTED } from '../scripts/check-pages-settings.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/pages/project-ok.json', import.meta.url));
const script = fileURLToPath(new URL('../scripts/check-pages-settings.mjs', import.meta.url));
const ok = () => JSON.parse(readFileSync(fixturePath, 'utf8'));

function failing(mutate) {
  const r = ok();
  mutate(r.result);
  const report = checkPagesProject(r);
  assert.equal(report.ok, false);
  return report.checks.filter((c) => !c.ok).map((c) => c.name);
}

test('the saved live response passes every check', () => {
  const report = checkPagesProject(ok());
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.checks.length, Object.keys(EXPECTED).length);
});

const negatives = {
  'preview deployments none': [(p) => { p.source.config.preview_deployment_setting = 'none'; }, ['previewDeploymentSetting']],
  'root_dir src': [(p) => { p.build_config.root_dir = 'src'; }, ['rootDir']],
  'destination_dir changed': [(p) => { p.build_config.destination_dir = 'dist'; }, ['destinationDir']],
  'build command added': [(p) => { p.build_config.build_command = 'npm run build'; }, ['buildCommand']],
  'missing patchling.pages.dev': [(p) => { p.domains = ['patchling.app']; }, ['domains']],
  'missing patchling.app': [(p) => { p.domains = ['patchling.pages.dev']; }, ['domains']],
  'extra domain': [(p) => { p.domains.push('www.patchling.app'); }, ['domains']],
  'no domains': [(p) => { delete p.domains; }, ['domains']],
  'wrong production branch': [(p) => { p.production_branch = 'develop'; p.source.config.production_branch = 'develop'; }, ['productionBranch']],
  'source branch disagrees': [(p) => { p.source.config.production_branch = 'develop'; }, ['source.productionBranch']],
  'auto production off': [(p) => { p.source.config.production_deployments_enabled = false; }, ['productionDeploymentsEnabled']],
  'wrong repo': [(p) => { p.source.config.repo_name = 'patchling-py'; }, ['repo']],
};

for (const [name, [mutate, want]] of Object.entries(negatives)) {
  test(`drift fails: ${name}`, () => {
    assert.deepEqual(failing(mutate), want);
  });
}

test('CLI: --from-file exits 0 on the good fixture', () => {
  const run = spawnSync(process.execPath, [script, '--from-file', fixturePath], { encoding: 'utf8', env: {} });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /ok {3}domains/);
});

test('CLI: stdin with preview none exits 1', () => {
  const r = ok();
  r.result.source.config.preview_deployment_setting = 'none';
  const run = spawnSync(process.execPath, [script, '--from-file', '-'], { input: JSON.stringify(r), encoding: 'utf8', env: {} });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL previewDeploymentSetting = "none"/);
});

test('docs/deploy.md table matches EXPECTED exactly', () => {
  const doc = readFileSync(new URL('../docs/deploy.md', import.meta.url), 'utf8');
  const rows = {
    'Git repository': `\`${EXPECTED.repo}\``,
    'Production branch': `\`${EXPECTED.productionBranch}\``,
    'Automatic production deployments': EXPECTED.productionDeploymentsEnabled ? 'enabled' : 'disabled',
    'Preview deployments': `\`${EXPECTED.previewDeploymentSetting}\``,
    'Build command': EXPECTED.buildCommand ? `\`${EXPECTED.buildCommand}\`` : '*(none)*',
    'Build output directory': `\`${EXPECTED.destinationDir}\``,
    'Root directory': EXPECTED.rootDir ? `\`${EXPECTED.rootDir}\`` : '*(repo root)*',
    'Custom domains (exact set)': [...EXPECTED.domains].sort().map((d) => `\`${d}\``).join(', '),
  };
  for (const [label, value] of Object.entries(rows)) {
    assert.ok(doc.includes(`| ${label} | ${value} |`), `docs/deploy.md row: | ${label} | ${value} |`);
  }
});

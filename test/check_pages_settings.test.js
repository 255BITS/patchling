/** Offline fixtures for scripts/check-pages-settings.mjs (see docs/deploy.md). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPagesProject, EXPECTED, unwrapEnvelope } from '../scripts/check-pages-settings.mjs';

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
  'PR preview comments off': [(p) => { p.source.config.pr_comments_enabled = false; }, ['prCommentsEnabled']],
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

test('CLI verifies the exact successful production deployment when requested', () => {
  const sha = 'b8b7936a2f38f0e3536f29206c3b0b29ba1a57a2';
  const response = ok();
  const deployment = {
    environment: 'production',
    is_skipped: false,
    latest_stage: { name: 'deploy', status: 'success' },
    deployment_trigger: { type: 'github:push', metadata: { branch: 'main', commit_hash: sha, commit_dirty: false } },
  };
  response.result.canonical_deployment = deployment;
  const run = (expected) => spawnSync(process.execPath,
    [script, '--from-file', '-', '--expect-production-sha', expected],
    { input: JSON.stringify(response), encoding: 'utf8', env: {} });

  assert.equal(run(sha).status, 0);
  const stale = run('a'.repeat(40));
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /FAIL productionCommit/);
  assert.equal(run(sha.slice(0, 7)).status, 2);

  for (const [name, changed, expectedFailure] of [
    ['preview', { environment: 'preview' }, /FAIL deploymentEnvironment/],
    ['skipped', { is_skipped: true }, /FAIL deploymentSkipped/],
    ['build only', { latest_stage: { name: 'build', status: 'success' } }, /FAIL deploymentStage/],
    ['failed', { latest_stage: { name: 'deploy', status: 'failure' } }, /FAIL deploymentStatus/],
    ['manual upload', { deployment_trigger: { ...deployment.deployment_trigger, type: 'ad_hoc' } }, /FAIL deploymentTrigger/],
    ['dirty source', { deployment_trigger: { ...deployment.deployment_trigger,
      metadata: { ...deployment.deployment_trigger.metadata, commit_dirty: true } } }, /FAIL productionCommitDirty/],
  ]) {
    response.result.canonical_deployment = { ...deployment, ...changed };
    const result = run(sha);
    assert.equal(result.status, 1, name);
    assert.match(result.stdout, expectedFailure);
  }
});

test('docs/deploy.md table matches EXPECTED exactly', () => {
  const doc = readFileSync(new URL('../docs/deploy.md', import.meta.url), 'utf8');
  const rows = {
    'Git repository': `\`${EXPECTED.repo}\``,
    'Production branch': `\`${EXPECTED.productionBranch}\``,
    'Automatic production deployments': EXPECTED.productionDeploymentsEnabled ? 'enabled' : 'disabled',
    'Preview deployments': `\`${EXPECTED.previewDeploymentSetting}\``,
    'PR preview comments': EXPECTED.prCommentsEnabled ? 'enabled' : 'disabled',
    'Build command': EXPECTED.buildCommand ? `\`${EXPECTED.buildCommand}\`` : '*(none)*',
    'Build output directory': `\`${EXPECTED.destinationDir}\``,
    'Root directory': EXPECTED.rootDir ? `\`${EXPECTED.rootDir}\`` : '*(repo root)*',
    'Custom domains (exact set)': [...EXPECTED.domains].sort().map((d) => `\`${d}\``).join(', '),
  };
  for (const [label, value] of Object.entries(rows)) {
    assert.ok(doc.includes(`| ${label} | ${value} |`), `docs/deploy.md row: | ${label} | ${value} |`);
  }
});

const badEnvelopes = {
  'success:false with errors and matching project': (r) => { r.success = false; r.errors = [{ code: 10000, message: 'Authentication error' }]; },
  'success:false with result null': (r) => { r.success = false; r.errors = [{ code: 8000007, message: 'Project not found' }]; r.result = null; },
  'missing success': (r) => { delete r.success; },
  'missing result': (r) => { delete r.result; },
  'success:true with result null': (r) => { r.result = null; },
  'success as a string': (r) => { r.success = 'true'; },
  'result is an array': (r) => { r.result = []; },
};

for (const [name, mutate] of Object.entries(badEnvelopes)) {
  const r = ok();
  mutate(r);
  const json = JSON.stringify(r);
  test(`envelope exits 2 via --from-file: ${name}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'pages-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'response.json');
    writeFileSync(file, json);
    const run = spawnSync(process.execPath, [script, '--from-file', file], { encoding: 'utf8', env: {} });
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, /error: /);
  });
  test(`envelope exits 2 via stdin: ${name}`, () => {
    const run = spawnSync(process.execPath, [script, '--from-file', '-'], { input: json, encoding: 'utf8', env: {} });
    assert.equal(run.status, 2, run.stdout + run.stderr);
  });
}

test('non-JSON input exits 2 via stdin and --from-file', (t) => {
  const run = spawnSync(process.execPath, [script, '--from-file', '-'], { input: 'not json', encoding: 'utf8', env: {} });
  assert.equal(run.status, 2);
  const dir = mkdtempSync(join(tmpdir(), 'pages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'r.json'), '');
  assert.equal(spawnSync(process.execPath, [script, '--from-file', join(dir, 'r.json')], { encoding: 'utf8', env: {} }).status, 2);
});

test('unwrapEnvelope returns the project of a good envelope', () => {
  assert.equal(unwrapEnvelope(ok()).name, 'patchling');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  changelogHasUnreleasedEntry,
  checkMainRelease,
  checkPushedTag,
  latestReleaseTag,
} from '../scripts/check-release-version.mjs';

const script = fileURLToPath(new URL('../scripts/check-release-version.mjs', import.meta.url));

test('pushed vX.Y.Z tag must equal package.json', () => {
  assert.equal(checkPushedTag('0.2.1', 'v0.2.1').ok, true);
  assert.equal(checkPushedTag('0.2.1', 'v0.2.0').ok, false);
  assert.match(checkPushedTag('0.2.1', 'v0.2.0').reason, /does not match package.json version 0\.2\.1/);
  assert.equal(checkPushedTag('0.2.1', 'v0.2.1-beta').ok, true);
  assert.match(checkPushedTag('0.2.1', 'nightly').reason, /not vX\.Y\.Z/);
});

test('main accepts the latest tag or a newer version with an unreleased entry', () => {
  const tags = ['v0.1.0', 'v0.2.0', 'not-a-release'];
  const notes = '## [0.2.1] — Unreleased\n\n- intent guard\n';
  assert.equal(latestReleaseTag(tags).tag, 'v0.2.0');
  assert.equal(checkMainRelease('0.2.0', tags, '').ok, true);
  assert.equal(checkMainRelease('0.2.1', tags, notes).ok, true);
  const missing = checkMainRelease('0.2.1', tags, '# Changelog\n\n## [0.2.0]\n\n- released\n');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no unreleased 0\.2\.1 entry/);
  const behind = checkMainRelease('0.1.9', tags, notes);
  assert.equal(behind.ok, false);
  assert.match(behind.reason, /behind latest tag v0\.2\.0/);
});

test('unreleased entry must be a heading for that version, not a later one', () => {
  const notes = [
    '## [0.2.10] — Unreleased',
    '',
    '- not 0.2.1',
    '',
    '## [0.2.1]',
    '',
    'Already released.',
  ].join('\n');
  assert.equal(changelogHasUnreleasedEntry(notes, '0.2.1'), false);
  assert.equal(changelogHasUnreleasedEntry(notes, '0.2.10'), true);
  assert.equal(changelogHasUnreleasedEntry('## 0.2.1\n\nUnreleased.\n', '0.2.1'), true);
});

test('this checkout passes the main release check', () => {
  const run = spawnSync(process.execPath, [script, '--main'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /0\.2\.1/);
  assert.match(run.stdout, /v0\.2\.0/);
});

test('a mismatched tag fails the CLI', () => {
  const run = spawnSync(process.execPath, [script, '--tag', 'v0.2.0'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /v0\.2\.0 does not match package.json version 0\.2\.1/);
});

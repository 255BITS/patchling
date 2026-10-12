/**
 * Release guards for package.json, git tags, and CHANGELOG.md.
 *
 *   node scripts/check-release-version.mjs --tag vX.Y.Z
 *   node scripts/check-release-version.mjs --main
 *
 * --tag fails when a pushed vX.Y.Z tag is not the package.json version.
 * Tags that are not vX.Y.Z are ignored.
 *
 * --main fails unless package.json is the highest vX.Y.Z tag, or a newer
 * version that has an unreleased CHANGELOG.md entry.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * @param {string} value
 * @returns {{ tag: string, version: string, parts: [number, number, number] } | null}
 */
export function parseReleaseTag(value) {
  const match = RELEASE_TAG.exec(String(value || '').trim());
  if (!match) return null;
  const parts = /** @type {[number, number, number]} */ ([
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ]);
  return { tag: `v${parts.join('.')}`, version: parts.join('.'), parts };
}

/**
 * @param {string} version semver triple, with or without a leading v
 * @returns {[number, number, number] | null}
 */
export function parseVersion(version) {
  const parsed = parseReleaseTag(version.startsWith('v') ? version : `v${version}`);
  return parsed ? parsed.parts : null;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b, positive when a > b
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new Error(`not a release version: ${!left ? a : b}`);
  }
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * Highest vX.Y.Z tag, ignoring other names.
 *
 * @param {string[]} tags
 * @returns {{ tag: string, version: string } | null}
 */
export function latestReleaseTag(tags) {
  /** @type {{ tag: string, version: string, parts: [number, number, number] } | null} */
  let best = null;
  for (const tag of tags) {
    const parsed = parseReleaseTag(tag);
    if (!parsed) continue;
    if (!best || compareVersions(parsed.version, best.version) > 0) best = parsed;
  }
  return best ? { tag: best.tag, version: best.version } : null;
}

/**
 * True when CHANGELOG.md has a heading for `version` whose section says
 * the entry is unreleased.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {boolean}
 */
export function changelogHasUnreleasedEntry(changelog, version) {
  const escaped = version.replace(/\./g, '\\.');
  const heading = new RegExp(`^#{1,3}\\s.*\\b${escaped}\\b`);
  const lines = String(changelog || '').split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (heading.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return /unreleased/i.test(lines.slice(start, end).join('\n'));
}

/**
 * @param {string} packageVersion
 * @param {string} pushedTag
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkPushedTag(packageVersion, pushedTag) {
  const parsed = parseReleaseTag(pushedTag);
  if (!parsed) {
    return { ok: true, reason: `tag ${pushedTag} is not vX.Y.Z; skipped` };
  }
  if (!parseVersion(packageVersion)) {
    return { ok: false, reason: `package.json version ${packageVersion} is not X.Y.Z` };
  }
  if (parsed.version !== packageVersion) {
    return {
      ok: false,
      reason: `tag ${parsed.tag} does not match package.json version ${packageVersion}`,
    };
  }
  return { ok: true, reason: `tag ${parsed.tag} matches package.json ${packageVersion}` };
}

/**
 * package.json must be the latest vX.Y.Z tag, or a newer version with an
 * unreleased changelog entry for that version.
 *
 * @param {string} packageVersion
 * @param {string[]} tags
 * @param {string} changelog
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkMainRelease(packageVersion, tags, changelog) {
  if (!parseVersion(packageVersion)) {
    return { ok: false, reason: `package.json version ${packageVersion} is not X.Y.Z` };
  }
  const latest = latestReleaseTag(tags);
  if (latest && compareVersions(packageVersion, latest.version) === 0) {
    return { ok: true, reason: `package.json ${packageVersion} matches ${latest.tag}` };
  }
  if (latest && compareVersions(packageVersion, latest.version) < 0) {
    return {
      ok: false,
      reason: `package.json ${packageVersion} is behind latest tag ${latest.tag}`,
    };
  }
  if (!changelogHasUnreleasedEntry(changelog, packageVersion)) {
    const aheadOf = latest ? `ahead of ${latest.tag}` : 'ahead of no tags';
    return {
      ok: false,
      reason: `package.json ${packageVersion} is ${aheadOf} but CHANGELOG.md has no unreleased ${packageVersion} entry`,
    };
  }
  const aheadOf = latest ? latest.tag : 'no tags';
  return {
    ok: true,
    reason: `package.json ${packageVersion} is ahead of ${aheadOf} with an unreleased changelog entry`,
  };
}

/**
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function listGitTags(cwd = process.cwd()) {
  const out = execFileSync('git', ['tag', '--list'], {
    cwd,
    encoding: 'utf8',
  });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function readPackageVersion(cwd) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // Allow tests to point at another checkout by passing cwd only for git;
  // the package file is this repo's package.json when run as the CLI.
  if (cwd && cwd !== process.cwd()) {
    const other = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf8'));
    return other.version;
  }
  return pkg.version;
}

function readChangelog(cwd) {
  const root = cwd && cwd !== process.cwd() ? cwd : new URL('..', import.meta.url);
  if (typeof root === 'string') {
    return readFileSync(`${root}/CHANGELOG.md`, 'utf8');
  }
  return readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
}

function main() {
  const [mode, arg] = process.argv.slice(2);
  const cwd = process.cwd();
  let result;
  if (mode === '--tag') {
    const tag = arg || process.env.GITHUB_REF_NAME || '';
    if (!tag) {
      console.error('usage: check-release-version.mjs --tag vX.Y.Z');
      process.exit(2);
    }
    result = checkPushedTag(readPackageVersion(cwd), tag);
  } else if (mode === '--main') {
    result = checkMainRelease(readPackageVersion(cwd), listGitTags(cwd), readChangelog(cwd));
  } else {
    console.error('usage: check-release-version.mjs --tag vX.Y.Z | --main');
    process.exit(2);
  }
  if (result.ok) {
    console.log(result.reason);
    return;
  }
  console.error(result.reason);
  process.exit(1);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();

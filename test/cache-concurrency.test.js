import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { RelevanceCache } from '../src/filter.js';

const exec = promisify(execFile);
const moduleUrl = new URL('../src/filter.js', import.meta.url).href;
const record = (raw) => ({ decision: 'yes', raw });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('claim records reject ambiguous PID, ticket, scope and token values', () => {
  const source = readFileSync(new URL('../src/filter.js', import.meta.url), 'utf8');
  const body = source.match(/function validCacheClaim\(value, name\) \{[^]*?\n\}/)[0];
  const valid = runInNewContext(`${body}\nvalidCacheClaim`);
  const owner = { version: 1, hostname: 'host', pid_scope: 'linux:pid:[1]', pid: 1,
    ticket: 1, token: 'a'.repeat(32) };
  const name = `${owner.token}.json`;
  assert.equal(valid(owner, name), true);
  for (const bad of [{ pid: true }, { pid: 0 }, { pid: 1.5 }, { ticket: -1 },
    { ticket: Number.MAX_SAFE_INTEGER + 1 }, { hostname: '' }, { pid_scope: '' },
    { token: 'b'.repeat(32) }, { version: true }]) {
    assert.equal(valid({ ...owner, ...bad }, name), false, JSON.stringify(bad));
  }
});

test('Windows/unknown platforms never signal another cache owner for recovery', () => {
  const source = readFileSync(new URL('../src/filter.js', import.meta.url), 'utf8');
  const body = source.match(/function deadCacheOwner\(claim, owner\) \{[^]*?\n\}/)[0];
  for (const platform of ['win32', 'unknown']) {
    let probes = 0;
    const dead = runInNewContext(`${body}\ndeadCacheOwner`, {
      process: { platform, kill() { probes += 1; throw new Error('must not signal'); } },
    });
    const owner = { hostname: 'host', pid_scope: platform };
    assert.equal(dead({ ...owner, pid: 1234 }, owner), false);
    assert.equal(probes, 0);
  }
});

async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'patchling-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'cache.json') };
}

async function scope() {
  return process.platform === 'linux'
    ? fs.readlink('/proc/self/ns/pid').then((v) => `linux:${v}`, () => null)
    : process.platform;
}

async function claim(path, values = {}) {
  const owner = { version: 1, hostname: hostname(), pid_scope: await scope(),
    pid: process.pid, token: 'a'.repeat(32), ticket: 1, ...values };
  await fs.mkdir(`${path}.lock`, { recursive: true });
  const file = join(`${path}.lock`, `${owner.token}.json`);
  await fs.writeFile(file, JSON.stringify(owner));
  return file;
}

test('independent stale instances merge only dirty entries and retain the newer conflict', async (t) => {
  const { path } = await fixture(t);
  const a = new RelevanceCache(path), b = new RelevanceCache(path);
  await Promise.all([a.load(), b.load()]);
  await a.put('shared', record('old')); await a.flush();
  await b.put('shared', record('new')); await b.put('b', record('b')); await b.flush();
  await a.put('a', record('a')); await a.flush();
  const restored = new RelevanceCache(path);
  assert.equal((await restored.get('shared')).raw, 'new');
  assert.equal((await restored.get('a')).raw, 'a');
  assert.equal((await restored.get('b')).raw, 'b');
  assert.deepEqual(await fs.readdir(`${path}.lock`), []);
});

test('simultaneous instances preserve all disjoint records', async (t) => {
  const { path } = await fixture(t);
  const caches = Array.from({ length: 6 }, () => new RelevanceCache(path));
  await Promise.all(caches.map((cache) => cache.load()));
  await Promise.all(caches.map((cache, i) => cache.put(String(i), record(String(i)))));
  await Promise.all(caches.map((cache) => cache.flush()));
  const payload = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal(payload.version, 1);
  assert.equal(Object.keys(payload.entries).length, caches.length);
});

test('a deleted cache is not repopulated from a stale clean snapshot; corrupt JSON recovers', async (t) => {
  const { path } = await fixture(t);
  const cache = new RelevanceCache(path);
  await cache.put('old', record('old')); await cache.flush();
  await fs.unlink(path);
  await cache.put('fresh', record('fresh')); await cache.flush();
  assert.equal((await new RelevanceCache(path).get('old')), undefined);
  await fs.writeFile(path, '{corrupt');
  await cache.put('after-corruption', record('ok')); await cache.flush();
  assert.equal((await new RelevanceCache(path).get('after-corruption')).raw, 'ok');
});

test('write failure keeps dirty entries retryable and releases the claim', async (t) => {
  const { path } = await fixture(t);
  const cache = new RelevanceCache(path);
  await cache.put('pending', record('pending'));
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === path) throw new Error('injected cache replacement failure');
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(cache.flush(), /injected cache replacement failure/); }
  finally { fs.rename = rename; syncBuiltinESMExports(); }
  assert.deepEqual(await fs.readdir(`${path}.lock`), []);
  await cache.flush();
  assert.equal((await new RelevanceCache(path).get('pending')).raw, 'pending');
});

test('a put and queued flush during I/O cannot be overwritten by the older flush', async (t) => {
  const { path } = await fixture(t);
  const cache = new RelevanceCache(path);
  await cache.put('key', record('old'));
  let entered, release;
  const writing = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  const rename = fs.rename;
  let first = true;
  fs.rename = async (from, to) => {
    if (to === path && first) { first = false; entered(); await gate; }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const old = cache.flush(); await writing;
    await cache.put('key', record('new'));
    const newer = cache.flush(); release();
    await Promise.all([old, newer]);
  } finally { release(); fs.rename = rename; syncBuiltinESMExports(); }
  assert.equal((await new RelevanceCache(path).get('key')).raw, 'new');
});

test('an abandoned same-host claim is recovered without deleting its directory', {
  skip: !['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos'].includes(process.platform),
}, async (t) => {
  const { path } = await fixture(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  const old = await claim(path, { pid: exited.pid });
  const cache = new RelevanceCache(path); await cache.put('a', record('a')); await cache.flush();
  await assert.rejects(fs.stat(old), { code: 'ENOENT' });
  assert.equal((await new RelevanceCache(path).get('a')).raw, 'a');
  assert.equal((await fs.stat(`${path}.lock`)).isDirectory(), true);
});

for (const kind of ['live', 'foreign', 'unknown']) {
  test(`${kind} owner is never stolen; contention fails in bounded time and remains retryable`, async (t) => {
    const { path } = await fixture(t);
    const file = await claim(path, kind === 'foreign' ? { hostname: `${hostname()}-other` } : {});
    if (kind === 'unknown') await fs.writeFile(file, '{malformed');
    const cache = new RelevanceCache(path); await cache.put('a', record('a'));
    const began = performance.now();
    await assert.rejects(cache.flush(), /Timed out waiting/);
    assert.ok(performance.now() - began < 5000);
    assert.equal((await fs.stat(file)).isFile(), true);
    await fs.unlink(file); await cache.flush();
    assert.equal((await new RelevanceCache(path).get('a')).raw, 'a');
  });
}

const jsWriter = `
import fs from 'node:fs/promises';
import { RelevanceCache } from ${JSON.stringify(moduleUrl)};
const [path,key,barrier] = process.argv.slice(1);
const cache = new RelevanceCache(path); await cache.load();
await cache.put(key,{decision:'yes',raw:key});
await fs.writeFile(barrier+'/'+key,'ready');
while (!(await fs.stat(barrier+'/go').catch(()=>null))) await new Promise(r=>setTimeout(r,5));
await cache.flush();
`;

async function waitForReady(dir, keys) {
  const deadline = performance.now() + 10000;
  while (!(await Promise.all(keys.map((key) => fs.stat(join(dir, key)).catch(() => null)))).every(Boolean)) {
    if (performance.now() > deadline) throw new Error('writer process did not become ready');
    await sleep(10);
  }
}

test('independent Node processes overlap writes without losing records', async (t) => {
  const { path, dir } = await fixture(t);
  const keys = ['n1', 'n2', 'n3', 'n4'];
  const writers = keys.map((key) => exec(process.execPath, ['--input-type=module', '-e', jsWriter, path, key, dir]));
  await waitForReady(dir, keys); await fs.writeFile(join(dir, 'go'), 'go');
  await Promise.all(writers);
  const restored = new RelevanceCache(path);
  for (const key of keys) assert.equal((await restored.get(key)).raw, key);
});

test('actual Python and Node writers use the same coordination protocol', {
  skip: !process.env.PATCHLING_PY_SOURCE,
}, async (t) => {
  const { path, dir } = await fixture(t);
  const python = `
import os,sys,time
from patchling.relevance import RelevanceCache
path,key,barrier=sys.argv[1:]
cache=RelevanceCache(path);cache.put(key,{'decision':'yes','raw':key})
open(os.path.join(barrier,key),'w').close()
while not os.path.exists(os.path.join(barrier,'go')):time.sleep(.005)
cache.flush()
`;
  const pythonSource = resolve(process.env.PATCHLING_PY_SOURCE);
  const writers = ['n1', 'n2'].map((key) => exec(process.execPath, ['--input-type=module', '-e', jsWriter, path, key, dir]));
  writers.push(...['p1', 'p2'].map((key) => exec(process.env.PATCHLING_PYTHON || 'python3', ['-c', python, path, key, dir], {
    cwd: pythonSource, env: { ...process.env, PYTHONPATH: pythonSource },
  })));
  await waitForReady(dir, ['n1', 'n2', 'p1', 'p2']); await fs.writeFile(join(dir, 'go'), 'go');
  await Promise.all(writers);
  const restored = new RelevanceCache(path);
  for (const key of ['n1', 'n2', 'p1', 'p2']) assert.equal((await restored.get(key)).raw, key);
});

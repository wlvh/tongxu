import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rename, lstat, rm, readdir, realpath, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { parseArgs } from '../../src/cli.js';
import { assertEndpoint, parseGh, GhTransport } from '../../src/transport.js';
import { readFixedObjects } from '../../src/git.js';
import { hash } from '../../src/snapshot.js';
const exec = promisify(execFile);
const cli = resolve('dist/src/cli.js');
const H = 'a'.repeat(40), B = 'b'.repeat(40), M = 'c'.repeat(40);

test('invalid scope/arguments/hosts never reach external tools', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tongxu-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = join(root, 'called');
  for (const name of ['git', 'gh']) await writeFile(join(root, name), `#!/bin/sh\ntouch '${sentinel}'\nexit 9\n`, { mode: 0o700 });
  for (const args of [[], ['inspect', '--repo', 'x;touch/y', '--pr', '1'], ['inspect', '--repo', 'a/b', '--pr', '0'], ['collect', '--resume', '/tmp/x', '--repo', 'a/b'], ['inspect', '--repo', 'a/b', '--pr', '1', '--execute', 'rm'], ['inspect', '--repo', 'a/b', '--pr', '1', '--transport', 'relay']]) {
    await assert.rejects(() => exec(process.execPath, [cli, ...args], { env: { ...process.env, PATH: root } }), e => (e as any).code === 1);
  }
  await assert.rejects(() => lstat(sentinel), { code: 'ENOENT' });
  assert.throws(() => assertEndpoint('https://evil.example/'));
  assert.throws(() => assertEndpoint('repos/a/b/issues/1/comments?per_page=100&page=1&token=x'));
  assert.throws(() => assertEndpoint('repos/a/b/contents/secrets'));
  assert.doesNotThrow(() => assertEndpoint('repos/a/b/git/ref/heads/feature%2Ftarget'));
  assert.doesNotThrow(() => assertEndpoint('repos/a/b/git/ref/heads/' + encodeURIComponent('分支/目标')));
  for (const path of ['repos/a/b/git/matching-refs/heads/main','repos/a/b/git/ref/tags/main','repos/a/b/git/ref/heads/feature/target','repos/a/b/git/ref/heads/%2e%2e','repos/a/b/git/ref/heads/..%2Fx','repos/a/b/git/ref/heads/main%3Ftoken%3Dx','repos/a/b/git/ref/heads/x%5Cy','repos/a/b/git/ref/heads/main?x=1','repos/a/b/git/ref/heads/%ZZ','repos/a/b/git/ref/heads/x%2F.git','repos/a/b/git/ref/heads/x.lock']) assert.throws(() => assertEndpoint(path));
  assert.equal(parseArgs(['inspect', '--repo', 'a/b', '--pr', '1', '--issue', '2', '--issue', '2']).issues.length, 1);
});

test('inspect resolves its system temporary-directory alias without relaxing explicit output paths', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tongxu-temp-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const physical = join(root, 'physical'), alias = join(root, 'alias'), called = join(root, 'called');
  await mkdir(physical); await symlink(physical, alias);
  await writeFile(join(root, 'gh'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(called)},'called');process.exit(9);\n`, { mode: 0o700 });
  const env = { ...process.env, TMPDIR: alias, PATH: root };
  await assert.rejects(exec(process.execPath, [cli, 'inspect', '--repo', 'example/project', '--pr', '12'], { env }), e => (e as any).code === 2);
  assert.equal(await readFile(called, 'utf8'), 'called');
  assert.deepEqual(await readdir(physical), []); // The owned inspect directory was cleaned.
  await rm(called);
  await assert.rejects(exec(process.execPath, [cli, 'collect', '--repo', 'example/project', '--pr', '12', '--output', join(alias, 'out')], { env }), e => (e as any).code === 1);
  await assert.rejects(lstat(called), { code: 'ENOENT' });
});

test('gh preserves body bytes and selected coverage headers but drops authentication headers', () => {
  const body = '[ {"body": "verbatim\\ntext"} ]\n';
  const response = parseGh(`HTTP/2.0 200 OK\r\nLink: <https://api.github.com/repos/a/b/issues/1/comments?per_page=100&page=2>; rel="next"\r\nAuthorization: secret\r\nSet-Cookie: secret\r\n\r\n${body}`);
  assert.equal(response.body, body); assert.equal(response.status, 200);
  assert.ok(response.headers.link); assert.equal(response.headers.authorization, undefined); assert.equal(response.headers['set-cookie'], undefined);
});

test('gh fixes github.com even when GH_HOST selects another existing identity', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tongxu-gh-host-')); t.after(() => rm(root, { recursive: true, force: true }));
  const record = join(root, 'args.json');
  await writeFile(join(root, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2),host:process.env.GH_HOST})); process.stdout.write('HTTP/2.0 200 OK\\r\\n\\r\\n{}');\n`, { mode: 0o700 });
  const path = process.env.PATH, host = process.env.GH_HOST;
  process.env.PATH = `${root}:${path}`; process.env.GH_HOST = 'enterprise.example.invalid';
  try { assert.equal((await new GhTransport().get('repos/example/project/pulls/12')).status, 200); }
  finally { process.env.PATH = path; if (host === undefined) delete process.env.GH_HOST; else process.env.GH_HOST = host; }
  const value = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(value.host, 'enterprise.example.invalid'); // No hidden identity/environment migration.
  assert.equal(value.args[value.args.indexOf('--hostname') + 1], 'github.com');
  assert.equal(value.args[value.args.indexOf('--method') + 1], 'GET');
});

test('fixed Git diff uses merge base and leaves an author checkout/index unchanged', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tongxu-git-')); t.after(() => rm(root, { recursive: true, force: true }));
  const g = async (...args: string[]) => (await exec('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args])).stdout.trim();
  await g('init', '-b', 'main'); await writeFile(join(root, 'file'), 'base\n'); await g('add', '.'); await g('commit', '-m', 'base');
  const mergeBase = await g('rev-parse', 'HEAD');
  await g('switch', '-c', 'candidate'); await writeFile(join(root, 'file'), 'candidate\n'); await g('commit', '-am', 'candidate');
  const head = await g('rev-parse', 'HEAD');
  await g('switch', 'main'); await writeFile(join(root, 'independent'), 'target progressed\n'); await g('add', '.'); await g('commit', '-m', 'target');
  const base = await g('rev-parse', 'HEAD');
  await writeFile(join(root, 'file'), 'author dirty state\n');
  const status = await g('status', '--porcelain=v1'); const index = hash(await readFile(join(root, '.git/index')));
  const result = await readFixedObjects({ repository: 'a/b', pr: 1, H: head, B: base, targetRef: 'main', mergeBase: null, observedAt: 'fixture' }, root);
  assert.equal(result.mergeBase, mergeBase); assert.deepEqual(result.files, ['file']); assert.deepEqual(result.commits, [head]);
  assert.match(result.patch.toString(), /\+candidate/); assert.doesNotMatch(result.patch.toString(), /author dirty|target progressed/);
  assert.equal(await g('status', '--porcelain=v1'), status); assert.equal(hash(await readFile(join(root, '.git/index'))), index); assert.equal(await g('rev-parse', 'HEAD'), base);
  await assert.rejects(() => readFixedObjects({ repository: 'a/b', pr: 1, H, B: base, targetRef: 'main', mergeBase: null, observedAt: 'fixture' }, root));
});

test('real CLI process survives SIGKILL via a new relay session; old raw page stays immutable', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tongxu-process-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  // Only Git transport is a fixture here; production Git calculations have their own real fixture above.
  await writeFile(join(bin, 'git'), `#!${process.execPath}\nconst a=process.argv.slice(2); if(a.includes('rev-parse')) process.stdout.write(a.at(-1).slice(0,40)+'\\n'); else if(a.includes('merge-base')) process.stdout.write('${M}\\n'); else if(a.includes('--name-only')) process.stdout.write('file\\0'); else if(a.includes('rev-list')) process.stdout.write('${H}\\n'); else if(a.includes('diff')) process.stdout.write('patch');\n`, { mode: 0o700 });
  const output = join(root, 'out');
  const initial = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, body: `comment ${i + 1}` }));
  async function start(relay: string, resume: boolean, stopOnPage2: boolean): Promise<number | null> {
    await mkdir(relay, { mode: 0o700 });
    const args = resume ? ['collect', '--resume', output] : ['collect', '--repo', 'example/project', '--pr', '12', '--output', output];
    const child = spawn(process.execPath, [cli, ...args, '--transport', 'relay', '--relay-dir', relay], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); });
    let finished = false;
    const ended = once(child, 'exit').then(([code]) => { finished = true; return code as number | null; });
    const rows = resume ? initial.slice(1) : initial;
    let lastId = '';
    while (!finished) {
      let request: any;
      try { request = JSON.parse(await readFile(join(relay, 'request.json'), 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (!request || request.id === lastId) { await delay(5); continue; }
      lastId = request.id;
      if (stopOnPage2 && request.endpoint.endsWith('/issues/12/comments?per_page=100&page=2')) { child.kill('SIGKILL'); return ended; }
      const ep: string = request.endpoint; const page = Number(new URL(`https://x/${ep}`).searchParams.get('page'));
      let data: any = [];
      if (ep.endsWith('/pulls/12')) data = { id: 12, number: 12, head: { sha: H }, base: { sha: B, ref: 'stacked/base', repo: { full_name: 'example/project' } }, body: 'body', updated_at: '2026-01-01T00:00:00Z', comments: rows.length, review_comments: 0, commits: 1, changed_files: 1 };
      else if (ep.includes('/git/ref/heads/')) data = { ref: 'refs/heads/stacked/base', object: { type: 'commit', sha: B } };
      else if (ep.includes('/issues/12/comments')) data = rows.slice((page - 1) * 100, page * 100);
      else if (ep.includes('/commits?')) data = [{ sha: H }];
      else if (ep.includes('/files?')) data = [{ filename: 'file' }];
      const temp = join(relay, 'response.tmp');
      await writeFile(temp, JSON.stringify({ id: request.id, status: 200, body: JSON.stringify(data) }), { mode: 0o600 });
      await rename(temp, join(relay, 'response.json'));
    }
    return ended;
  }
  assert.equal(await start(join(root, 'relay1'), false, true), null);
  const first = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(first.rounds[0].coverage.pr_comments.records, 100);
  const oldPage = first.artifacts.find((a: any) => a.kind === 'pr_comments');
  assert.equal(await start(join(root, 'relay2'), true, false), 0);
  const final = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(final.rounds.length, 2); assert.equal(final.rounds[1].coverage.pr_comments.records, 100);
  assert.equal(hash(await readFile(join(output, oldPage.path))), oldPage.sha256);
  assert.ok((await readdir(output)).some(x => x.startsWith('abandoned-lock-')));
});

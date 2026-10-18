import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Response, Transport } from './contract.js';

const exec = promisify(execFile);
// No arbitrary URL, mutation, GraphQL, account or credential endpoint can cross this boundary.
export function assertEndpoint(path: string): void {
  if (!/^repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/(?:pulls\/[1-9]\d*(?:\/(?:comments|reviews|commits|files))?|issues\/[1-9]\d*(?:\/comments)?)(?:\?per_page=100&page=[1-9]\d*)?$/.test(path)) {
    throw new Error('invalid_read_endpoint');
  }
}
export function parseGh(output: string): Response {
  const boundary = /\r?\n\r?\n/.exec(output);
  if (!boundary) throw new Error('missing_http_headers');
  const header = output.slice(0, boundary.index);
  const status = Number(/^HTTP\/\S+\s+(\d+)/.exec(header)?.[1]);
  if (!status) throw new Error('invalid_http_status');
  const headers: Record<string, string> = {};
  for (const line of header.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) {
      const key = line.slice(0, i).toLowerCase();
      // Retain only pagination / rate / freshness evidence; never authentication headers.
      if (['link', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'etag', 'date'].includes(key)) headers[key] = line.slice(i + 1).trim();
    }
  }
  return { status, body: output.slice(boundary.index + boundary[0].length), headers, provenance: 'gh-http-body' };
}
export class GhTransport implements Transport {
  async get(endpoint: string): Promise<Response> {
    assertEndpoint(endpoint);
    try {
      const { stdout } = await exec('gh', ['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
      return parseGh(stdout);
    } catch (error) {
      // gh may return a useful HTTP error response on stdout. Never expose its stderr.
      const stdout = (error as { stdout?: string }).stdout;
      if (stdout) { try { return parseGh(stdout); } catch { /* no usable response */ } }
      throw new Error('gh_unavailable_or_network_error');
    }
  }
}

// Foreground mailbox for an explicitly selected, existing read-only connector.
// The caller supplies live responses. It is neither a replay engine nor a background queue.
export class RelayTransport implements Transport {
  constructor(private directory: string, private timeoutMs = 30_000) {}
  async get(endpoint: string): Promise<Response> {
    assertEndpoint(endpoint);
    const id = randomUUID();
    const request = join(this.directory, 'request.json');
    const response = join(this.directory, 'response.json');
    try { await lstat(request); throw new Error('relay_request_already_exists'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const temp = join(this.directory, `${id}.tmp`);
    await writeFile(temp, JSON.stringify({ id, method: 'GET', endpoint }), { mode: 0o600, flag: 'wx' });
    await rename(temp, request);
    const end = Date.now() + this.timeoutMs;
    try {
      while (Date.now() < end) {
        try {
          const stat = await lstat(response);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('invalid_relay_response');
          const r = JSON.parse(await readFile(response, 'utf8'));
          if (r.id !== id || !Number.isInteger(r.status) || r.status < 100 || r.status > 599 || typeof r.body !== 'string') throw new Error('invalid_relay_response');
          await unlink(response);
          return { status: r.status, body: r.body, headers: {}, provenance: 'connector-json-no-http-headers' };
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        await delay(100);
      }
      throw new Error('relay_response_timeout');
    } finally { await unlink(request).catch(() => {}); }
  }
}

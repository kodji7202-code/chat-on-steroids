import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { CreateScheduledJob } from '../main/jobs/types.js';
import type { JobDaemonEndpoint, JobDaemonList } from './protocol.js';

export class JobDaemonClient {
  constructor(private readonly stateDir: string, private readonly timeoutMs = 5_000) {}

  private async credentials(): Promise<{ endpoint: JobDaemonEndpoint; token: string }> {
    const directory = path.join(this.stateDir, 'daemon');
    const [rawEndpoint, rawToken] = await Promise.all([
      fs.readFile(path.join(directory, 'endpoint.json'), 'utf8'),
      fs.readFile(path.join(directory, 'token'), 'utf8')
    ]);
    const endpoint = JSON.parse(rawEndpoint) as JobDaemonEndpoint;
    if (endpoint.protocol !== 1 || !Number.isSafeInteger(endpoint.port)) throw new Error('daemon endpoint is invalid');
    return { endpoint, token: rawToken.trim() };
  }

  async request(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown): Promise<{ status: number; body: any }> {
    const { endpoint, token } = await this.credentials();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: endpoint.port, path: route, method, headers: {
        authorization: `Bearer ${token}`,
        host: `127.0.0.1:${endpoint.port}`,
        ...(payload ? { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) } : {})
      } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('daemon request timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async create(job: CreateScheduledJob): Promise<unknown> {
    const reply = await this.request('POST', '/v1/jobs', job);
    if (reply.status !== 200) throw new Error(`daemon refused job (${reply.status}): ${JSON.stringify(reply.body)}`);
    return reply.body;
  }

  async list(): Promise<JobDaemonList> {
    const reply = await this.request('GET', '/v1/jobs');
    if (reply.status !== 200) throw new Error(`daemon list failed (${reply.status})`);
    return reply.body as JobDaemonList;
  }

  async cancel(id: string): Promise<boolean> {
    const reply = await this.request('DELETE', `/v1/jobs/${encodeURIComponent(id)}`);
    if (reply.status !== 200) throw new Error(`daemon cancel failed (${reply.status})`);
    return reply.body?.cancelled === true;
  }
}

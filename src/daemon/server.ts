import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ControlApiClient } from '../main/jobs/control-client.js';
import { JobRunner } from '../main/jobs/runner.js';
import { JobStore } from '../main/jobs/store.js';
import { type CreateScheduledJob, UUID_RE, validateCreateJob } from '../main/jobs/types.js';
import { JOB_DAEMON_PROTOCOL, type JobDaemonEndpoint, type JobDaemonHealth } from './protocol.js';

const DIRECTORY = 'daemon';
const TOKEN_FILE = 'token';
const ENDPOINT_FILE = 'endpoint.json';
const WRITER_LOCK_FILE = 'writer.lock';
const MAX_BODY_BYTES = 256 * 1024;

export interface JobDaemonOptions {
  stateDir: string;
  appDataDir: string;
  tickMs?: number;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function writePrivate(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, target);
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store'
  });
  res.end(text);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const declared = req.headers['content-length'];
  if (!declared || !/^\d+$/.test(declared)) throw new Error('content_length_required');
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_BODY_BYTES) throw new Error('invalid_body_size');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new Error('unsupported_media_type');
  if (req.headers['transfer-encoding'] !== undefined || req.headers['content-encoding'] !== undefined) throw new Error('invalid_framing');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > length || total > MAX_BODY_BYTES) {
        reject(new Error('invalid_body_size'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total !== length) return reject(new Error('invalid_body_size'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request_aborted')));
  });
}

export class JobDaemonServer {
  readonly store: JobStore;
  readonly control: ControlApiClient;
  readonly runner: JobRunner;
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tickFlight: Promise<void> | null = null;
  private startedAt = '';
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  private readonly tickMs: number;
  private readonly directory: string;
  /** Exclusive on-disk writer admission; duplicate daemon instances must never reserve jobs. */
  private writerLock: Awaited<ReturnType<typeof fs.open>> | null = null;

  constructor(options: JobDaemonOptions) {
    this.tickMs = Math.max(250, Math.min(options.tickMs ?? 5_000, 60_000));
    this.directory = path.join(options.stateDir, DIRECTORY);
    this.store = new JobStore(options.stateDir);
    this.control = new ControlApiClient(options.appDataDir);
    this.runner = new JobRunner(this.store, this.control);
  }

  port(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await fs.mkdir(this.directory, { recursive: true });
    try {
      this.writerLock = await fs.open(path.join(this.directory, WRITER_LOCK_FILE), 'wx', 0o600);
      await this.writerLock.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    } catch (error) {
      if (this.writerLock) await this.releaseWriterLock();
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('jobs_writer_busy: another daemon owns this state directory (or a prior crash left a lock; verify it is stopped before removing writer.lock)');
      }
      throw error;
    }
    try {
      await this.startLocked();
    } catch (error) {
      await this.releaseWriterLock();
      throw error;
    }
  }

  private async startLocked(): Promise<void> {
    await this.store.load();
    const token = randomBytes(32).toString('base64url');
    const instance = http.createServer((req, res) => {
      void this.handle(req, res, token, instance).catch((error: Error) => reply(res, 500, { error: 'internal_error', detail: error.message.slice(0, 200) }));
    });
    instance.headersTimeout = 10_000;
    instance.requestTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      instance.once('error', reject);
      instance.listen(0, '127.0.0.1', () => { instance.off('error', reject); resolve(); });
    });
    this.server = instance;
    this.startedAt = new Date().toISOString();
    const endpoint: JobDaemonEndpoint = { protocol: JOB_DAEMON_PROTOCOL, port: this.port()!, pid: process.pid, startedAt: this.startedAt };
    try {
      await writePrivate(path.join(this.directory, TOKEN_FILE), `${token}\n`);
      await writePrivate(path.join(this.directory, ENDPOINT_FILE), `${JSON.stringify(endpoint, null, 2)}\n`);
    } catch (error) {
      await this.stopServer(instance);
      this.server = null;
      throw error;
    }
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    const instance = this.server;
    // Publish shutdown before waiting for a running tick. Its finally block must not arm another
    // scheduler timer while stop is waiting on it.
    this.server = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tickFlight?.catch(() => undefined);
    this.tickFlight = null;
    // A refused second instance must never clear the real daemon's endpoint credentials.
    if (!this.writerLock) return;
    try {
      await fs.rm(path.join(this.directory, ENDPOINT_FILE), { force: true });
      await fs.rm(path.join(this.directory, TOKEN_FILE), { force: true });
      if (instance) await this.stopServer(instance);
    } finally {
      await this.releaseWriterLock();
    }
  }

  private async releaseWriterLock(): Promise<void> {
    const owned = this.writerLock;
    this.writerLock = null;
    if (!owned) return;
    await owned.close();
    await fs.rm(path.join(this.directory, WRITER_LOCK_FILE), { force: true });
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.tickFlight) return this.tickFlight;
    const work = this.runner.tick(now).then(() => {
      this.lastTickAt = now;
      this.lastError = null;
    }, (error: Error) => {
      this.lastTickAt = now;
      this.lastError = error.message.slice(0, 500);
      throw error;
    });
    this.tickFlight = work;
    try { await work; }
    finally { if (this.tickFlight === work) this.tickFlight = null; }
  }

  private scheduleTick(delay: number): void {
    if (!this.server) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => undefined).finally(() => this.scheduleTick(this.tickMs));
    }, delay);
  }

  private stopServer(instance: http.Server): Promise<void> {
    return new Promise((resolve) => {
      instance.close(() => resolve());
      instance.closeIdleConnections();
    });
  }

  private async health(): Promise<JobDaemonHealth> {
    const state = await this.store.list();
    return {
      ok: true,
      protocol: JOB_DAEMON_PROTOCOL,
      pid: process.pid,
      startedAt: this.startedAt,
      jobs: state.jobs.length,
      pending: state.receipts.filter((receipt) => receipt.state === 'reserved' || receipt.state === 'admitted').length,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string, instance: http.Server): Promise<void> {
    if (req.headers.origin !== undefined) return reply(res, 403, { error: 'origin_forbidden' });
    const port = (instance.address() as AddressInfo | null)?.port;
    if (!port || (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)) return reply(res, 403, { error: 'host_forbidden' });
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) return reply(res, 401, { error: 'unauthorized' });
    const target = req.url ?? '/';
    if (!/^\/[^\\]*$/.test(target) || target.startsWith('//')) return reply(res, 400, { error: 'invalid_target' });
    const url = new URL(target, 'http://127.0.0.1');
    if (url.search) return reply(res, 400, { error: 'invalid_query' });

    if (req.method === 'GET' && url.pathname === '/v1/health') return reply(res, 200, await this.health());
    if (req.method === 'GET' && url.pathname === '/v1/jobs') return reply(res, 200, await this.store.list());
    if (req.method === 'POST' && url.pathname === '/v1/jobs') {
      let body: unknown;
      try { body = await readJson(req); }
      catch (error) { return reply(res, 400, { error: (error as Error).message }); }
      let input: CreateScheduledJob;
      try { input = validateCreateJob(body as CreateScheduledJob); }
      catch (error) { return reply(res, 400, { error: 'invalid_job', detail: (error as Error).message }); }
      try { return reply(res, 200, { job: await this.store.create(input) }); }
      catch (error) {
        if ((error as Error).message.includes('already belongs')) return reply(res, 409, { error: 'id_conflict' });
        throw error;
      }
    }
    const cancel = /^\/v1\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'DELETE' && cancel) {
      if (!UUID_RE.test(cancel[1]!)) return reply(res, 400, { error: 'invalid_job_id' });
      return reply(res, 200, { cancelled: await this.store.cancel(cancel[1]!) });
    }
    return reply(res, 404, { error: 'not_found' });
  }
}

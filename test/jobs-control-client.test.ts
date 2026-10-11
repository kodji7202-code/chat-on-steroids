import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlApiClient } from '../src/main/jobs/control-client.js';
import type { JobReceipt } from '../src/main/jobs/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
let server: http.Server | null = null;
let actions = true;
let browserPresent = true;
let blocked = '';
let posted: any = null;

beforeEach(async () => {
  dir = await makeTempDir('cos-control-client-');
  actions = true;
  browserPresent = true;
  blocked = '';
  posted = null;
  server = http.createServer((req, res) => {
    const answer = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) });
      res.end(text);
    };
    if (req.headers.authorization !== 'Bearer test-token') return answer(401, { error: 'unauthorized' });
    if (req.url === '/v1/health') return answer(200, { ok: true, protocol: 1, actions: { enabled: actions, routes: [] } });
    if (req.url === '/v1/status') return answer(200, { bridge: { running: true, paired: true, present: browserPresent } });
    if (req.url?.startsWith('/v1/sessions/')) return answer(200, { session: { conversationId: 'chat-1' }, live: { blocked } });
    if (req.url === '/v1/inputs' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        posted = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        answer(202, { input: { id: posted.id, delivery: 'pending' }, replayed: false });
      });
      return;
    }
    if (req.url === '/v1/inputs?limit=500') return answer(200, { inputs: [], total: 0 });
    return answer(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const controlDir = path.join(dir, 'control-api');
  await fs.mkdir(controlDir, { recursive: true });
  await fs.writeFile(path.join(controlDir, 'endpoint.json'), JSON.stringify({ protocol: 1, port, pid: 1, appVersion: 'test', startedAt: new Date().toISOString() }));
  await fs.writeFile(path.join(controlDir, 'token'), 'test-token\n');
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  await removeTempDir(dir);
});

describe('job control API client', () => {
  it('checks live action permission, browser observation and target block state at fire time', async () => {
    const client = new ControlApiClient(dir);
    expect(await client.preflight('2026-10-11-a1b2c3d4')).toEqual({ ok: true });
    actions = false;
    expect(await client.preflight('2026-10-11-a1b2c3d4')).toMatchObject({ ok: false, retryable: false, code: 'actions_disabled' });
    actions = true;
    browserPresent = false;
    expect(await client.preflight('2026-10-11-a1b2c3d4')).toMatchObject({ ok: false, retryable: true, code: 'browser_unobserved' });
    browserPresent = true;
    blocked = 'blocked';
    expect(await client.preflight('2026-10-11-a1b2c3d4')).toMatchObject({ ok: false, retryable: false, code: 'chat_blocked' });
  });

  it('posts only the existing control API send contract with the reserved outbox id', async () => {
    const client = new ControlApiClient(dir);
    const receipt = {
      id: '10000000-0000-4000-8000-000000000001', jobId: '10000000-0000-4000-8000-000000000002', scheduledAt: 1,
      outboxId: '10000000-0000-4000-8000-000000000003', sessionId: '2026-10-11-a1b2c3d4', text: 'Scheduled text', interrupt: true,
      missedRun: { mode: 'fire-once' }, state: 'reserved', createdAt: 1, updatedAt: 1, attempts: 0, admittedAt: null, lastError: null
    } satisfies JobReceipt;
    const reply = await client.send(receipt);
    expect(reply.status).toBe(202);
    expect(posted).toEqual({ id: receipt.outboxId, sessionId: receipt.sessionId, text: receipt.text, interrupt: true });
  });
});

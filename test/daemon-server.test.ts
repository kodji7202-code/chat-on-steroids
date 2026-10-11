import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobDaemonClient } from '../src/daemon/client.js';
import { JobDaemonServer } from '../src/daemon/server.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let stateDir: string;
let appDataDir: string;
let daemon: JobDaemonServer | null = null;

beforeEach(async () => {
  stateDir = await makeTempDir('cos-daemon-state-');
  appDataDir = await makeTempDir('cos-daemon-app-');
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  await removeTempDir(stateDir);
  await removeTempDir(appDataDir);
});

async function endpoint() {
  const directory = path.join(stateDir, 'daemon');
  const data = JSON.parse(await fs.readFile(path.join(directory, 'endpoint.json'), 'utf8')) as { port: number; protocol: number; pid: number };
  const token = (await fs.readFile(path.join(directory, 'token'), 'utf8')).trim();
  return { ...data, token };
}

function raw(port: number, route: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('isolated jobs daemon', () => {
  it('publishes only a per-launch authenticated loopback endpoint', async () => {
    daemon = new JobDaemonServer({ stateDir, appDataDir, tickMs: 60_000 });
    await daemon.start();
    const found = await endpoint();
    expect(found).toMatchObject({ protocol: 1, pid: process.pid, port: daemon.port() });
    expect(found.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await raw(found.port, '/v1/health')).status).toBe(401);
    expect((await raw(found.port, '/v1/health', { authorization: `Bearer ${found.token}`, origin: 'https://example.com' })).status).toBe(403);
    expect((await raw(found.port, '/v1/health', { authorization: `Bearer ${found.token}`, host: 'example.com' })).status).toBe(403);
    const health = await raw(found.port, '/v1/health', { authorization: `Bearer ${found.token}` });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, protocol: 1, jobs: 0, pending: 0 });
  });

  it('schedules and cancels through IPC while the daemon remains the only job-store writer', async () => {
    daemon = new JobDaemonServer({ stateDir, appDataDir, tickMs: 60_000 });
    await daemon.start();
    const client = new JobDaemonClient(stateDir);
    const id = randomUUID();
    const at = Date.now() + 60_000;
    await client.create({
      id, sessionId: '2026-10-11-a1b2c3d4', text: 'Run later',
      schedule: { kind: 'once', at }, missedRun: { mode: 'fire-once' }
    });
    expect((await client.list()).jobs).toEqual([expect.objectContaining({ id, nextAt: at, enabled: true })]);
    expect(await client.cancel(id)).toBe(true);
    expect((await client.list()).jobs[0]).toMatchObject({ id, enabled: false, nextAt: null });
  });

  it('admits only one daemon writer per state directory and never lets a rejected instance erase the real endpoint', async () => {
    daemon = new JobDaemonServer({ stateDir, appDataDir, tickMs: 60_000 });
    await daemon.start();
    const first = await endpoint();
    const second = new JobDaemonServer({ stateDir, appDataDir, tickMs: 60_000 });
    await expect(second.start()).rejects.toThrow('jobs_writer_busy');
    await second.stop();
    expect(await endpoint()).toEqual(first);
    expect((await raw(first.port, '/v1/health', { authorization: `Bearer ${first.token}` })).status).toBe(200);
    await daemon.stop();
    daemon = null;
    await second.start();
    daemon = second;
    expect((await endpoint()).port).toBe(second.port());
  });

  it('persists a due fire but does not send when the GUI control API is absent', async () => {
    daemon = new JobDaemonServer({ stateDir, appDataDir, tickMs: 60_000 });
    await daemon.start();
    const client = new JobDaemonClient(stateDir);
    const now = Date.now();
    await client.create({
      id: randomUUID(), sessionId: '2026-10-11-a1b2c3d4', text: 'Do not fake headless ChatGPT',
      schedule: { kind: 'once', at: now - 1 }, missedRun: { mode: 'fire-once' }
    });
    await daemon.tick(now);
    const state = await client.list();
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]).toMatchObject({ state: 'reserved', lastError: expect.stringContaining('app_unavailable') });
    expect(state.jobs[0]).toMatchObject({ enabled: false, nextAt: null });
  });

  it('removes discovery credentials when stopped while retaining the job ledger', async () => {
    daemon = new JobDaemonServer({ stateDir, appDataDir, tickMs: 60_000 });
    await daemon.start();
    const client = new JobDaemonClient(stateDir);
    await client.create({ id: randomUUID(), sessionId: '2026-10-11-a1b2c3d4', text: 'Persist me', schedule: { kind: 'once', at: Date.now() + 60_000 }, missedRun: { mode: 'fire-once' } });
    await daemon.stop();
    daemon = null;
    await expect(fs.access(path.join(stateDir, 'daemon', 'endpoint.json'))).rejects.toThrow();
    await expect(fs.access(path.join(stateDir, 'daemon', 'token'))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(stateDir, 'jobs.json'), 'utf8')).jobs).toHaveLength(1);
  });
});

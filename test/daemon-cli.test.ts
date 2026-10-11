import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runDaemonCli } from '../src/daemon/cli.js';
import { JobDaemonServer } from '../src/daemon/server.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let stateDir: string;
let appDataDir: string;
let daemon: JobDaemonServer;

beforeEach(async () => {
  stateDir = await makeTempDir('cos-daemon-cli-state-');
  appDataDir = await makeTempDir('cos-daemon-cli-app-');
  daemon = new JobDaemonServer({ stateDir, appDataDir, tickMs: 60_000 });
  await daemon.start();
});

afterEach(async () => {
  await daemon.stop();
  await removeTempDir(stateDir);
  await removeTempDir(appDataDir);
});

it('uses authenticated daemon IPC for schedule, list and cancel CLI commands', async () => {
  const out: string[] = [];
  const errors: string[] = [];
  const io = { out: (text: string) => out.push(text), error: (text: string) => errors.push(text) };
  const id = randomUUID();
  const at = Date.now() + 60_000;
  expect(await runDaemonCli([
    'schedule', '--state-dir', stateDir, '--id', id, '--session', '2026-10-11-a1b2c3d4',
    '--text', 'CLI scheduled work', '--at', String(at), '--missed', 'skip', '--grace-ms', '30000'
  ], io)).toBe(0);
  expect(errors).toEqual([]);
  expect(JSON.parse(out.pop()!).job).toMatchObject({ id, nextAt: at });

  expect(await runDaemonCli(['list', '--state-dir', stateDir], io)).toBe(0);
  expect(JSON.parse(out.pop()!).jobs[0]).toMatchObject({ id, enabled: true });

  expect(await runDaemonCli(['cancel', '--state-dir', stateDir, '--id', id], io)).toBe(0);
  expect(JSON.parse(out.pop()!)).toEqual({ cancelled: true });
});

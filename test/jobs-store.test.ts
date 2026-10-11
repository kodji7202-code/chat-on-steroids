import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/main/jobs/store.js';
import type { CreateScheduledJob } from '../src/main/jobs/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
const BASE = 1_800_000_000_000;

const oneShot = (overrides: Partial<CreateScheduledJob> = {}): CreateScheduledJob => ({
  id: randomUUID(),
  sessionId: '2026-10-11-a1b2c3d4',
  text: 'Run the scheduled check.',
  schedule: { kind: 'once', at: BASE },
  missedRun: { mode: 'fire-once' },
  ...overrides
});

beforeEach(async () => { dir = await makeTempDir('cos-jobs-'); });
afterEach(async () => { await removeTempDir(dir); });

describe('persistent scheduled job store', () => {
  it('durably reserves one exact outbox id before a one-shot is considered consumed', async () => {
    const store = new JobStore(dir);
    await store.load();
    const job = await store.create(oneShot(), BASE - 5_000);
    const [receipt] = await store.reserveDue(BASE);
    expect(receipt).toMatchObject({ jobId: job.id, scheduledAt: BASE, state: 'reserved', attempts: 0 });
    expect(receipt!.outboxId).toMatch(/^[0-9a-f-]{36}$/);

    const restarted = new JobStore(dir);
    await restarted.load();
    const state = await restarted.list();
    expect(state.jobs[0]).toMatchObject({ id: job.id, enabled: false, nextAt: null });
    expect(state.receipts[0]).toMatchObject({ id: receipt!.id, outboxId: receipt!.outboxId, state: 'reserved' });
    expect(await restarted.reserveDue(BASE + 1)).toEqual([]);
  });

  it('collapses missed recurring fire-once periods to one latest occurrence', async () => {
    const store = new JobStore(dir);
    await store.load();
    const id = randomUUID();
    await store.create({
      id, sessionId: '2026-10-11-a1b2c3d4', text: 'Recurring work',
      schedule: { kind: 'interval', anchorAt: BASE, everyMs: 60_000 },
      missedRun: { mode: 'fire-once' }
    }, BASE - 1);
    const [receipt] = await store.reserveDue(BASE + 3 * 60_000 + 30_000);
    expect(receipt?.scheduledAt).toBe(BASE + 3 * 60_000);
    expect((await store.list()).jobs[0]?.nextAt).toBe(BASE + 4 * 60_000);
  });

  it('skips a recurring occurrence that is beyond its explicit grace window', async () => {
    const store = new JobStore(dir);
    await store.load();
    await store.create({
      id: randomUUID(), sessionId: '2026-10-11-a1b2c3d4', text: 'Windowed work',
      schedule: { kind: 'interval', anchorAt: BASE, everyMs: 60_000 },
      missedRun: { mode: 'skip', graceMs: 10_000 }
    }, BASE - 1);
    const [receipt] = await store.reserveDue(BASE + 5 * 60_000 + 30_000);
    expect(receipt).toMatchObject({ scheduledAt: BASE + 5 * 60_000, state: 'skipped', lastError: 'missed scheduled window' });
    expect((await store.list()).jobs[0]?.nextAt).toBe(BASE + 6 * 60_000);
  });

  it('replays an identical job id but refuses to retarget it', async () => {
    const store = new JobStore(dir);
    await store.load();
    const input = oneShot();
    const first = await store.create(input, BASE - 10);
    expect((await store.create({ ...input }, BASE)).id).toBe(first.id);
    await expect(store.create({ ...input, text: 'Different work' }, BASE)).rejects.toThrow(/different schedule/);
  });

  it('can cancel a one-shot after it was reserved but before admission', async () => {
    const store = new JobStore(dir);
    await store.load();
    const job = await store.create(oneShot(), BASE - 1);
    await store.reserveDue(BASE);
    expect((await store.list()).jobs[0]).toMatchObject({ enabled: false, nextAt: null });
    expect(await store.cancel(job.id, BASE + 1)).toBe(true);
    expect((await store.list()).receipts[0]).toMatchObject({ state: 'skipped', lastError: 'job cancelled before admission' });
  });
});

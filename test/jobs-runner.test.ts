import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlApiInput } from '../src/shared/control-api.js';
import { ControlApiClient, type FirePreflight, type SendAdmission } from '../src/main/jobs/control-client.js';
import { JobRunner } from '../src/main/jobs/runner.js';
import { JobStore } from '../src/main/jobs/store.js';
import type { JobReceipt } from '../src/main/jobs/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const BASE = 1_800_100_000_000;
let dir: string;

const projected = (id: string, delivery: ControlApiInput['delivery'] = 'pending'): ControlApiInput => ({
  id, sessionId: '2026-10-11-a1b2c3d4', deliveredSessionId: null, conversationId: 'chat-1', state: delivery === 'sent' ? 'sent' : 'queued',
  delivery, mode: 'auto', transportIntent: 'browser', automatic: false, purpose: null, createdAt: BASE, dueAt: BASE,
  offeredAt: null, deliveredAt: delivery === 'sent' ? BASE : null, sendAuthorizedAt: null, requiresAuthorization: false,
  cancelledByUser: false, queueOrder: null, model: null, reasoningEffort: null, messageId: delivery === 'sent' ? 'msg-1' : null,
  error: null, text: { text: 'scheduled', chars: 9, truncated: false }, attachments: 0, images: 0
});

class FakeControl extends ControlApiClient {
  preflightResult: FirePreflight = { ok: true };
  sends: JobReceipt[] = [];
  sendResults: Array<SendAdmission | Error> = [];
  observed = new Map<string, ControlApiInput>();
  constructor() { super('unused'); }
  override async preflight(): Promise<FirePreflight> { return this.preflightResult; }
  override async send(receipt: JobReceipt): Promise<SendAdmission> {
    this.sends.push(receipt);
    const next = this.sendResults.shift() ?? { status: 202, body: { input: projected(receipt.outboxId), replayed: false } };
    if (next instanceof Error) throw next;
    return next;
  }
  override async findInput(id: string): Promise<ControlApiInput | null> { return this.observed.get(id) ?? null; }
}

async function due(store: JobStore, missedRun: { mode: 'fire-once' } | { mode: 'skip'; graceMs: number } = { mode: 'fire-once' }) {
  await store.create({ id: randomUUID(), sessionId: '2026-10-11-a1b2c3d4', text: 'scheduled', schedule: { kind: 'once', at: BASE }, missedRun }, BASE - 1);
}

beforeEach(async () => { dir = await makeTempDir('cos-job-runner-'); });
afterEach(async () => { await removeTempDir(dir); });

describe('scheduled job firing', () => {
  it('rechecks action permission at fire time and never reaches send when revoked', async () => {
    const store = new JobStore(dir); await store.load(); await due(store);
    const control = new FakeControl();
    control.preflightResult = { ok: false, retryable: false, code: 'actions_disabled', detail: 'disabled now' };
    await new JobRunner(store, control).tick(BASE);
    expect(control.sends).toHaveLength(0);
    expect((await store.list()).receipts[0]).toMatchObject({ state: 'blocked', lastError: expect.stringContaining('actions_disabled') });
  });

  it('does not pretend an absent app or browser is a headless ChatGPT transport', async () => {
    const store = new JobStore(dir); await store.load(); await due(store, { mode: 'skip', graceMs: 5_000 });
    const control = new FakeControl();
    control.preflightResult = { ok: false, retryable: true, code: 'browser_unobserved', detail: 'no observed browser' };
    const runner = new JobRunner(store, control);
    await runner.tick(BASE);
    expect((await store.list()).receipts[0]).toMatchObject({ state: 'reserved' });
    await runner.tick(BASE + 5_001);
    expect(control.sends).toHaveLength(0);
    expect((await store.list()).receipts[0]).toMatchObject({ state: 'skipped' });
  });

  it('uses the persisted outbox id as the idempotency key when a safe timeout is retried', async () => {
    const store = new JobStore(dir); await store.load(); await due(store);
    const control = new FakeControl();
    control.sendResults.push(
      { status: 504, body: { error: 'timeout', detail: 'the action did not start and will not run; it is safe to send again' } },
      { status: 202, body: null }
    );
    const runner = new JobRunner(store, control);
    await runner.tick(BASE);
    const first = (await store.list()).receipts[0]!;
    expect(first.state).toBe('reserved');
    await runner.tick(BASE + 1);
    expect(control.sends).toHaveLength(2);
    expect(control.sends[0]!.outboxId).toBe(control.sends[1]!.outboxId);
    expect((await store.list()).receipts[0]!.state).toBe('unconfirmed');
  });

  it('never reposts an ambiguous lost response when the outbox cannot prove admission', async () => {
    const store = new JobStore(dir); await store.load(); await due(store);
    const control = new FakeControl();
    control.sendResults.push(new Error('socket reset after write'));
    const runner = new JobRunner(store, control);
    await runner.tick(BASE);
    expect(control.sends).toHaveLength(1);
    expect((await store.list()).receipts[0]).toMatchObject({ state: 'unconfirmed', attempts: 1 });
    await runner.tick(BASE + 60_000);
    expect(control.sends).toHaveLength(1);
  });

  it('treats a control-token rotation between preflight and POST as retryable', async () => {
    const store = new JobStore(dir); await store.load(); await due(store);
    const control = new FakeControl();
    control.sendResults.push({ status: 401, body: { error: 'unauthorized' } });
    const runner = new JobRunner(store, control);
    await runner.tick(BASE);
    const first = (await store.list()).receipts[0]!;
    expect(first.state).toBe('reserved');
    const outboxId = first.outboxId;
    await runner.tick(BASE + 1);
    expect(control.sends).toHaveLength(2);
    expect(control.sends[1]!.outboxId).toBe(outboxId);
  });

  it('tracks admission separately from final delivery and later reconciles the existing outbox row', async () => {
    const store = new JobStore(dir); await store.load(); await due(store);
    const control = new FakeControl();
    const runner = new JobRunner(store, control);
    await runner.tick(BASE);
    const receipt = (await store.list()).receipts[0]!;
    expect(receipt.state).toBe('admitted');
    control.observed.set(receipt.outboxId, projected(receipt.outboxId, 'sent'));
    await runner.tick(BASE + 1);
    expect((await store.list()).receipts[0]!.state).toBe('sent');
    expect(control.sends).toHaveLength(1);
  });
});

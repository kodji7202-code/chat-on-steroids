import type { ControlApiInput } from '../../shared/control-api.js';
import { ControlApiClient } from './control-client.js';
import { JobStore } from './store.js';
import type { JobReceipt } from './types.js';

const MAX_FIRES_PER_TICK = 16;
const ADMISSION_RECONCILE_MS = 12 * 60 * 60_000;

function deliveryState(input: ControlApiInput): JobReceipt['state'] {
  if (input.delivery === 'sent') return 'sent';
  if (input.delivery === 'not_sent') return 'not-sent';
  if (input.delivery === 'unconfirmed') return 'unconfirmed';
  return 'admitted';
}

function errorCode(body: Record<string, unknown> | null): string {
  return typeof body?.error === 'string' ? body.error : 'control_api_error';
}

function errorDetail(body: Record<string, unknown> | null): string {
  const detail = typeof body?.detail === 'string' ? body.detail : '';
  return detail ? `${errorCode(body)}: ${detail}` : errorCode(body);
}

export class JobRunner {
  constructor(private readonly store: JobStore, private readonly control: ControlApiClient) {}

  async tick(now = Date.now()): Promise<void> {
    await this.store.reserveDue(now);
    const actionable = (await this.store.actionable()).slice(0, MAX_FIRES_PER_TICK);
    for (const receipt of actionable) {
      if (receipt.state === 'admitted') await this.reconcile(receipt, now);
      else await this.fire(receipt, now);
    }
  }

  private async reconcile(receipt: JobReceipt, now: number): Promise<void> {
    let input: ControlApiInput | null;
    try { input = await this.control.findInput(receipt.outboxId); }
    catch { return; }
    if (input) {
      const state = deliveryState(input);
      await this.store.updateReceipt(receipt.id, { state, lastError: input.error });
      return;
    }
    if (receipt.admittedAt !== null && now - receipt.admittedAt >= ADMISSION_RECONCILE_MS) {
      await this.store.updateReceipt(receipt.id, { state: 'unconfirmed', lastError: 'admitted outbox row aged out before final delivery proof was observed' }, now);
    }
  }

  private async fire(receipt: JobReceipt, now: number): Promise<void> {
    if (receipt.missedRun.mode === 'skip' && now - receipt.scheduledAt > receipt.missedRun.graceMs) {
      await this.store.updateReceipt(receipt.id, { state: 'skipped', lastError: 'missed scheduled window before admission' }, now);
      return;
    }

    const preflight = await this.control.preflight(receipt.sessionId);
    if (!preflight.ok) {
      if (!preflight.retryable) {
        await this.store.updateReceipt(receipt.id, { state: 'blocked', lastError: `${preflight.code}: ${preflight.detail}` }, now);
      } else {
        await this.store.updateReceipt(receipt.id, { lastError: `${preflight.code}: ${preflight.detail}` }, now);
      }
      return;
    }

    await this.store.updateReceipt(receipt.id, { attempts: receipt.attempts + 1, lastError: null }, now);
    let reply;
    try {
      reply = await this.control.send(receipt);
    } catch (error) {
      // Once the request crossed into the socket, failure is ambiguous. Never POST it again merely
      // because the daemon lost the HTTP response; reconcile the stable outbox UUID first.
      let observed: ControlApiInput | null = null;
      try { observed = await this.control.findInput(receipt.outboxId); } catch { /* app may be gone */ }
      if (observed) {
        await this.store.updateReceipt(receipt.id, { state: deliveryState(observed), admittedAt: now, lastError: observed.error }, now);
      } else {
        await this.store.updateReceipt(receipt.id, { state: 'unconfirmed', lastError: `admission response was lost: ${(error as Error).message}` }, now);
      }
      return;
    }

    if (reply.status === 200 || reply.status === 202) {
      const input = reply.body?.input as ControlApiInput | undefined;
      if (!input || input.id !== receipt.outboxId) {
        await this.store.updateReceipt(receipt.id, { state: 'unconfirmed', lastError: 'control API accepted the action without a matching outbox projection' }, now);
        return;
      }
      await this.store.updateReceipt(receipt.id, { state: deliveryState(input), admittedAt: now, lastError: input.error }, now);
      return;
    }

    const code = errorCode(reply.body);
    if (reply.status === 401) {
      // The app rotates its control token every launch. A restart between preflight and POST is
      // not a permission refusal and does not prove the outbox saw this UUID.
      await this.store.updateReceipt(receipt.id, { lastError: 'control API credentials changed before admission' }, now);
      return;
    }
    if (reply.status === 504) {
      const detail = errorDetail(reply.body);
      if (/did not start and will not run/i.test(detail)) {
        await this.store.updateReceipt(receipt.id, { lastError: detail }, now);
        return;
      }
      let observed: ControlApiInput | null = null;
      try { observed = await this.control.findInput(receipt.outboxId); } catch { /* preserve ambiguity */ }
      await this.store.updateReceipt(receipt.id, observed
        ? { state: deliveryState(observed), admittedAt: now, lastError: observed.error }
        : { state: 'unconfirmed', lastError: detail }, now);
      return;
    }
    if (reply.status === 403 || ['session_not_found', 'session_not_controllable', 'no_chat', 'chat_blocked', 'id_conflict'].includes(code)) {
      await this.store.updateReceipt(receipt.id, { state: 'blocked', lastError: errorDetail(reply.body) }, now);
      return;
    }
    if (code === 'would_interrupt' && !receipt.interrupt) {
      await this.store.updateReceipt(receipt.id, { lastError: errorDetail(reply.body) }, now);
      return;
    }
    if (reply.status === 409 && code === 'busy' || reply.status === 429 || reply.status === 503) {
      await this.store.updateReceipt(receipt.id, { lastError: errorDetail(reply.body) }, now);
      return;
    }
    await this.store.updateReceipt(receipt.id, { state: 'blocked', lastError: errorDetail(reply.body) }, now);
  }
}

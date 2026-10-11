import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type CreateScheduledJob,
  type JobReceipt,
  type JobReceiptState,
  type JobsSnapshot,
  type ScheduledJob,
  UUID_RE,
  SESSION_RE,
  terminalReceipt,
  validateCreateJob
} from './types.js';

const STATE_FILE = 'jobs.json';
const MAX_RECEIPTS = 2_000;

function copyJob(job: ScheduledJob): ScheduledJob {
  return { ...job, schedule: { ...job.schedule }, missedRun: { ...job.missedRun } };
}
function copyReceipt(receipt: JobReceipt): JobReceipt {
  return { ...receipt, missedRun: { ...receipt.missedRun } };
}

function nextAfter(schedule: ScheduledJob['schedule'], scheduledAt: number): number | null {
  return schedule.kind === 'once' ? null : scheduledAt + schedule.everyMs;
}

function latestDue(job: ScheduledJob, now: number): number | null {
  const next = job.nextAt;
  if (!job.enabled || next === null || next > now) return null;
  if (job.schedule.kind === 'once') return next;
  const periods = Math.floor((now - next) / job.schedule.everyMs);
  return next + periods * job.schedule.everyMs;
}

function restoredJob(raw: Partial<ScheduledJob>): ScheduledJob | null {
  try {
    if (typeof raw.id !== 'string' || typeof raw.sessionId !== 'string' || typeof raw.text !== 'string' || !raw.schedule || !raw.missedRun) return null;
    const valid = validateCreateJob({
      id: raw.id,
      sessionId: raw.sessionId,
      text: raw.text,
      interrupt: raw.interrupt === true,
      schedule: raw.schedule,
      missedRun: raw.missedRun
    });
    if (typeof raw.enabled !== 'boolean' || !Number.isSafeInteger(raw.createdAt) || !Number.isSafeInteger(raw.updatedAt)) return null;
    if (raw.nextAt !== null && !Number.isSafeInteger(raw.nextAt)) return null;
    return { ...valid, interrupt: valid.interrupt === true, enabled: raw.enabled, createdAt: raw.createdAt!, updatedAt: raw.updatedAt!, nextAt: raw.nextAt ?? null };
  } catch {
    return null;
  }
}

function restoredReceipt(raw: Partial<JobReceipt>): JobReceipt | null {
  const states = new Set<JobReceiptState>(['reserved', 'admitted', 'sent', 'not-sent', 'unconfirmed', 'blocked', 'skipped']);
  if (
    typeof raw.id !== 'string' || !UUID_RE.test(raw.id) ||
    typeof raw.jobId !== 'string' || !UUID_RE.test(raw.jobId) ||
    typeof raw.outboxId !== 'string' || !UUID_RE.test(raw.outboxId) ||
    typeof raw.sessionId !== 'string' || !SESSION_RE.test(raw.sessionId) ||
    typeof raw.text !== 'string' || typeof raw.interrupt !== 'boolean' ||
    !raw.missedRun || typeof raw.state !== 'string' || !states.has(raw.state as JobReceiptState) ||
    !Number.isSafeInteger(raw.scheduledAt) || !Number.isSafeInteger(raw.createdAt) || !Number.isSafeInteger(raw.updatedAt) ||
    !Number.isSafeInteger(raw.attempts) || raw.attempts! < 0 ||
    (raw.admittedAt !== null && raw.admittedAt !== undefined && !Number.isSafeInteger(raw.admittedAt))
  ) return null;
  if (raw.missedRun.mode !== 'fire-once' && (raw.missedRun.mode !== 'skip' || !Number.isSafeInteger(raw.missedRun.graceMs))) return null;
  return {
    id: raw.id,
    jobId: raw.jobId,
    scheduledAt: raw.scheduledAt!,
    outboxId: raw.outboxId,
    sessionId: raw.sessionId,
    text: raw.text,
    interrupt: raw.interrupt,
    missedRun: { ...raw.missedRun },
    state: raw.state as JobReceiptState,
    createdAt: raw.createdAt!,
    updatedAt: raw.updatedAt!,
    attempts: raw.attempts!,
    admittedAt: raw.admittedAt ?? null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 500) : null
  };
}

export class JobStore {
  private readonly file: string;
  private loaded = false;
  private jobs = new Map<string, ScheduledJob>();
  private receipts = new Map<string, JobReceipt>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly stateDir: string) {
    this.file = path.join(stateDir, STATE_FILE);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async load(): Promise<void> {
    return this.serial(async () => {
      if (this.loaded) return;
      let raw: string;
      try { raw = await fs.readFile(this.file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loaded = true; return; }
        throw error;
      }
      let parsed: Partial<JobsSnapshot>;
      try { parsed = JSON.parse(raw) as Partial<JobsSnapshot>; }
      catch { throw new Error('jobs state is not valid JSON'); }
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs) || !Array.isArray(parsed.receipts)) throw new Error('jobs state has an unsupported shape');
      const jobs = parsed.jobs.map(restoredJob);
      const receipts = parsed.receipts.map(restoredReceipt);
      if (jobs.some((job) => job === null) || receipts.some((receipt) => receipt === null)) throw new Error('jobs state contains an invalid record');
      this.jobs = new Map(jobs.map((job) => [job!.id, job!]));
      this.receipts = new Map(receipts.map((receipt) => [receipt!.id, receipt!]));
      this.loaded = true;
    });
  }

  private snapshot(now = Date.now()): JobsSnapshot {
    const orderedReceipts = [...this.receipts.values()].sort((a, b) => a.createdAt - b.createdAt);
    const pendingReceipts = orderedReceipts.filter((receipt) => !terminalReceipt(receipt.state));
    const terminalReceipts = orderedReceipts.filter((receipt) => terminalReceipt(receipt.state));
    const retainedReceipts = [...pendingReceipts, ...terminalReceipts.slice(-Math.max(0, MAX_RECEIPTS - pendingReceipts.length))]
      .sort((a, b) => a.createdAt - b.createdAt);
    return {
      version: 1,
      savedAt: now,
      jobs: [...this.jobs.values()].map(copyJob),
      // Pending admission/delivery state is never evicted merely because terminal history grew.
      receipts: retainedReceipts.map(copyReceipt)
    };
  }

  private async persist(): Promise<void> {
    const snapshot = this.snapshot();
    await fs.mkdir(this.stateDir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, this.file);
    this.receipts = new Map(snapshot.receipts.map((receipt) => [receipt.id, copyReceipt(receipt)]));
  }

  async create(input: CreateScheduledJob, now = Date.now()): Promise<ScheduledJob> {
    return this.serial(async () => {
      if (!this.loaded) throw new Error('job store is not loaded');
      const valid = validateCreateJob(input);
      const existing = this.jobs.get(valid.id);
      if (existing) {
        const existingIdentity = { id: existing.id, sessionId: existing.sessionId, text: existing.text, interrupt: existing.interrupt, schedule: existing.schedule, missedRun: existing.missedRun };
        const requestedIdentity = { id: valid.id, sessionId: valid.sessionId, text: valid.text, interrupt: valid.interrupt === true, schedule: valid.schedule, missedRun: valid.missedRun };
        const same = JSON.stringify(existingIdentity) === JSON.stringify(requestedIdentity);
        if (!same) throw new Error('job id already belongs to a different schedule');
        return copyJob(existing);
      }
      const nextAt = valid.schedule.kind === 'once' ? valid.schedule.at : valid.schedule.anchorAt;
      const job: ScheduledJob = { ...valid, interrupt: valid.interrupt === true, enabled: true, createdAt: now, updatedAt: now, nextAt };
      this.jobs.set(job.id, job);
      try { await this.persist(); }
      catch (error) { this.jobs.delete(job.id); throw error; }
      return copyJob(job);
    });
  }

  async cancel(id: string, now = Date.now()): Promise<boolean> {
    return this.serial(async () => {
      const job = this.jobs.get(id);
      const reserved = [...this.receipts.values()].filter((receipt) => receipt.jobId === id && receipt.state === 'reserved');
      if (!job || (!job.enabled && reserved.length === 0)) return false;
      const before = copyJob(job);
      const beforeReceipts = new Map([...this.receipts].map(([key, receipt]) => [key, copyReceipt(receipt)]));
      job.enabled = false;
      job.nextAt = null;
      job.updatedAt = now;
      for (const receipt of reserved) {
          receipt.state = 'skipped';
          receipt.updatedAt = now;
          receipt.lastError = 'job cancelled before admission';
      }
      try { await this.persist(); }
      catch (error) { this.jobs.set(id, before); this.receipts = beforeReceipts; throw error; }
      return true;
    });
  }

  async list(): Promise<{ jobs: ScheduledJob[]; receipts: JobReceipt[] }> {
    return this.serial(async () => ({
      jobs: [...this.jobs.values()].sort((a, b) => (a.nextAt ?? Number.MAX_SAFE_INTEGER) - (b.nextAt ?? Number.MAX_SAFE_INTEGER)).map(copyJob),
      receipts: [...this.receipts.values()].sort((a, b) => a.createdAt - b.createdAt).map(copyReceipt)
    }));
  }

  async actionable(): Promise<JobReceipt[]> {
    return this.serial(async () => [...this.receipts.values()].filter((receipt) => receipt.state === 'reserved' || receipt.state === 'admitted').sort((a, b) => a.scheduledAt - b.scheduledAt).map(copyReceipt));
  }

  async reserveDue(now = Date.now()): Promise<JobReceipt[]> {
    return this.serial(async () => {
      const beforeJobs = new Map([...this.jobs].map(([key, job]) => [key, copyJob(job)]));
      const beforeReceipts = new Map([...this.receipts].map(([key, receipt]) => [key, copyReceipt(receipt)]));
      const made: JobReceipt[] = [];
      for (const job of [...this.jobs.values()].sort((a, b) => (a.nextAt ?? Number.MAX_SAFE_INTEGER) - (b.nextAt ?? Number.MAX_SAFE_INTEGER))) {
        if ([...this.receipts.values()].some((receipt) => receipt.jobId === job.id && !terminalReceipt(receipt.state))) continue;
        const scheduledAt = latestDue(job, now);
        if (scheduledAt === null) continue;
        const next = nextAfter(job.schedule, scheduledAt);
        const missed = job.missedRun.mode === 'skip' && now - scheduledAt > job.missedRun.graceMs;
        const receipt: JobReceipt = {
          id: randomUUID(), jobId: job.id, scheduledAt, outboxId: randomUUID(), sessionId: job.sessionId,
          text: job.text, interrupt: job.interrupt, missedRun: { ...job.missedRun }, state: missed ? 'skipped' : 'reserved',
          createdAt: now, updatedAt: now, attempts: 0, admittedAt: null,
          lastError: missed ? 'missed scheduled window' : null
        };
        this.receipts.set(receipt.id, receipt);
        job.nextAt = next;
        job.enabled = next !== null;
        job.updatedAt = now;
        made.push(copyReceipt(receipt));
      }
      if (made.length) {
        try { await this.persist(); }
        catch (error) { this.jobs = beforeJobs; this.receipts = beforeReceipts; throw error; }
      }
      return made;
    });
  }

  async updateReceipt(id: string, patch: Partial<Pick<JobReceipt, 'state' | 'attempts' | 'admittedAt' | 'lastError'>>, now = Date.now()): Promise<JobReceipt | null> {
    return this.serial(async () => {
      const receipt = this.receipts.get(id);
      if (!receipt) return null;
      const before = copyReceipt(receipt);
      if (patch.state) receipt.state = patch.state;
      if (patch.attempts !== undefined) receipt.attempts = patch.attempts;
      if (patch.admittedAt !== undefined) receipt.admittedAt = patch.admittedAt;
      if (patch.lastError !== undefined) receipt.lastError = patch.lastError?.slice(0, 500) ?? null;
      receipt.updatedAt = now;
      try { await this.persist(); }
      catch (error) { this.receipts.set(id, before); throw error; }
      return copyReceipt(receipt);
    });
  }
}

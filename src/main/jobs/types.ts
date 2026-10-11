export type MissedRunPolicy =
  | { mode: 'fire-once' }
  | { mode: 'skip'; graceMs: number };

export type JobSchedule =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; anchorAt: number; everyMs: number };

export interface CreateScheduledJob {
  id: string;
  sessionId: string;
  text: string;
  interrupt?: boolean;
  schedule: JobSchedule;
  missedRun: MissedRunPolicy;
}

export interface ScheduledJob extends CreateScheduledJob {
  interrupt: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextAt: number | null;
}

export type JobReceiptState =
  | 'reserved'
  | 'admitted'
  | 'sent'
  | 'not-sent'
  | 'unconfirmed'
  | 'blocked'
  | 'skipped';

export interface JobReceipt {
  id: string;
  jobId: string;
  scheduledAt: number;
  outboxId: string;
  sessionId: string;
  text: string;
  interrupt: boolean;
  missedRun: MissedRunPolicy;
  state: JobReceiptState;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  admittedAt: number | null;
  lastError: string | null;
}

export interface JobsSnapshot {
  version: 1;
  savedAt: number;
  jobs: ScheduledJob[];
  receipts: JobReceipt[];
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SESSION_RE = /^[0-9a-z-]{8,64}$/;
export const MIN_INTERVAL_MS = 60_000;
export const MAX_JOB_TEXT = 64_000;

const finiteTime = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

export function validateCreateJob(input: CreateScheduledJob): CreateScheduledJob {
  if (!UUID_RE.test(input.id) || input.id !== input.id.toLowerCase()) throw new Error('job id must be a lowercase UUID');
  if (!SESSION_RE.test(input.sessionId)) throw new Error('sessionId is not valid');
  if (!input.text.trim() || input.text.length > MAX_JOB_TEXT) throw new Error('text is empty or too long');
  if (input.schedule.kind === 'once') {
    if (!finiteTime(input.schedule.at)) throw new Error('one-shot time is not valid');
  } else {
    if (!finiteTime(input.schedule.anchorAt)) throw new Error('interval anchor is not valid');
    if (!Number.isSafeInteger(input.schedule.everyMs) || input.schedule.everyMs < MIN_INTERVAL_MS) {
      throw new Error(`interval must be at least ${MIN_INTERVAL_MS} ms`);
    }
  }
  if (input.missedRun.mode === 'skip' && (!Number.isSafeInteger(input.missedRun.graceMs) || input.missedRun.graceMs < 0)) {
    throw new Error('missed-run grace is not valid');
  }
  return { ...input, text: input.text.trim(), interrupt: input.interrupt === true };
}

export function terminalReceipt(state: JobReceiptState): boolean {
  return state === 'sent' || state === 'not-sent' || state === 'unconfirmed' || state === 'blocked' || state === 'skipped';
}

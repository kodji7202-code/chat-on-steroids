import type { CreateScheduledJob, JobReceipt, ScheduledJob } from '../main/jobs/types.js';

export const JOB_DAEMON_PROTOCOL = 1;

export interface JobDaemonEndpoint {
  protocol: number;
  port: number;
  pid: number;
  startedAt: string;
}

export interface JobDaemonHealth {
  ok: true;
  protocol: number;
  pid: number;
  startedAt: string;
  jobs: number;
  pending: number;
  lastTickAt: number | null;
  lastError: string | null;
}

export interface JobDaemonList {
  jobs: ScheduledJob[];
  receipts: JobReceipt[];
}

export interface JobDaemonCreateRequest extends CreateScheduledJob {}

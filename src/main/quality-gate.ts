import { createHash } from 'node:crypto';
import type { Root } from '../shared/types.js';
import { parseQualityCheck } from '../shared/quality-checks.js';
import { MAX_TIMEOUT_MS, runCommand } from './exec.js';
import { validateWorkerWorkspaceLease, workerCandidateIdentity, type WorkerWorktreeLease } from './worktrees/index.js';

const FINISH_WAIT_MS = 20_000;
const OUTPUT_TAIL_CHARS = 1_500;
const MAX_RUNS = 64;

interface GateRun {
  key: string;
  checks: string[];
  headOid: string;
  dirty: boolean;
  startedAt: number;
  current: number;
  done: Promise<void>;
  result: null | { passed: true } | { passed: false; reason: string; output: string };
  failureShown: boolean;
}

export type FinishGate = { kind: 'accept'; preface: string } | { kind: 'refuse'; text: string };

/** One run per worker: the latest command list and candidate it was asked to prove. */
const runs = new Map<string, GateRun>();

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS ? `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function execute(run: GateRun, lease: WorkerWorktreeLease, roots: readonly Root[], identity: string): Promise<void> {
  const fail = (reason: string, output = ''): void => { run.result = { passed: false, reason, output: tail(output) }; };
  for (const [index, check] of run.checks.entries()) {
    run.current = index;
    const argv = parseQualityCheck(check);
    if (!argv) return fail(`\`${check}\` is not a command`);
    let cwd: string;
    try { cwd = (await validateWorkerWorkspaceLease(lease, roots)).workspace.real; }
    catch (error) { return fail(`the worker checkout could not be verified (${message(error)})`); }
    try {
      const result = await runCommand(argv[0]!, argv.slice(1), cwd, MAX_TIMEOUT_MS, { CI: '1' });
      if (result.timedOut) return fail(`\`${check}\` timed out after ${Math.round(MAX_TIMEOUT_MS / 1000)} s`, `${result.stdout}\n${result.stderr}`);
      if (result.exitCode !== 0) return fail(`\`${check}\` exited with ${result.exitCode ?? 'no status'}`, `${result.stdout}\n${result.stderr}`);
    } catch (error) {
      return fail(`\`${check}\` could not start (${message(error)})`);
    }
  }
  const after = await workerCandidateIdentity(lease).catch(() => null);
  if (after?.identity !== identity) return fail('the checks changed the candidate: its files differ from when they started');
  run.result = { passed: true };
}

function candidateLabel(run: GateRun): string {
  return `commit ${run.headOid.slice(0, 12)}${run.dirty ? ' with uncommitted changes' : ''}`;
}

function checksLabel(checks: readonly string[]): string {
  return checks.map(check => `\`${check}\``).join(', ');
}

function start(workerKey: string, key: string, checks: string[], candidate: { identity: string; headOid: string; dirty: boolean } | { error: string },
  lease: WorkerWorktreeLease, roots: readonly Root[]): GateRun {
  const run: GateRun = {
    key, checks, headOid: 'error' in candidate ? '' : candidate.headOid, dirty: 'error' in candidate ? false : candidate.dirty,
    startedAt: Date.now(), current: 0, done: Promise.resolve(), result: null, failureShown: false
  };
  if ('error' in candidate) run.result = { passed: false, reason: `the candidate could not be identified (${candidate.error})`, output: '' };
  else run.done = execute(run, lease, roots, candidate.identity).catch(error => {
    run.result = { passed: false, reason: `the checks stopped unexpectedly (${message(error)})`, output: '' };
  });
  runs.delete(workerKey);
  runs.set(workerKey, run);
  for (const [oldest, entry] of runs) {
    if (runs.size <= MAX_RUNS) break;
    if (entry.result) runs.delete(oldest);
  }
  return run;
}

/**
 * Decides one `agents finish` of a worker whose project has checks. A refused finish publishes
 * nothing; an accepted one gets an app-written preface for the report the Prime reads.
 */
export async function gateWorkerFinish(input: {
  lease: WorkerWorktreeLease | null;
  checks: readonly string[];
  roots: readonly Root[];
  waitMs?: number;
}): Promise<FinishGate | null> {
  const checks = [...input.checks];
  if (!checks.length) return null;
  if (!input.lease) return { kind: 'accept', preface: '[Quality checks not run] This worker has no verified isolated checkout.' };
  const lease = input.lease;
  const workerKey = `${lease.runId.toLowerCase()}:${lease.agentId}`;
  const candidate = await workerCandidateIdentity(lease).catch(error => ({ error: message(error) }));
  // A fixed key for an unidentifiable candidate, so the error text cannot keep a worker refused.
  const key = digest([checks, 'error' in candidate ? 'unavailable' : candidate.identity]);
  let run = runs.get(workerKey);
  if (run && run.key !== key) {
    if (!run.result) {
      return { kind: 'refuse', text: 'Quality checks are still running on an earlier version of your checkout. Wait, then call agents action=finish again with the same result.' };
    }
    run = undefined;
  }
  run ??= start(workerKey, key, checks, candidate, lease, input.roots);
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([run.done, new Promise(resolve => { timer = setTimeout(resolve, input.waitMs ?? FINISH_WAIT_MS); })]);
  clearTimeout(timer);
  const result = run.result;
  if (!result) {
    const seconds = Math.round((Date.now() - run.startedAt) / 1000);
    return { kind: 'refuse', text: `Quality checks are running on your checkout (${run.current + 1}/${run.checks.length}: \`${run.checks[run.current]}\`, ${seconds} s so far). ` +
      'Do not change files; call agents action=finish again with the same result.' };
  }
  if (result.passed) return { kind: 'accept', preface: `[Quality checks passed] ${checksLabel(run.checks)} on ${candidateLabel(run)}.` };
  if (!run.failureShown) {
    run.failureShown = true;
    return { kind: 'refuse', text: `Quality checks failed: ${result.reason}.` +
      (result.output ? `\n\nOutput (last lines):\n${result.output}` : '') +
      '\n\nFix the problem and call agents action=finish again. If you cannot fix it, call finish again without changing files; ' +
      'your report will then tell the prime that the checks failed.' };
  }
  return { kind: 'accept', preface: `[Quality checks FAILED] ${result.reason}${run.headOid ? ` on ${candidateLabel(run)}` : ''}. The worker finished without fixing it.` };
}

/** Test seam only. */
export function resetQualityGateForTests(): void {
  runs.clear();
}

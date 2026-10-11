import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readDurable, writeDurableNow } from '../durable.js';
import { runCommand } from '../exec.js';
import { agentForCaller, currentRunForCaller } from '../agents.js';
import { currentCall } from '../mcp/call-context.js';
import {
  candidateAnchorKey,
  captureCandidateAnchor,
  verifyCandidateAnchor,
  type AgentIdentity,
  type CandidateAnchor
} from './candidate.js';

const MAX_TESTS = 64;
const MAX_REVIEWERS = 32;
const MAX_GATE_RECORDS = 512;
const MAX_TEST_TIMEOUT_MS = 10 * 60_000;
const QUALITY_STATE = 'quality-gates';

const TEST_RECEIPT_BRAND: unique symbol = Symbol('quality-test-receipt');
const VALIDATOR_RECEIPT_BRAND: unique symbol = Symbol('quality-validator-receipt');
const GATE_RECEIPT_BRAND: unique symbol = Symbol('quality-gate-receipt');
const issuedTestReceipts = new WeakSet<object>();
const issuedValidatorReceipts = new WeakSet<object>();
const issuedGateReceipts = new WeakSet<object>();

export interface NamedTestCommand {
  name: string;
  command: string;
  args?: string[];
  /** Repository-relative directory. Omit for the repository root. */
  cwd?: string;
  timeoutMs?: number;
}

export interface GatePolicy {
  id: string;
  tests: NamedTestCommand[];
  reviewers: {
    /** Every listed reviewer must approve this exact candidate. */
    required?: AgentIdentity[];
    /** Unique independent approvals required in total. Must be at least one. */
    minimumApprovals: number;
  };
}

interface ReceiptAnchor {
  owner: AgentIdentity;
  repositoryRoot: string;
  baseRevision: string;
  candidateRevision: string;
  candidateTreeOid: string;
  diffHash: string;
  candidateKey: string;
}

interface TestReceiptData extends ReceiptAnchor {
  version: 1;
  kind: 'test';
  name: string;
  commandHash: string;
  status: 'passed' | 'failed' | 'unknown';
  reason: string | null;
  startedAt: number;
  completedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  stdoutHash: string;
  stderrHash: string;
  receiptHash: string;
}

export type TestReceipt = TestReceiptData & { readonly [TEST_RECEIPT_BRAND]: true };

interface ValidatorReceiptData extends ReceiptAnchor {
  version: 1;
  kind: 'validator';
  reviewer: AgentIdentity;
  verdict: 'approved' | 'rejected' | 'unknown';
  note: string;
  issuedAt: number;
  receiptHash: string;
}

export type ValidatorReceipt = ValidatorReceiptData & { readonly [VALIDATOR_RECEIPT_BRAND]: true };

export interface GateEvidenceSummary {
  tests: Array<Pick<TestReceiptData,
    'name' | 'commandHash' | 'status' | 'reason' | 'startedAt' | 'completedAt' | 'exitCode' |
    'timedOut' | 'outputTruncated' | 'stdoutHash' | 'stderrHash' | 'receiptHash'>>;
  validators: Array<Pick<ValidatorReceiptData, 'reviewer' | 'verdict' | 'issuedAt' | 'receiptHash'>>;
}

interface GateReceiptData extends ReceiptAnchor {
  version: 1;
  kind: 'gate';
  policyId: string;
  decision: 'passed' | 'blocked';
  reasons: string[];
  evidence: GateEvidenceSummary;
  evaluatedAt: number;
  receiptHash: string;
}

/**
 * Live authorization object returned only by this module. The private symbol deliberately does
 * not survive JSON serialization: durable gate records are audit evidence, never reusable write
 * authority. Integration must call `verifyGateForCandidate` on a live receipt.
 */
export type GateReceipt = GateReceiptData & { readonly [GATE_RECEIPT_BRAND]: true };

export type StoredGateRecord = GateReceiptData;

interface GateState {
  version: 1;
  records: StoredGateRecord[];
}

let persistenceQueue: Promise<void> = Promise.resolve();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableIdentity(identity: AgentIdentity): AgentIdentity {
  const runId = identity.runId.trim();
  const agentId = identity.agentId.trim();
  if (!runId || runId.length > 128 || !agentId || agentId.length > 128) {
    throw new Error('Reviewer identity requires bounded runId and agentId values');
  }
  return { runId, agentId };
}

function identityKey(identity: AgentIdentity): string {
  return `${identity.runId}\0${identity.agentId}`;
}

function sameIdentity(left: AgentIdentity, right: AgentIdentity): boolean {
  return left.runId === right.runId && left.agentId === right.agentId;
}

function receiptAnchor(anchor: CandidateAnchor): ReceiptAnchor {
  return {
    owner: { ...anchor.owner },
    repositoryRoot: anchor.repositoryRoot,
    baseRevision: anchor.baseRevision,
    candidateRevision: anchor.candidateRevision,
    candidateTreeOid: anchor.candidateTreeOid,
    diffHash: anchor.diffHash,
    candidateKey: candidateAnchorKey(anchor)
  };
}

function receiptMatchesAnchor(receipt: ReceiptAnchor, anchor: CandidateAnchor): boolean {
  const expected = receiptAnchor(anchor);
  return receipt.candidateKey === expected.candidateKey &&
    receipt.repositoryRoot === expected.repositoryRoot &&
    receipt.baseRevision === expected.baseRevision &&
    receipt.candidateRevision === expected.candidateRevision &&
    receipt.candidateTreeOid === expected.candidateTreeOid &&
    receipt.diffHash === expected.diffHash &&
    sameIdentity(receipt.owner, expected.owner);
}

function validateName(value: string, label: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:/ -]*$/.test(name)) throw new Error(`${label} is invalid`);
  return name;
}

export function namedTestCommandHash(command: NamedTestCommand): string {
  const name = validateName(command.name, 'Test name');
  if (!command.command || command.command.length > 4096 || command.command.includes('\0')) throw new Error(`Test ${name} has an invalid command`);
  const args = command.args ?? [];
  if (args.length > 128 || args.some(arg => typeof arg !== 'string' || arg.length > 16_384 || arg.includes('\0'))) {
    throw new Error(`Test ${name} has invalid arguments`);
  }
  const timeoutMs = command.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TEST_TIMEOUT_MS) {
    throw new Error(`Test ${name} timeout must be between 1000 and ${MAX_TEST_TIMEOUT_MS} ms`);
  }
  const cwd = command.cwd ?? '';
  if (cwd.includes('\0') || cwd.length > 4096) throw new Error(`Test ${name} has an invalid cwd`);
  return sha256(JSON.stringify([name, command.command, args, cwd.replaceAll('\\', '/'), timeoutMs]));
}

function validatePolicy(policy: GatePolicy): GatePolicy {
  const id = validateName(policy.id, 'Gate policy id');
  if (policy.tests.length === 0 || policy.tests.length > MAX_TESTS) throw new Error(`Gate policy must require 1-${MAX_TESTS} tests`);
  const seenTests = new Set<string>();
  for (const test of policy.tests) {
    const name = validateName(test.name, 'Test name');
    if (seenTests.has(name)) throw new Error(`Gate policy repeats test ${name}`);
    seenTests.add(name);
    namedTestCommandHash(test);
  }
  const required = (policy.reviewers.required ?? []).map(stableIdentity);
  if (required.length > MAX_REVIEWERS) throw new Error(`Gate policy supports at most ${MAX_REVIEWERS} required reviewers`);
  if (new Set(required.map(identityKey)).size !== required.length) throw new Error('Gate policy repeats a required reviewer');
  if (!Number.isSafeInteger(policy.reviewers.minimumApprovals) || policy.reviewers.minimumApprovals < 1 || policy.reviewers.minimumApprovals > MAX_REVIEWERS) {
    throw new Error(`Gate policy minimumApprovals must be between 1 and ${MAX_REVIEWERS}`);
  }
  if (policy.reviewers.minimumApprovals < required.length) {
    throw new Error('Gate policy minimumApprovals cannot be smaller than its required reviewer set');
  }
  return { ...policy, id, reviewers: { required, minimumApprovals: policy.reviewers.minimumApprovals } };
}

async function testCwd(anchor: CandidateAnchor, relative: string | undefined): Promise<string> {
  if (!relative || relative === '.') return anchor.repositoryRoot;
  const normalized = relative.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Test cwd must stay inside the candidate repository');
  }
  const target = await fs.realpath(path.resolve(anchor.repositoryRoot, ...normalized.split('/')));
  const rel = path.relative(anchor.repositoryRoot, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Test cwd escapes the candidate repository');
  if (!(await fs.stat(target)).isDirectory()) throw new Error('Test cwd is not a directory');
  return target;
}

function testReceiptIntegrity(receipt: Omit<TestReceiptData, 'receiptHash'>): string {
  return sha256(JSON.stringify(receipt));
}

function validatorReceiptIntegrity(receipt: Omit<ValidatorReceiptData, 'receiptHash'>): string {
  return sha256(JSON.stringify(receipt));
}

function gateReceiptIntegrity(receipt: Omit<GateReceiptData, 'receiptHash'>): string {
  return sha256(JSON.stringify(receipt));
}

function brandTest(data: TestReceiptData): TestReceipt {
  const receipt = Object.assign(data, { [TEST_RECEIPT_BRAND]: true as const });
  issuedTestReceipts.add(receipt);
  return receipt;
}

function brandValidator(data: ValidatorReceiptData): ValidatorReceipt {
  const receipt = Object.assign(data, { [VALIDATOR_RECEIPT_BRAND]: true as const });
  issuedValidatorReceipts.add(receipt);
  return receipt;
}

function brandGate(data: GateReceiptData): GateReceipt {
  const receipt = Object.assign(data, { [GATE_RECEIPT_BRAND]: true as const });
  issuedGateReceipts.add(receipt);
  return receipt;
}

function validTestReceipt(receipt: unknown): receipt is TestReceipt {
  if (!receipt || typeof receipt !== 'object' || !issuedTestReceipts.has(receipt) || !(TEST_RECEIPT_BRAND in receipt)) return false;
  const value = receipt as TestReceipt;
  const { receiptHash, ...unsigned } = value;
  return value.version === 1 && value.kind === 'test' && receiptHash === testReceiptIntegrity(unsigned);
}

function validValidatorReceipt(receipt: unknown): receipt is ValidatorReceipt {
  if (!receipt || typeof receipt !== 'object' || !issuedValidatorReceipts.has(receipt) || !(VALIDATOR_RECEIPT_BRAND in receipt)) return false;
  const value = receipt as ValidatorReceipt;
  const { receiptHash, ...unsigned } = value;
  return value.version === 1 && value.kind === 'validator' && receiptHash === validatorReceiptIntegrity(unsigned);
}

function validGateReceipt(receipt: unknown): receipt is GateReceipt {
  if (!receipt || typeof receipt !== 'object' || !issuedGateReceipts.has(receipt) || !(GATE_RECEIPT_BRAND in receipt)) return false;
  const value = receipt as GateReceipt;
  const { receiptHash, ...unsigned } = value;
  return value.version === 1 && value.kind === 'gate' && receiptHash === gateReceiptIntegrity(unsigned);
}

function unknownTestReceipt(anchor: CandidateAnchor, command: NamedTestCommand, startedAt: number, reason: string): TestReceipt {
  const unsigned: Omit<TestReceiptData, 'receiptHash'> = {
    version: 1,
    kind: 'test',
    ...receiptAnchor(anchor),
    name: validateName(command.name, 'Test name'),
    commandHash: namedTestCommandHash(command),
    status: 'unknown',
    reason,
    startedAt,
    completedAt: Date.now(),
    exitCode: null,
    timedOut: false,
    outputTruncated: false,
    stdoutHash: sha256(''),
    stderrHash: sha256('')
  };
  return brandTest({ ...unsigned, receiptHash: testReceiptIntegrity(unsigned) });
}

/** Runs one configured test only while the exact candidate remains unchanged. */
export async function runNamedTest(anchor: CandidateAnchor, command: NamedTestCommand): Promise<TestReceipt> {
  const startedAt = Date.now();
  if (!(await verifyCandidateAnchor(anchor))) return unknownTestReceipt(anchor, command, startedAt, 'candidate-mismatch-before-test');
  let cwd: string;
  try { cwd = await testCwd(anchor, command.cwd); }
  catch { return unknownTestReceipt(anchor, command, startedAt, 'test-cwd-unavailable'); }
  let result: Awaited<ReturnType<typeof runCommand>>;
  try {
    result = await runCommand(command.command, command.args ?? [], cwd, command.timeoutMs ?? 120_000);
  } catch {
    return unknownTestReceipt(anchor, command, startedAt, 'test-command-could-not-run');
  }
  const candidateStillMatches = await verifyCandidateAnchor(anchor);
  const status: TestReceiptData['status'] = !candidateStillMatches
    ? 'unknown'
    : !result.timedOut && result.exitCode === 0
      ? 'passed'
      : 'failed';
  const reason = !candidateStillMatches
    ? 'candidate-changed-during-test'
    : result.timedOut
      ? 'test-timed-out'
      : result.exitCode === 0
        ? null
        : result.exitCode === null
          ? 'test-process-status-unknown'
          : `test-exited-${result.exitCode}`;
  const unsigned: Omit<TestReceiptData, 'receiptHash'> = {
    version: 1,
    kind: 'test',
    ...receiptAnchor(anchor),
    name: validateName(command.name, 'Test name'),
    commandHash: namedTestCommandHash(command),
    status,
    reason,
    startedAt,
    completedAt: Date.now(),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputTruncated: result.truncated,
    stdoutHash: sha256(result.stdout),
    stderrHash: sha256(result.stderr)
  };
  return brandTest({ ...unsigned, receiptHash: testReceiptIntegrity(unsigned) });
}

export async function runNamedTests(anchor: CandidateAnchor, commands: readonly NamedTestCommand[]): Promise<TestReceipt[]> {
  const receipts: TestReceipt[] = [];
  for (const command of commands) receipts.push(await runNamedTest(anchor, command));
  return receipts;
}

/** Records the independent reviewer's decision for this exact candidate. */
export function issueValidatorReceipt(input: {
  candidate: CandidateAnchor;
  /**
   * Deprecated input retained only so stale internal callers fail closed at runtime instead of
   * silently changing meaning. Reviewer identity is derived exclusively from the current proven
   * broker call and this field is never accepted as authority.
   */
  reviewer?: AgentIdentity;
  verdict: 'approved' | 'rejected' | 'unknown';
  note?: string;
  issuedAt?: number;
}): ValidatorReceipt {
  if (input.reviewer !== undefined) {
    throw new Error('Caller-supplied reviewer identity is not review authority');
  }
  const call = currentCall();
  if (!call?.caller.conversationId) throw new Error('Reviewer identity is not proven by an active broker call');
  const runId = currentRunForCaller(call.caller);
  const agentId = agentForCaller(call.caller);
  if (!runId || !agentId || !call.agent || call.agent !== agentId) {
    throw new Error('Reviewer identity is not an exact active broker member');
  }
  const reviewer = stableIdentity({ runId, agentId });
  if (sameIdentity(reviewer, input.candidate.owner)) throw new Error('Candidate owner cannot approve its own quality gate');
  const note = (input.note ?? '').slice(0, 2_000);
  const unsigned: Omit<ValidatorReceiptData, 'receiptHash'> = {
    version: 1,
    kind: 'validator',
    ...receiptAnchor(input.candidate),
    reviewer,
    verdict: input.verdict,
    note,
    issuedAt: input.issuedAt ?? Date.now()
  };
  return brandValidator({ ...unsigned, receiptHash: validatorReceiptIntegrity(unsigned) });
}

/** Pure fail-closed gate evaluation. It never launches tests or reviewers itself. */
export function evaluateGate(input: {
  policy: GatePolicy;
  candidate: CandidateAnchor;
  tests: readonly TestReceipt[];
  validators: readonly ValidatorReceipt[];
  evaluatedAt?: number;
}): GateReceipt {
  const policy = validatePolicy(input.policy);
  const reasons: string[] = [];
  const testEvidence: GateEvidenceSummary['tests'] = [];
  for (const requirement of policy.tests) {
    const commandHash = namedTestCommandHash(requirement);
    const matches = input.tests.filter(receipt => validTestReceipt(receipt) && receipt.name === requirement.name &&
      receipt.commandHash === commandHash && receiptMatchesAnchor(receipt, input.candidate));
    if (matches.length !== 1) {
      reasons.push(matches.length === 0 ? `test:${requirement.name}:missing-or-stale` : `test:${requirement.name}:ambiguous-evidence`);
      continue;
    }
    const receipt = matches[0]!;
    testEvidence.push({
      name: receipt.name,
      commandHash: receipt.commandHash,
      status: receipt.status,
      reason: receipt.reason,
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      exitCode: receipt.exitCode,
      timedOut: receipt.timedOut,
      outputTruncated: receipt.outputTruncated,
      stdoutHash: receipt.stdoutHash,
      stderrHash: receipt.stderrHash,
      receiptHash: receipt.receiptHash
    });
    if (receipt.status !== 'passed') reasons.push(`test:${requirement.name}:${receipt.status}`);
  }

  const matchingValidators = input.validators.filter(receipt => validValidatorReceipt(receipt) && receiptMatchesAnchor(receipt, input.candidate));
  const byReviewer = new Map<string, ValidatorReceipt[]>();
  for (const receipt of matchingValidators) {
    if (sameIdentity(receipt.reviewer, input.candidate.owner)) {
      reasons.push(`validator:${receipt.reviewer.agentId}:self-review`);
      continue;
    }
    const key = identityKey(receipt.reviewer);
    byReviewer.set(key, [...(byReviewer.get(key) ?? []), receipt]);
  }
  const approved = new Map<string, ValidatorReceipt>();
  for (const [key, receipts] of byReviewer) {
    if (receipts.length !== 1) {
      reasons.push(`validator:${receipts[0]!.reviewer.agentId}:ambiguous-evidence`);
      continue;
    }
    const receipt = receipts[0]!;
    if (receipt.verdict !== 'approved') reasons.push(`validator:${receipt.reviewer.agentId}:${receipt.verdict}`);
    else approved.set(key, receipt);
  }
  for (const reviewer of policy.reviewers.required ?? []) {
    if (!approved.has(identityKey(reviewer))) reasons.push(`validator:${reviewer.agentId}:required-approval-missing`);
  }
  if (approved.size < policy.reviewers.minimumApprovals) reasons.push('validator:minimum-approvals-not-met');
  const validatorEvidence = matchingValidators.map(receipt => ({
    reviewer: { ...receipt.reviewer }, verdict: receipt.verdict, issuedAt: receipt.issuedAt, receiptHash: receipt.receiptHash
  }));
  const unsigned: Omit<GateReceiptData, 'receiptHash'> = {
    version: 1,
    kind: 'gate',
    ...receiptAnchor(input.candidate),
    policyId: policy.id,
    decision: reasons.length === 0 ? 'passed' : 'blocked',
    reasons,
    evidence: { tests: testEvidence, validators: validatorEvidence },
    evaluatedAt: input.evaluatedAt ?? Date.now()
  };
  return brandGate({ ...unsigned, receiptHash: gateReceiptIntegrity(unsigned) });
}

/**
 * Integration authorization boundary. Re-captures Git evidence and accepts only a live branded
 * receipt produced by this module for that exact worker owner, base, commit/tree and owned diff.
 */
export async function verifyGateForCandidate(receipt: unknown, expected: {
  policyId: string;
  repository: string;
  baseRevision: string;
  ownedPaths: readonly string[];
  owner: AgentIdentity;
}): Promise<boolean> {
  if (!validGateReceipt(receipt) || receipt.decision !== 'passed' || receipt.policyId !== expected.policyId) return false;
  let current: CandidateAnchor;
  try {
    current = await captureCandidateAnchor({
      repository: expected.repository,
      baseRevision: expected.baseRevision,
      ownedPaths: expected.ownedPaths,
      owner: expected.owner
    });
  } catch {
    return false;
  }
  return receiptMatchesAnchor(receipt, current);
}

function isStoredGateRecord(value: unknown): value is StoredGateRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<StoredGateRecord>;
  if (row.version !== 1 || row.kind !== 'gate' || (row.decision !== 'passed' && row.decision !== 'blocked') ||
      typeof row.policyId !== 'string' || typeof row.receiptHash !== 'string' || typeof row.candidateKey !== 'string') return false;
  const { receiptHash, ...unsigned } = row as StoredGateRecord;
  return receiptHash === gateReceiptIntegrity(unsigned);
}

export async function readStoredGateRecords(): Promise<StoredGateRecord[]> {
  const state = await readDurable<unknown>(QUALITY_STATE);
  if (state === null) return [];
  if (!state || typeof state !== 'object' || (state as { version?: unknown }).version !== 1 || !Array.isArray((state as { records?: unknown }).records)) {
    throw new Error('Durable quality gate state is invalid');
  }
  const records = (state as GateState).records;
  if (records.length > MAX_GATE_RECORDS || !records.every(isStoredGateRecord)) throw new Error('Durable quality gate records are invalid');
  return records.map(record => structuredClone(record));
}

/** Persists an audit record. The returned/stored JSON is intentionally not integration authority. */
export async function persistGateReceipt(receipt: GateReceipt): Promise<StoredGateRecord> {
  if (!validGateReceipt(receipt)) throw new Error('Only a live quality gate receipt can be persisted');
  const { [GATE_RECEIPT_BRAND]: _brand, ...record } = receipt;
  const operation = persistenceQueue.then(async () => {
    const records = await readStoredGateRecords();
    const next = [...records.filter(existing => existing.receiptHash !== record.receiptHash), structuredClone(record)].slice(-MAX_GATE_RECORDS);
    await writeDurableNow(QUALITY_STATE, { version: 1, records: next } satisfies GateState);
  });
  persistenceQueue = operation.catch(() => undefined);
  await operation;
  return structuredClone(record);
}

/** Test seam: serializes only this module's in-process persistence queue, never durable.ts itself. */
export async function settleQualityPersistenceForTests(): Promise<void> {
  await persistenceQueue;
}

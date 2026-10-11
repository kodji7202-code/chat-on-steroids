import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  captureCandidateAnchor,
  evaluateGate,
  issueValidatorReceipt,
  persistGateReceipt,
  readStoredGateRecords,
  runNamedTest,
  verifyGateForCandidate,
  type AgentIdentity,
  type GatePolicy,
  type NamedTestCommand
} from '../src/main/quality/index.js';

const exec = promisify(execFile);
const owner: AgentIdentity = { runId: 'run-quality', agentId: 'worker-2' };
const reviewer: AgentIdentity = { runId: 'run-review', agentId: 'worker-3' };
const reviewProof = vi.hoisted(() => ({ conversationId: 'review-chat' as string | null, runId: 'run-review', agentId: 'worker-3' }));

vi.mock('../src/main/agents.js', () => ({
  currentRunForCaller: (caller: { conversationId?: string | null }) => caller.conversationId === reviewProof.conversationId ? reviewProof.runId : null,
  agentForCaller: (caller: { conversationId?: string | null }) => caller.conversationId === reviewProof.conversationId ? reviewProof.agentId : null
}));
vi.mock('../src/main/mcp/call-context.js', () => ({
  currentCall: () => reviewProof.conversationId ? {
    agent: reviewProof.agentId,
    caller: { conversationId: reviewProof.conversationId, runId: reviewProof.runId }
  } : null
}));
let temp: string;
let repository: string;
let baseRevision: string;

async function git(...args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd: repository, windowsHide: true });
  return result.stdout.trim();
}

beforeEach(async () => {
  reviewProof.conversationId = 'review-chat';
  reviewProof.runId = 'run-review';
  reviewProof.agentId = 'worker-3';
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-quality-'));
  repository = path.join(temp, 'repo');
  await fs.mkdir(repository);
  await git('init');
  await git('config', 'user.email', 'quality@example.com');
  await git('config', 'user.name', 'Quality Test');
  await fs.writeFile(path.join(repository, 'owned.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(repository, 'other.ts'), 'export const other = 1;\n');
  await git('add', '.');
  await git('commit', '-m', 'base');
  baseRevision = await git('rev-parse', 'HEAD');
  initDurableStore(temp);
});

afterEach(async () => {
  resetDurableForTests();
  await fs.rm(temp, { recursive: true, force: true });
});

function passingTest(): NamedTestCommand {
  return { name: 'unit', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5_000 };
}

function policy(test = passingTest()): GatePolicy {
  return { id: 'worker-candidate', tests: [test], reviewers: { required: [reviewer], minimumApprovals: 1 } };
}

describe('candidate quality evidence', () => {
  it('anchors commit/tree and exact owned worktree state, including untracked changes', async () => {
    await fs.writeFile(path.join(repository, 'owned.ts'), 'export const value = 2;\n');
    await fs.writeFile(path.join(repository, 'new.ts'), 'export const added = true;\n');
    const first = await captureCandidateAnchor({ repository, baseRevision, ownedPaths: ['owned.ts', 'new.ts'], owner });

    expect(first.baseRevision).toBe(baseRevision);
    expect(first.candidateRevision).toBe(baseRevision);
    expect(first.candidateTreeOid).toMatch(/^[0-9a-f]{40,64}$/);
    expect(first.paths.find(row => row.path === 'new.ts')).toMatchObject({
      base: { kind: 'absent' }, worktree: { kind: 'file' }
    });

    await fs.writeFile(path.join(repository, 'new.ts'), 'export const added = false;\n');
    const second = await captureCandidateAnchor({ repository, baseRevision, ownedPaths: ['owned.ts', 'new.ts'], owner });
    expect(second.diffHash).not.toBe(first.diffHash);
    expect(second.candidateRevision).toBe(first.candidateRevision);
  });

  it('records a passing local command only when the candidate is unchanged before and after it', async () => {
    await fs.writeFile(path.join(repository, 'owned.ts'), 'export const value = 2;\n');
    const candidate = await captureCandidateAnchor({ repository, baseRevision, ownedPaths: ['owned.ts'], owner });
    const receipt = await runNamedTest(candidate, passingTest());
    expect(receipt).toMatchObject({ status: 'passed', exitCode: 0, timedOut: false, reason: null });

    const mutate: NamedTestCommand = {
      name: 'mutating-test',
      command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(repository, 'owned.ts'))}, 'changed by test\\n')`],
      timeoutMs: 5_000
    };
    const drifted = await runNamedTest(candidate, mutate);
    expect(drifted).toMatchObject({ status: 'unknown', reason: 'candidate-changed-during-test' });
  });

  it('fails closed on missing, failed, stale or non-independent evidence and passes exact evidence', async () => {
    await fs.writeFile(path.join(repository, 'owned.ts'), 'export const value = 2;\n');
    const candidate = await captureCandidateAnchor({ repository, baseRevision, ownedPaths: ['owned.ts'], owner });
    const tests = [await runNamedTest(candidate, passingTest())];

    const missingReview = evaluateGate({ policy: policy(), candidate, tests, validators: [] });
    expect(missingReview.decision).toBe('blocked');
    expect(missingReview.reasons).toContain('validator:worker-3:required-approval-missing');

    expect(() => issueValidatorReceipt({ candidate, reviewer, verdict: 'approved' })).toThrow('Caller-supplied reviewer identity');
    reviewProof.conversationId = null;
    expect(() => issueValidatorReceipt({ candidate, verdict: 'approved' })).toThrow('not proven');
    reviewProof.conversationId = 'review-chat';
    reviewProof.runId = owner.runId;
    reviewProof.agentId = owner.agentId;
    expect(() => issueValidatorReceipt({ candidate, verdict: 'approved' })).toThrow('own quality gate');
    reviewProof.runId = reviewer.runId;
    reviewProof.agentId = reviewer.agentId;
    const rejected = issueValidatorReceipt({ candidate, verdict: 'rejected' });
    expect(evaluateGate({ policy: policy(), candidate, tests, validators: [rejected] }).decision).toBe('blocked');

    const approval = issueValidatorReceipt({ candidate, verdict: 'approved', note: 'Reviewed diff and tests.' });
    expect(approval.reviewer).toEqual(reviewer);
    const passed = evaluateGate({ policy: policy(), candidate, tests, validators: [approval] });
    expect(passed).toMatchObject({ decision: 'passed', reasons: [] });

    await fs.writeFile(path.join(repository, 'owned.ts'), 'export const value = 3;\n');
    const changed = await captureCandidateAnchor({ repository, baseRevision, ownedPaths: ['owned.ts'], owner });
    expect(evaluateGate({ policy: policy(), candidate: changed, tests, validators: [approval] }).decision).toBe('blocked');
    await expect(verifyGateForCandidate(passed, {
      policyId: 'worker-candidate', repository, baseRevision, ownedPaths: ['owned.ts'], owner
    })).resolves.toBe(false);
  });

  it('requires the exact configured command and refuses a failed test even with reviewer approval', async () => {
    await fs.writeFile(path.join(repository, 'owned.ts'), 'export const value = 2;\n');
    const candidate = await captureCandidateAnchor({ repository, baseRevision, ownedPaths: ['owned.ts'], owner });
    const failedCommand: NamedTestCommand = {
      name: 'unit', command: process.execPath, args: ['-e', 'process.exit(7)'], timeoutMs: 5_000
    };
    const failed = await runNamedTest(candidate, failedCommand);
    expect(failed).toMatchObject({ status: 'failed', exitCode: 7 });
    const approval = issueValidatorReceipt({ candidate, verdict: 'approved' });
    const gate = evaluateGate({ policy: policy(failedCommand), candidate, tests: [failed], validators: [approval] });
    expect(gate.decision).toBe('blocked');
    expect(gate.reasons).toContain('test:unit:failed');
  });

  it('persists audit records durably but never upgrades JSON records into integration authority', async () => {
    await fs.writeFile(path.join(repository, 'owned.ts'), 'export const value = 2;\n');
    const candidate = await captureCandidateAnchor({ repository, baseRevision, ownedPaths: ['owned.ts'], owner });
    const tests = [await runNamedTest(candidate, passingTest())];
    const approval = issueValidatorReceipt({ candidate, verdict: 'approved' });
    const gate = evaluateGate({ policy: policy(), candidate, tests, validators: [approval] });
    expect(gate.decision).toBe('passed');

    const stored = await persistGateReceipt(gate);
    expect(await readStoredGateRecords()).toEqual([stored]);
    const copiedLiveObject = { ...gate };
    await expect(verifyGateForCandidate(copiedLiveObject, {
      policyId: 'worker-candidate', repository, baseRevision, ownedPaths: ['owned.ts'], owner
    })).resolves.toBe(false);
    await expect(verifyGateForCandidate(stored, {
      policyId: 'worker-candidate', repository, baseRevision, ownedPaths: ['owned.ts'], owner
    })).resolves.toBe(false);
    await expect(verifyGateForCandidate(gate, {
      policyId: 'worker-candidate', repository, baseRevision, ownedPaths: ['owned.ts'], owner
    })).resolves.toBe(true);
  });
});

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Root } from '../src/shared/types.js';
import { gitExecutable } from '../src/main/project-git.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';

const reviewerProof = vi.hoisted(() => ({ conversationId: 'reviewer-chat', runId: '11111111-1111-4111-8111-111111111111', agentId: 'worker-2' }));
vi.mock('../src/main/agents.js', async (original) => ({
  ...(await original<typeof import('../src/main/agents.js')>()),
  currentRunForCaller: (caller: { conversationId?: string | null }) => caller.conversationId === reviewerProof.conversationId ? reviewerProof.runId : null,
  agentForCaller: (caller: { conversationId?: string | null }) => caller.conversationId === reviewerProof.conversationId ? reviewerProof.agentId : null
}));
import {
  captureCandidateAnchor,
  evaluateGate,
  issueValidatorReceipt,
  runNamedTest,
  type GateReceipt,
  type NamedTestCommand
} from '../src/main/quality/index.js';
import {
  allocWorkerWorkspace,
  finalizeWorkerWorkspace,
  integrateWorkerWorkspace,
  lookupWorkerWorkspace,
  prepareWorkerIntegration,
  resetWorkerWorktreeRegistryForTests,
  restoreManagedWorktrees,
  syncWorkerWithTarget,
  WorkerWorktreeError,
  type WorkerIntegrationAuthorization,
  type WorkerWorktreeLease
} from '../src/main/worktrees/index.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = 'worker-integration';

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

function git(cwd: string, args: string[]): string {
  return execFileSync(gitExecutable(), args, { cwd, env: gitEnv(), encoding: 'utf8', windowsHide: true }).replaceAll('\r', '').trim();
}

async function write(file: string, value: string): Promise<void> {
  await fs.writeFile(file, value, 'utf8');
}

async function commit(repo: string, message: string): Promise<string> {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

async function passingGate(lease: WorkerWorktreeLease, ownedPaths = ['file.txt']): Promise<WorkerIntegrationAuthorization> {
  const candidate = await captureCandidateAnchor({
    repository: lease.worktreePath,
    baseRevision: lease.baseOid,
    ownedPaths,
    owner: { runId: lease.runId, agentId: lease.agentId }
  });
  const command: NamedTestCommand = {
    name: 'smoke',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 10_000
  };
  const test = await runNamedTest(candidate, command);
  const reviewerCall: CallContext = {
    startedAt: Date.now(), transportKey: null, agent: reviewerProof.agentId,
    caller: { transportKey: null, requestId: 'review-request', conversationId: reviewerProof.conversationId, sessionId: 'review-session' },
    outcome: null, evidence: emptyEvidence()
  };
  const validator = runInCallContext(reviewerCall, () => issueValidatorReceipt({
    candidate,
    verdict: 'approved'
  }));
  const gate = evaluateGate({
    policy: { id: POLICY_ID, tests: [command], reviewers: { minimumApprovals: 1 } },
    candidate,
    tests: [test],
    validators: [validator]
  });
  expect(gate.decision).toBe('passed');
  return { gate, policyId: POLICY_ID, ownedPaths };
}

describe('automatic worker Git worktrees', () => {
  let temp = '';
  let approved = '';
  let repo = '';
  let roots: Root[] = [];

  beforeEach(async () => {
    resetWorkerWorktreeRegistryForTests();
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-worktrees-'));
    approved = path.join(temp, 'approved');
    repo = path.join(approved, 'repo');
    await fs.mkdir(repo, { recursive: true });
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'CoS Worktree Test']);
    git(repo, ['config', 'user.email', 'worktree-test@example.invalid']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    await write(path.join(repo, 'file.txt'), 'base\n');
    await commit(repo, 'base');
    roots = [{ name: 'approved', path: approved }];
  });

  afterEach(async () => {
    resetWorkerWorktreeRegistryForTests();
    await fs.rm(temp, { recursive: true, force: true });
  });

  const allocate = () => allocWorkerWorkspace({
    runId: RUN_ID,
    agentId: 'worker-1',
    primeWorkspace: { real: repo, virtual: '/approved/repo' },
    approvedRoots: roots
  });

  it('allocates outside the source repo and preserves pre-existing dirty source changes', async () => {
    await write(path.join(repo, 'file.txt'), 'source dirty\n');
    const lease = await allocate();

    expect(lease.sourceDirty).toBe(true);
    expect(path.relative(repo, lease.worktreePath).startsWith(`..${path.sep}`)).toBe(true);
    expect(lease.workspace.virtual).toContain('/approved/.chat-on-steroids-worktrees/');
    expect(await fs.readFile(path.join(lease.workspace.real, 'file.txt'), 'utf8')).toBe('base\n');
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('source dirty\n');
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })?.ownershipToken).toBe(lease.ownershipToken);

    const finalized = await finalizeWorkerWorkspace({
      lease,
      reason: 'cancelled',
      discardChanges: true,
      branch: { mode: 'discard' }
    });
    expect(finalized).toMatchObject({ removed: true, branchRemoved: true });
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('source dirty\n');
    expect(git(repo, ['status', '--porcelain'])).toContain('file.txt');
  });

  it('refuses storage when the repository itself is the only approved root', async () => {
    await expect(allocWorkerWorkspace({
      runId: RUN_ID,
      agentId: 'worker-1',
      primeWorkspace: { real: repo, virtual: '/repo' },
      approvedRoots: [{ name: 'repo', path: repo }]
    })).rejects.toMatchObject({ code: 'WORKTREE_STORAGE_UNAVAILABLE' });
    expect(git(repo, ['branch', '--list', 'cos/worktrees/*'])).toBe('');
  });

  it('restores only marker-proven managed worktrees after the in-memory registry is lost', async () => {
    const lease = await allocate();
    resetWorkerWorktreeRegistryForTests();
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();

    const restored = await restoreManagedWorktrees(roots);
    expect(restored.rejected).toEqual([]);
    expect(restored.restored).toHaveLength(1);
    expect(restored.restored[0]).toMatchObject({
      runId: lease.runId,
      agentId: lease.agentId,
      ownershipToken: lease.ownershipToken,
      worktreePath: lease.worktreePath
    });
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })?.ownershipToken).toBe(lease.ownershipToken);

    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('refuses a tampered restart marker instead of following an arbitrary path', async () => {
    const lease = await allocate();
    const markerPath = path.join(path.dirname(lease.worktreePath), 'owner.json');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as Record<string, unknown>;
    marker['worktreePath'] = path.join(temp, 'outside-approved-root');
    await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    resetWorkerWorktreeRegistryForTests();

    const restored = await restoreManagedWorktrees(roots);
    expect(restored.restored).toEqual([]);
    expect(restored.rejected).toHaveLength(1);
    expect(restored.rejected[0]?.error).toContain('WORKTREE_OWNER_INVALID');
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();
  });

  it('requires a live quality GateReceipt and fast-forwards only the exact clean target', async () => {
    const lease = await allocate();
    await write(path.join(lease.workspace.real, 'file.txt'), 'worker\n');
    const workerHead = await commit(lease.worktreePath, 'worker change');
    const authorization = await passingGate(lease);
    const plan = await prepareWorkerIntegration({
      lease,
      targetWorkspace: { real: repo, virtual: '/approved/repo' },
      approvedRoots: roots,
      authorization
    });
    expect(plan).toMatchObject({ status: 'ready', targetOid: lease.baseOid, workerHeadOid: workerHead });

    const fake = JSON.parse(JSON.stringify(authorization.gate)) as GateReceipt;
    await expect(prepareWorkerIntegration({
      lease,
      targetWorkspace: { real: repo, virtual: '/approved/repo' },
      approvedRoots: roots,
      authorization: { ...authorization, gate: fake }
    })).rejects.toMatchObject({ code: 'WORKTREE_GATE_REJECTED' });

    const integrated = await integrateWorkerWorkspace({
      lease,
      targetWorkspace: { real: repo, virtual: '/approved/repo' },
      approvedRoots: roots,
      authorization,
      expectedTargetOid: lease.baseOid
    });
    expect(integrated).toMatchObject({ status: 'integrated', targetOidBefore: lease.baseOid, targetOidAfter: workerHead });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(workerHead);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('worker\n');

    const finalized = await finalizeWorkerWorkspace({
      lease,
      reason: 'completed',
      branch: { mode: 'delete-if-integrated', integratedIntoOid: workerHead }
    });
    expect(finalized).toMatchObject({ removed: true, branchRemoved: true });
  });

  it('refuses to modify a dirty integration target', async () => {
    const lease = await allocate();
    await write(path.join(lease.workspace.real, 'file.txt'), 'worker\n');
    const workerHead = await commit(lease.worktreePath, 'worker change');
    const authorization = await passingGate(lease);
    await write(path.join(repo, 'local.txt'), 'keep me\n');

    const result = await integrateWorkerWorkspace({
      lease,
      targetWorkspace: { real: repo, virtual: '/approved/repo' },
      approvedRoots: roots,
      authorization,
      expectedTargetOid: lease.baseOid
    });
    expect(result).toMatchObject({ status: 'target-dirty', workerHeadOid: workerHead });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(lease.baseOid);
    expect(await fs.readFile(path.join(repo, 'local.txt'), 'utf8')).toBe('keep me\n');

    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('refuses to integrate a committed file outside the independently reviewed path set', async () => {
    const lease = await allocate();
    await write(path.join(lease.workspace.real, 'file.txt'), 'reviewed\n');
    await write(path.join(lease.workspace.real, 'unreviewed.ts'), 'export const hidden = true;\n');
    await commit(lease.worktreePath, 'worker changes inside and outside review');
    const authorization = await passingGate(lease, ['file.txt']);
    await expect(prepareWorkerIntegration({
      lease, targetWorkspace: { real: repo, virtual: '/approved/repo' },
      approvedRoots: roots, authorization
    })).rejects.toMatchObject({ code: 'WORKTREE_UNREVIEWED_CHANGES' });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(lease.baseOid);
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('base\n');
  });

  it('keeps merge conflicts isolated in the owned worker tree and cancellation cleans only that tree', async () => {
    const lease = await allocate();
    await write(path.join(lease.workspace.real, 'file.txt'), 'worker side\n');
    await commit(lease.worktreePath, 'worker side');
    const authorization = await passingGate(lease);

    await write(path.join(repo, 'file.txt'), 'prime side\n');
    const primeHead = await commit(repo, 'prime side');
    const plan = await prepareWorkerIntegration({
      lease,
      targetWorkspace: { real: repo, virtual: '/approved/repo' },
      approvedRoots: roots,
      authorization
    });
    expect(['conflict', 'needs-worker-sync']).toContain(plan.status);

    const sync = await syncWorkerWithTarget({
      lease,
      targetWorkspace: { real: repo, virtual: '/approved/repo' },
      approvedRoots: roots,
      authorization
    });
    expect(sync.status).toBe('conflict-started');
    if (sync.status === 'conflict-started') expect(sync.conflicts).toContain('file.txt');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(primeHead);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('prime side\n');

    const finalized = await finalizeWorkerWorkspace({
      lease,
      reason: 'cancelled',
      discardChanges: true,
      branch: { mode: 'discard' }
    });
    expect(finalized).toMatchObject({ removed: true, branchRemoved: true });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(primeHead);
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('prime side\n');
  });

  it('rejects a stale gate after the worker candidate changes', async () => {
    const lease = await allocate();
    await write(path.join(lease.workspace.real, 'file.txt'), 'first\n');
    await commit(lease.worktreePath, 'first');
    const authorization = await passingGate(lease);
    await write(path.join(lease.workspace.real, 'file.txt'), 'second\n');
    await commit(lease.worktreePath, 'second');

    await expect(prepareWorkerIntegration({
      lease,
      targetWorkspace: { real: repo, virtual: '/approved/repo' },
      approvedRoots: roots,
      authorization
    })).rejects.toBeInstanceOf(WorkerWorktreeError);

    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });
});

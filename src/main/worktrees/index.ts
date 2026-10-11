import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Root } from '../../shared/types.js';
import type { Workspace } from '../workspace.js';
import { rawPromises as fs } from '../rawfs.js';
import { isContained } from '../sandbox.js';
import { gitExecutable } from '../project-git.js';
import { verifyGateForCandidate, type GateReceipt } from '../quality/index.js';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_ID = /^worker-[1-9][0-9]{0,5}$/;
const OID = /^[0-9a-f]{40,64}$/;
const MAX_GIT_BYTES = 4 * 1024 * 1024;
const MAX_PATCH_BYTES = 1536 * 1024;
const MAX_STATUS = 2_000;
const GIT_TIMEOUT_MS = 20_000;
const MANAGED_FOLDER = '.chat-on-steroids-worktrees';

export type WorkerWorkspace = Pick<Workspace, 'real' | 'virtual'>;

export interface WorkerWorktreeLease {
  version: 1;
  runId: string;
  agentId: string;
  ownershipToken: string;
  sourceRepoRoot: string;
  commonDir: string;
  worktreePath: string;
  workspace: WorkerWorkspace;
  branch: string;
  branchRef: string;
  baseOid: string;
  approvedRoot: Root;
  sourceDirty: boolean;
  createdAt: number;
}

export interface WorkerIntegrationAuthorization {
  /** Live branded receipt returned by quality.evaluateGate(); serialized records are rejected. */
  gate: GateReceipt;
  policyId: string;
  /** Exact repository-relative paths the quality candidate/gate reviewed. */
  ownedPaths: readonly string[];
}

export interface WorkerWorktreeStatus {
  headOid: string;
  dirty: boolean;
  changes: string[];
  truncated: boolean;
}

export interface WorkerWorktreeDiff {
  baseOid: string;
  headOid: string;
  status: WorkerWorktreeStatus;
  committedPatch: string | null;
  committedPatchTruncated: boolean;
  workingPatch: string | null;
  workingPatchTruncated: boolean;
}

export type WorkerIntegrationPlan =
  | { status: 'worker-dirty'; targetOid: string; workerHeadOid: string; changes: string[]; gateReceiptHash: string }
  | { status: 'ready'; targetOid: string; workerHeadOid: string; targetRef: string; gateReceiptHash: string }
  | { status: 'needs-worker-sync'; targetOid: string; workerHeadOid: string; targetRef: string; mergeTreeOid: string | null; gateReceiptHash: string }
  | { status: 'conflict'; targetOid: string; workerHeadOid: string; targetRef: string; conflicts: string[]; gateReceiptHash: string };

export type WorkerSyncResult =
  | { status: 'already-ready'; headOid: string; gateReceiptHash: string }
  | { status: 'worker-dirty'; changes: string[]; gateReceiptHash: string }
  | { status: 'synced'; previousHeadOid: string; headOid: string; needsRegate: true; gateReceiptHash: string }
  | { status: 'conflict-started'; previousHeadOid: string; targetOid: string; conflicts: string[]; needsRegate: true; gateReceiptHash: string };

export type WorkerIntegrationResult =
  | { status: 'target-dirty'; changes: string[]; targetOid: string; workerHeadOid: string; gateReceiptHash: string }
  | { status: 'not-ready'; plan: Exclude<WorkerIntegrationPlan, { status: 'ready' }> }
  | { status: 'already-integrated'; targetOid: string; workerHeadOid: string; gateReceiptHash: string }
  | { status: 'integrated'; targetOidBefore: string; targetOidAfter: string; workerHeadOid: string; gateReceiptHash: string };

export type WorkerFinalizeBranch =
  | { mode: 'keep' }
  | { mode: 'delete-if-integrated'; integratedIntoOid: string }
  | { mode: 'discard' };

export interface WorkerFinalizeResult {
  removed: boolean;
  branchRemoved: boolean;
  branch: string;
  changes: string[];
}

export class WorkerWorktreeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'WorkerWorktreeError';
  }
}

interface GitResult { code: number; stdout: Buffer; stderr: string; }
interface RepoContext { cwd: string; root: string; gitDir: string; commonDir: string; }
interface ResolvedRoot { root: Root; real: string; }
interface Marker extends Omit<WorkerWorktreeLease, 'sourceDirty' | 'approvedRoot'> {
  approvedRoot: Root;
  ownerDir: string;
  markerPath: string;
  hooksPath: string;
}

const live = new Map<string, WorkerWorktreeLease>();
const allocations = new Map<string, Promise<WorkerWorktreeLease>>();
const busy = new Set<string>();

function keyOf(runId: string, agentId: string): string {
  return `${runId.toLowerCase()}:${agentId}`;
}

function checkedIdentity(runId: string, agentId: string): { runId: string; agentId: string } {
  if (!RUN_ID.test(runId)) throw new WorkerWorktreeError('WORKTREE_IDENTITY_INVALID', 'runId must be the proven broker UUID');
  if (!AGENT_ID.test(agentId)) throw new WorkerWorktreeError('WORKTREE_IDENTITY_INVALID', 'agentId must be a proven worker-N identity');
  return { runId: runId.toLowerCase(), agentId };
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (/^GIT_/i.test(name)) delete environment[name];
  environment['GIT_TERMINAL_PROMPT'] = '0';
  environment['GCM_INTERACTIVE'] = 'never';
  return environment;
}

async function runGit(cwd: string, args: readonly string[], maxBytes = MAX_GIT_BYTES): Promise<GitResult> {
  const executable = gitExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd, env: cleanGitEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, settled = false;
    const finish = (error?: Error, code = -1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8').trim() });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new WorkerWorktreeError('WORKTREE_GIT_TIMEOUT', 'Git took too long to respond'));
    }, GIT_TIMEOUT_MS);
    child.once('error', error => finish(error));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill();
        finish(new WorkerWorktreeError('WORKTREE_GIT_OUTPUT', 'Git returned too much data'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.once('close', code => finish(undefined, code ?? -1));
  });
}

function safeGitArgs(hooksPath: string, args: readonly string[]): string[] {
  return [
    '-c', `core.hooksPath=${hooksPath}`,
    '-c', 'commit.gpgSign=false',
    '-c', 'merge.gpgSign=false',
    '-c', 'core.pager=cat',
    '-c', 'color.ui=false',
    '-c', 'diff.external=',
    ...args
  ];
}

function text(result: GitResult): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(result.stdout).replaceAll('\r', '');
}

async function realDirectory(value: string): Promise<string> {
  const real = await fs.realpath(path.resolve(value));
  if (!(await fs.stat(real)).isDirectory()) throw new WorkerWorktreeError('WORKTREE_PATH_INVALID', `${value} is not a directory`);
  return real;
}

async function rootsOf(approvedRoots: readonly Root[]): Promise<ResolvedRoot[]> {
  const result: ResolvedRoot[] = [];
  for (const root of approvedRoots) {
    if (!root.name || /[\\/]/.test(root.name)) throw new WorkerWorktreeError('WORKTREE_ROOT_INVALID', 'approved root has an invalid virtual name');
    try { result.push({ root: { ...root }, real: await realDirectory(root.path) }); }
    catch (error) {
      if (error instanceof WorkerWorktreeError) throw error;
      throw new WorkerWorktreeError('WORKTREE_ROOT_INVALID', `approved root ${root.name} is unavailable`);
    }
  }
  if (!result.length) throw new WorkerWorktreeError('WORKTREE_ROOT_REQUIRED', 'no approved root can own a worker worktree');
  return result;
}

function containedByAny(roots: readonly ResolvedRoot[], value: string): boolean {
  return roots.some(entry => isContained(entry.real, value));
}

async function repositoryContext(cwd: string, roots: readonly ResolvedRoot[]): Promise<RepoContext> {
  const realCwd = await realDirectory(cwd);
  if (!containedByAny(roots, realCwd)) throw new WorkerWorktreeError('WORKTREE_OUTSIDE_ROOT', 'workspace is outside the approved roots');
  const result = await runGit(realCwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  if (result.code !== 0) throw new WorkerWorktreeError('WORKTREE_NOT_REPOSITORY', result.stderr || 'workspace is not a Git repository');
  const lines = text(result).trimEnd().split('\n');
  if (lines.length < 3) throw new WorkerWorktreeError('WORKTREE_REPOSITORY_INVALID', 'Git returned an incomplete repository identity');
  const root = await fs.realpath(path.resolve(realCwd, lines[0]!));
  const gitDir = await fs.realpath(path.resolve(realCwd, lines[1]!));
  const commonDir = await fs.realpath(path.resolve(realCwd, lines[2]!));
  if (![root, gitDir, commonDir].every(candidate => containedByAny(roots, candidate))) {
    throw new WorkerWorktreeError('WORKTREE_METADATA_OUTSIDE_ROOT', 'Git repository metadata is outside the approved roots');
  }
  if (!isContained(root, realCwd)) throw new WorkerWorktreeError('WORKTREE_OUTSIDE_REPOSITORY', 'workspace is outside its Git worktree');
  return { cwd: realCwd, root, gitDir, commonDir };
}

function safeRef(value: string): string {
  if (value === 'HEAD') return value;
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/.test(value) || value.includes('..') || value.includes('@{') || value.endsWith('/') || value.endsWith('.')) {
    throw new WorkerWorktreeError('WORKTREE_BASE_REF_INVALID', 'baseRef must be HEAD or a full local branch ref');
  }
  return value;
}

async function statusOf(cwd: string): Promise<WorkerWorktreeStatus> {
  const [head, status] = await Promise.all([
    runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 256),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 1024 * 1024)
  ]);
  const headOid = text(head).trim();
  if (head.code !== 0 || !OID.test(headOid)) throw new WorkerWorktreeError('WORKTREE_HEAD_INVALID', head.stderr || 'Git HEAD is unavailable');
  if (status.code !== 0) throw new WorkerWorktreeError('WORKTREE_STATUS_FAILED', status.stderr || 'Git status failed');
  const parts = text(status).split('\0').filter(Boolean);
  const changes: string[] = [];
  for (let index = 0; index < parts.length && changes.length < MAX_STATUS; index++) {
    const record = parts[index]!;
    if (record.length < 4) continue;
    changes.push(record.slice(3));
    if ((record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') && index + 1 < parts.length) index++;
  }
  return { headOid, dirty: parts.length > 0, changes, truncated: parts.length > MAX_STATUS };
}

async function ensureDirectoryTree(root: string, segments: readonly string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const found = await fs.lstat(current);
      if (found.isSymbolicLink() || !found.isDirectory()) throw new WorkerWorktreeError('WORKTREE_STORAGE_UNSAFE', `${current} is not an owned directory`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      await fs.mkdir(current);
    }
    const resolved = await fs.realpath(current);
    if (!isContained(root, resolved)) throw new WorkerWorktreeError('WORKTREE_STORAGE_ESCAPE', 'managed worktree storage escaped its approved root');
    current = resolved;
  }
  return current;
}

function repoKey(commonDir: string): string {
  return createHash('sha256').update(commonDir).digest('hex').slice(0, 16);
}

function managedRootFor(repo: RepoContext, roots: readonly ResolvedRoot[]): ResolvedRoot {
  const candidates = roots.filter(entry =>
    isContained(entry.real, repo.root) && isContained(entry.real, repo.commonDir) &&
    !isContained(repo.root, path.join(entry.real, MANAGED_FOLDER))
  ).sort((left, right) => right.real.length - left.real.length);
  const chosen = candidates[0];
  if (!chosen) {
    throw new WorkerWorktreeError(
      'WORKTREE_STORAGE_UNAVAILABLE',
      'automatic worktrees need an approved parent of the repository so managed worktrees do not dirty the source repository'
    );
  }
  return chosen;
}

function virtualPath(root: Root, rootReal: string, real: string): string {
  const relative = path.relative(rootReal, real);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkerWorktreeError('WORKTREE_VIRTUAL_PATH_INVALID', 'managed workspace is not below its approved virtual root');
  }
  return path.posix.join('/', root.name, ...relative.split(path.sep));
}

function markerOf(lease: WorkerWorktreeLease, ownerDir: string, markerPath: string, hooksPath: string): Marker {
  return { ...lease, ownerDir, markerPath, hooksPath };
}

function isMarker(value: unknown): value is Marker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Partial<Marker>;
  return marker.version === 1 && typeof marker.runId === 'string' && RUN_ID.test(marker.runId) &&
    typeof marker.agentId === 'string' && AGENT_ID.test(marker.agentId) &&
    typeof marker.ownershipToken === 'string' && /^[0-9a-f-]{36}$/i.test(marker.ownershipToken) &&
    typeof marker.sourceRepoRoot === 'string' && typeof marker.commonDir === 'string' &&
    typeof marker.worktreePath === 'string' && typeof marker.workspace?.real === 'string' && typeof marker.workspace?.virtual === 'string' &&
    typeof marker.branch === 'string' && typeof marker.branchRef === 'string' && typeof marker.baseOid === 'string' && OID.test(marker.baseOid) &&
    typeof marker.approvedRoot?.name === 'string' && typeof marker.approvedRoot?.path === 'string' &&
    typeof marker.ownerDir === 'string' && typeof marker.markerPath === 'string' && typeof marker.hooksPath === 'string' &&
    typeof marker.createdAt === 'number';
}

async function readMarker(markerPath: string): Promise<Marker | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    if (!isMarker(parsed)) throw new WorkerWorktreeError('WORKTREE_OWNER_INVALID', 'managed worktree ownership marker is invalid');
    return parsed;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

function leaseFromMarker(marker: Marker, sourceDirty: boolean): WorkerWorktreeLease {
  const { ownerDir: _ownerDir, markerPath: _markerPath, hooksPath: _hooksPath, ...lease } = marker;
  return { ...lease, sourceDirty };
}

function markerMatchesLease(marker: Marker, lease: WorkerWorktreeLease): boolean {
  return marker.runId === lease.runId && marker.agentId === lease.agentId && marker.ownershipToken === lease.ownershipToken &&
    path.resolve(marker.sourceRepoRoot) === path.resolve(lease.sourceRepoRoot) && path.resolve(marker.commonDir) === path.resolve(lease.commonDir) &&
    path.resolve(marker.worktreePath) === path.resolve(lease.worktreePath) && marker.branchRef === lease.branchRef && marker.baseOid === lease.baseOid;
}

async function markerForLease(lease: WorkerWorktreeLease): Promise<Marker> {
  const ownerDir = path.dirname(lease.worktreePath);
  const markerPath = path.join(ownerDir, 'owner.json');
  const marker = await readMarker(markerPath);
  if (!marker || !markerMatchesLease(marker, lease)) throw new WorkerWorktreeError('WORKTREE_NOT_OWNED', 'worktree ownership could not be proven');
  return marker;
}

async function assertOwnedWorktree(lease: WorkerWorktreeLease): Promise<Marker> {
  const marker = await markerForLease(lease);
  const worktreeReal = await realDirectory(marker.worktreePath);
  if (path.resolve(worktreeReal) !== path.resolve(marker.worktreePath)) throw new WorkerWorktreeError('WORKTREE_PATH_CHANGED', 'owned worktree path changed');
  const branch = await runGit(worktreeReal, ['symbolic-ref', '--quiet', 'HEAD'], 512);
  if (branch.code !== 0 || text(branch).trim() !== marker.branchRef) throw new WorkerWorktreeError('WORKTREE_BRANCH_CHANGED', 'owned worktree no longer has its allocated branch');
  const common = await runGit(worktreeReal, ['rev-parse', '--git-common-dir'], 4096);
  if (common.code !== 0) throw new WorkerWorktreeError('WORKTREE_REPOSITORY_CHANGED', common.stderr || 'owned worktree repository identity is unavailable');
  const commonReal = await fs.realpath(path.resolve(worktreeReal, text(common).trim()));
  if (path.resolve(commonReal) !== path.resolve(marker.commonDir)) throw new WorkerWorktreeError('WORKTREE_REPOSITORY_CHANGED', 'owned worktree repository identity changed');
  return marker;
}

async function branchExists(cwd: string, branchRef: string): Promise<boolean> {
  const found = await runGit(cwd, ['show-ref', '--verify', '--quiet', branchRef], 128);
  if (found.code === 0) return true;
  if (found.code === 1) return false;
  throw new WorkerWorktreeError('WORKTREE_BRANCH_CHECK_FAILED', found.stderr || 'Git branch check failed');
}

async function allocate(input: {
  runId: string;
  agentId: string;
  primeWorkspace: WorkerWorkspace;
  approvedRoots: readonly Root[];
  baseRef?: string;
}): Promise<WorkerWorktreeLease> {
  const identity = checkedIdentity(input.runId, input.agentId);
  const roots = await rootsOf(input.approvedRoots);
  const source = await repositoryContext(input.primeWorkspace.real, roots);
  const sourceStatus = await statusOf(source.cwd);
  const approved = managedRootFor(source, roots);
  const baseRef = safeRef(input.baseRef ?? 'HEAD');
  const base = await runGit(source.cwd, ['rev-parse', '--verify', `${baseRef}^{commit}`], 256);
  const baseOid = text(base).trim();
  if (base.code !== 0 || !OID.test(baseOid)) throw new WorkerWorktreeError('WORKTREE_BASE_UNAVAILABLE', base.stderr || 'base revision is unavailable');
  const projectRelative = path.relative(source.root, source.cwd);
  if (projectRelative === '..' || projectRelative.startsWith(`..${path.sep}`) || path.isAbsolute(projectRelative)) {
    throw new WorkerWorktreeError('WORKTREE_PROJECT_ESCAPE', 'prime workspace is outside the repository root');
  }
  const compactRun = identity.runId.replaceAll('-', '');
  const branch = `cos/worktrees/${compactRun}/${identity.agentId}`;
  const branchRef = `refs/heads/${branch}`;
  const ownerDir = await ensureDirectoryTree(approved.real, [MANAGED_FOLDER, repoKey(source.commonDir), identity.runId, identity.agentId]);
  const hooksPath = await ensureDirectoryTree(ownerDir, ['hooks']);
  const worktreePath = path.join(ownerDir, 'tree');
  const markerPath = path.join(ownerDir, 'owner.json');
  const existing = await readMarker(markerPath);
  if (existing) {
    if (existing.runId !== identity.runId || existing.agentId !== identity.agentId || path.resolve(existing.commonDir) !== path.resolve(source.commonDir) || existing.branchRef !== branchRef) {
      throw new WorkerWorktreeError('WORKTREE_OWNER_CONFLICT', 'managed worktree slot belongs to a different repository identity');
    }
    const recovered = leaseFromMarker(existing, sourceStatus.dirty);
    await assertOwnedWorktree(recovered);
    live.set(keyOf(identity.runId, identity.agentId), recovered);
    return recovered;
  }
  try {
    await fs.lstat(worktreePath);
    throw new WorkerWorktreeError('WORKTREE_PATH_OCCUPIED', 'managed worktree destination already exists without an ownership marker');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  if (await branchExists(source.cwd, branchRef)) {
    throw new WorkerWorktreeError('WORKTREE_BRANCH_OCCUPIED', 'managed worker branch already exists without an ownership marker');
  }
  const add = await runGit(source.cwd, safeGitArgs(hooksPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseOid]));
  if (add.code !== 0) {
    const raced = await readMarker(markerPath);
    if (raced) {
      const recovered = leaseFromMarker(raced, sourceStatus.dirty);
      await assertOwnedWorktree(recovered);
      live.set(keyOf(identity.runId, identity.agentId), recovered);
      return recovered;
    }
    throw new WorkerWorktreeError('WORKTREE_ADD_FAILED', add.stderr || 'Git could not create the worker worktree');
  }
  const workspaceReal = projectRelative ? path.join(worktreePath, projectRelative) : worktreePath;
  const lease: WorkerWorktreeLease = {
    version: 1, ...identity, ownershipToken: randomUUID(), sourceRepoRoot: source.root, commonDir: source.commonDir,
    worktreePath, workspace: { real: workspaceReal, virtual: virtualPath(approved.root, approved.real, workspaceReal) },
    branch, branchRef, baseOid, approvedRoot: { ...approved.root }, sourceDirty: sourceStatus.dirty, createdAt: Date.now()
  };
  const marker = markerOf(lease, ownerDir, markerPath, hooksPath);
  try {
    await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await assertOwnedWorktree(lease);
  } catch (error) {
    await runGit(source.cwd, safeGitArgs(hooksPath, ['worktree', 'remove', '--force', worktreePath])).catch(() => undefined);
    await runGit(source.cwd, ['update-ref', '-d', branchRef, baseOid], 256).catch(() => undefined);
    throw error;
  }
  live.set(keyOf(identity.runId, identity.agentId), lease);
  return { ...lease };
}

/**
 * Allocates one deterministic, isolated Git worktree for a proven broker run/worker identity.
 * The source checkout is never reset, cleaned or otherwise changed; dirty source state is merely
 * reported on the lease. Storage must live under an approved parent outside the source repository.
 */
export function allocWorkerWorkspace(input: {
  runId: string;
  agentId: string;
  primeWorkspace: WorkerWorkspace;
  approvedRoots: readonly Root[];
  baseRef?: string;
}): Promise<WorkerWorktreeLease> {
  const identity = checkedIdentity(input.runId, input.agentId);
  const key = keyOf(identity.runId, identity.agentId);
  const existing = allocations.get(key);
  if (existing) return existing;
  const flight = allocate({ ...input, ...identity }).finally(() => allocations.delete(key));
  allocations.set(key, flight);
  return flight;
}

/** Process-local fast lookup. allocWorkerWorkspace() is also restart-safe and recovers its marker. */
export function lookupWorkerWorkspace(input: { runId: string; agentId: string }): WorkerWorktreeLease | null {
  const identity = checkedIdentity(input.runId, input.agentId);
  const lease = live.get(keyOf(identity.runId, identity.agentId));
  return lease ? { ...lease, workspace: { ...lease.workspace }, approvedRoot: { ...lease.approvedRoot } } : null;
}

export interface RestoreManagedWorktreesResult {
  restored: WorkerWorktreeLease[];
  rejected: Array<{ markerPath: string; error: string }>;
}

function expectedBranch(runId: string, agentId: string): { branch: string; branchRef: string } {
  const branch = `cos/worktrees/${runId.replaceAll('-', '')}/${agentId}`;
  return { branch, branchRef: `refs/heads/${branch}` };
}

async function candidateMarkerPaths(rootReal: string, rejected: RestoreManagedWorktreesResult['rejected']): Promise<string[]> {
  const managed = path.join(rootReal, MANAGED_FOLDER);
  let managedStat: Awaited<ReturnType<typeof fs.lstat>>;
  try { managedStat = await fs.lstat(managed); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  if (managedStat.isSymbolicLink() || !managedStat.isDirectory()) {
    rejected.push({ markerPath: managed, error: 'WORKTREE_STORAGE_UNSAFE: managed worktree root is not a real directory' });
    return [];
  }
  const managedReal = await fs.realpath(managed);
  if (!isContained(rootReal, managedReal)) {
    rejected.push({ markerPath: managed, error: 'WORKTREE_STORAGE_ESCAPE: managed worktree root escaped its approved root' });
    return [];
  }
  const markers: string[] = [];
  for (const repoEntry of await fs.readdir(managedReal, { withFileTypes: true })) {
    if (!repoEntry.isDirectory() || repoEntry.isSymbolicLink() || !/^[0-9a-f]{16}$/.test(repoEntry.name)) continue;
    const repoDir = path.join(managedReal, repoEntry.name);
    for (const runEntry of await fs.readdir(repoDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory() || runEntry.isSymbolicLink() || !RUN_ID.test(runEntry.name)) continue;
      const runDir = path.join(repoDir, runEntry.name);
      for (const agentEntry of await fs.readdir(runDir, { withFileTypes: true })) {
        if (!agentEntry.isDirectory() || agentEntry.isSymbolicLink() || !AGENT_ID.test(agentEntry.name)) continue;
        markers.push(path.join(runDir, agentEntry.name, 'owner.json'));
      }
    }
  }
  return markers;
}

/**
 * Startup recovery for broker-restored workers. Discovery is deliberately fixed-depth beneath
 * each approved `.chat-on-steroids-worktrees` directory; it never searches arbitrary user files.
 * A marker is adopted only after its deterministic path, branch, repository common-dir and live
 * Git worktree all prove the same run/worker owner. Ambiguous duplicate identities restore none.
 */
export async function restoreManagedWorktrees(approvedRoots: readonly Root[]): Promise<RestoreManagedWorktreesResult> {
  const roots = await rootsOf(approvedRoots);
  const result: RestoreManagedWorktreesResult = { restored: [], rejected: [] };
  const candidates = new Map<string, Array<{ lease: WorkerWorktreeLease; markerPath: string }>>();
  for (const approved of roots) {
    const markerPaths = await candidateMarkerPaths(approved.real, result.rejected);
    for (const markerPath of markerPaths) {
      try {
        const marker = await readMarker(markerPath);
        if (!marker) continue;
        const ownerDir = path.dirname(markerPath);
        const identity = checkedIdentity(marker.runId, marker.agentId);
        const branch = expectedBranch(identity.runId, identity.agentId);
        if (path.resolve(marker.ownerDir) !== path.resolve(ownerDir) ||
            path.resolve(marker.markerPath) !== path.resolve(markerPath) ||
            path.resolve(marker.hooksPath) !== path.resolve(path.join(ownerDir, 'hooks')) ||
            path.resolve(marker.worktreePath) !== path.resolve(path.join(ownerDir, 'tree')) ||
            marker.branch !== branch.branch || marker.branchRef !== branch.branchRef ||
            path.basename(path.dirname(path.dirname(ownerDir))) !== repoKey(marker.commonDir)) {
          throw new WorkerWorktreeError('WORKTREE_OWNER_INVALID', 'ownership marker does not match its deterministic managed slot');
        }
        if (![marker.sourceRepoRoot, marker.commonDir, marker.worktreePath, marker.workspace.real].every(value => containedByAny(roots, path.resolve(value)))) {
          throw new WorkerWorktreeError('WORKTREE_OUTSIDE_ROOT', 'restored worktree or repository metadata is outside current approved roots');
        }
        const workspaceReal = await realDirectory(marker.workspace.real);
        const worktreeReal = await realDirectory(marker.worktreePath);
        if (!isContained(worktreeReal, workspaceReal)) throw new WorkerWorktreeError('WORKTREE_PROJECT_ESCAPE', 'restored worker workspace escaped its owned worktree');
        let sourceDirty = false;
        try { sourceDirty = (await statusOf(marker.sourceRepoRoot)).dirty; } catch { /* diagnostic only */ }
        const lease = leaseFromMarker(marker, sourceDirty);
        lease.approvedRoot = { ...approved.root };
        lease.workspace = { real: workspaceReal, virtual: virtualPath(approved.root, approved.real, workspaceReal) };
        await assertOwnedWorktree(lease);
        const key = keyOf(identity.runId, identity.agentId);
        candidates.set(key, [...(candidates.get(key) ?? []), { lease, markerPath }]);
      } catch (error) {
        result.rejected.push({ markerPath, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  for (const [key, rows] of candidates) {
    if (rows.length !== 1) {
      live.delete(key);
      for (const row of rows) result.rejected.push({ markerPath: row.markerPath, error: 'WORKTREE_OWNER_AMBIGUOUS: more than one managed worktree claims this worker identity' });
      continue;
    }
    const row = rows[0]!;
    const existing = live.get(key);
    if (existing && existing.ownershipToken !== row.lease.ownershipToken) {
      result.rejected.push({ markerPath: row.markerPath, error: 'WORKTREE_OWNER_CONFLICT: live registry already contains another lease for this worker identity' });
      continue;
    }
    live.set(key, row.lease);
    result.restored.push({ ...row.lease, workspace: { ...row.lease.workspace }, approvedRoot: { ...row.lease.approvedRoot } });
  }
  return result;
}

export async function inspectWorkerWorkspace(lease: WorkerWorktreeLease): Promise<WorkerWorktreeStatus> {
  await assertOwnedWorktree(lease);
  return statusOf(lease.worktreePath);
}

async function patchOrTruncated(cwd: string, args: readonly string[]): Promise<{ patch: string | null; truncated: boolean }> {
  try {
    const result = await runGit(cwd, args, MAX_PATCH_BYTES);
    if (result.code !== 0) throw new WorkerWorktreeError('WORKTREE_DIFF_FAILED', result.stderr || 'Git diff failed');
    return { patch: text(result), truncated: false };
  } catch (error) {
    if (error instanceof WorkerWorktreeError && error.code === 'WORKTREE_GIT_OUTPUT') return { patch: null, truncated: true };
    throw error;
  }
}

export async function diffWorkerWorkspace(lease: WorkerWorktreeLease): Promise<WorkerWorktreeDiff> {
  await assertOwnedWorktree(lease);
  const status = await statusOf(lease.worktreePath);
  const committed = await patchOrTruncated(lease.worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '--unified=3', lease.baseOid, status.headOid, '--', '.']);
  const working = await patchOrTruncated(lease.worktreePath, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '--unified=3', '--', '.']);
  return {
    baseOid: lease.baseOid, headOid: status.headOid, status,
    committedPatch: committed.patch, committedPatchTruncated: committed.truncated,
    workingPatch: working.patch, workingPatchTruncated: working.truncated
  };
}

async function targetContext(targetWorkspace: WorkerWorkspace, approvedRoots: readonly Root[], lease: WorkerWorktreeLease): Promise<RepoContext> {
  const roots = await rootsOf(approvedRoots);
  const target = await repositoryContext(targetWorkspace.real, roots);
  if (path.resolve(target.commonDir) !== path.resolve(lease.commonDir)) {
    throw new WorkerWorktreeError('WORKTREE_REPOSITORY_MISMATCH', 'worker and integration target are not linked to the same Git repository');
  }
  return target;
}

async function symbolicHead(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['symbolic-ref', '--quiet', 'HEAD'], 512);
  const ref = text(result).trim();
  if (result.code !== 0 || !ref.startsWith('refs/heads/')) throw new WorkerWorktreeError('WORKTREE_TARGET_DETACHED', 'integration target must have a checked-out local branch');
  return ref;
}

async function assertQualityGate(lease: WorkerWorktreeLease, authorization: WorkerIntegrationAuthorization): Promise<WorkerWorktreeStatus> {
  const valid = await verifyGateForCandidate(authorization.gate, {
    policyId: authorization.policyId,
    repository: lease.worktreePath,
    baseRevision: lease.baseOid,
    ownedPaths: authorization.ownedPaths,
    owner: { runId: lease.runId, agentId: lease.agentId }
  });
  if (!valid) throw new WorkerWorktreeError('WORKTREE_GATE_REJECTED', 'quality gate is missing, blocked, stale, serialized, or belongs to another candidate');
  const status = await statusOf(lease.worktreePath);
  if (status.headOid !== authorization.gate.candidateRevision) throw new WorkerWorktreeError('WORKTREE_GATE_STALE', 'worker HEAD changed after the quality gate reviewed it');
  // Fast-forward imports every committed path in worker HEAD, not just the paths named
  // in a caller's review request. Therefore all changed paths (including both sides of
  // renames) must be covered by the exact approved candidate's ownedPaths.
  const changed = await runGit(lease.worktreePath, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z',
    lease.baseOid, status.headOid, '--'
  ], 1024 * 1024);
  if (changed.code !== 0) throw new WorkerWorktreeError('WORKTREE_SCOPE_UNKNOWN', changed.stderr || 'Git could not prove the complete candidate path set');
  const reviewed = new Set(authorization.ownedPaths);
  const unreviewed = text(changed).split('\0').filter(Boolean).filter(name => !reviewed.has(name));
  if (unreviewed.length) throw new WorkerWorktreeError(
    'WORKTREE_UNREVIEWED_CHANGES',
    `Integration refused ${unreviewed.length} committed path(s) outside the approved review scope: ${unreviewed.slice(0, 4).join(', ')}`
  );
  return status;
}

function mergeConflicts(result: GitResult): string[] {
  const lines = text(result).split('\n').map(line => line.trim()).filter(Boolean);
  const conflicts: string[] = [];
  for (const line of lines.slice(1)) {
    if (OID.test(line) || /^Auto-merging\s/.test(line) || /^CONFLICT\s/.test(line)) continue;
    if (line.length <= 4096 && !conflicts.includes(line)) conflicts.push(line);
    if (conflicts.length >= 256) break;
  }
  return conflicts;
}

export async function prepareWorkerIntegration(input: {
  lease: WorkerWorktreeLease;
  targetWorkspace: WorkerWorkspace;
  approvedRoots: readonly Root[];
  authorization: WorkerIntegrationAuthorization;
}): Promise<WorkerIntegrationPlan> {
  await assertOwnedWorktree(input.lease);
  const worker = await assertQualityGate(input.lease, input.authorization);
  const target = await targetContext(input.targetWorkspace, input.approvedRoots, input.lease);
  const targetState = await statusOf(target.cwd);
  const targetRef = await symbolicHead(target.cwd);
  const gateReceiptHash = input.authorization.gate.receiptHash;
  if (worker.dirty) return { status: 'worker-dirty', targetOid: targetState.headOid, workerHeadOid: worker.headOid, changes: worker.changes, gateReceiptHash };
  const ancestor = await runGit(target.cwd, ['merge-base', '--is-ancestor', targetState.headOid, worker.headOid], 128);
  if (ancestor.code === 0) return { status: 'ready', targetOid: targetState.headOid, workerHeadOid: worker.headOid, targetRef, gateReceiptHash };
  if (ancestor.code !== 1) throw new WorkerWorktreeError('WORKTREE_ANCESTRY_FAILED', ancestor.stderr || 'Git ancestry check failed');
  const merged = await runGit(target.cwd, ['merge-tree', '--write-tree', '--name-only', targetState.headOid, worker.headOid], 1024 * 1024);
  const first = text(merged).split('\n')[0]?.trim() ?? '';
  if (merged.code === 0) {
    return { status: 'needs-worker-sync', targetOid: targetState.headOid, workerHeadOid: worker.headOid, targetRef, mergeTreeOid: OID.test(first) ? first : null, gateReceiptHash };
  }
  if (merged.code === 1) {
    return { status: 'conflict', targetOid: targetState.headOid, workerHeadOid: worker.headOid, targetRef, conflicts: mergeConflicts(merged), gateReceiptHash };
  }
  // Older Git without merge-tree --write-tree can still resolve safely inside the owned worker.
  if (/unknown option|usage: git merge-tree|not a valid object/i.test(merged.stderr)) {
    return { status: 'needs-worker-sync', targetOid: targetState.headOid, workerHeadOid: worker.headOid, targetRef, mergeTreeOid: null, gateReceiptHash };
  }
  throw new WorkerWorktreeError('WORKTREE_MERGE_PREFLIGHT_FAILED', merged.stderr || 'Git merge preflight failed');
}

async function withLeaseMutation<T>(lease: WorkerWorktreeLease, operation: () => Promise<T>): Promise<T> {
  const key = keyOf(lease.runId, lease.agentId);
  if (busy.has(key)) throw new WorkerWorktreeError('WORKTREE_BUSY', 'another mutation already owns this worker worktree');
  busy.add(key);
  try { return await operation(); }
  finally { busy.delete(key); }
}

/**
 * Brings the target branch into the isolated worker branch. Conflicts, if any, remain only in
 * this owned worktree for the worker to resolve; the user's target checkout is never dirtied.
 * A successful merge changes worker HEAD and therefore intentionally requires a fresh gate.
 */
export function syncWorkerWithTarget(input: {
  lease: WorkerWorktreeLease;
  targetWorkspace: WorkerWorkspace;
  approvedRoots: readonly Root[];
  authorization: WorkerIntegrationAuthorization;
}): Promise<WorkerSyncResult> {
  return withLeaseMutation(input.lease, async () => {
    const marker = await assertOwnedWorktree(input.lease);
    const plan = await prepareWorkerIntegration(input);
    if (plan.status === 'worker-dirty') return { status: 'worker-dirty', changes: plan.changes, gateReceiptHash: input.authorization.gate.receiptHash };
    if (plan.status === 'ready') return { status: 'already-ready', headOid: plan.workerHeadOid, gateReceiptHash: input.authorization.gate.receiptHash };
    const merge = await runGit(input.lease.worktreePath, safeGitArgs(marker.hooksPath, ['merge', '--no-edit', plan.targetOid]));
    if (merge.code === 0) {
      const after = await statusOf(input.lease.worktreePath);
      if (after.dirty) throw new WorkerWorktreeError('WORKTREE_SYNC_DIRTY', 'Git reported a successful merge but left worker changes behind');
      return { status: 'synced', previousHeadOid: plan.workerHeadOid, headOid: after.headOid, needsRegate: true, gateReceiptHash: input.authorization.gate.receiptHash };
    }
    const conflicts = await runGit(input.lease.worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z'], 512 * 1024);
    const names = text(conflicts).split('\0').filter(Boolean).slice(0, 256);
    if (names.length) return { status: 'conflict-started', previousHeadOid: plan.workerHeadOid, targetOid: plan.targetOid, conflicts: names, needsRegate: true, gateReceiptHash: input.authorization.gate.receiptHash };
    throw new WorkerWorktreeError('WORKTREE_SYNC_FAILED', merge.stderr || 'worker branch could not be synchronized with the target');
  });
}

export function abortWorkerConflictResolution(lease: WorkerWorktreeLease): Promise<boolean> {
  return withLeaseMutation(lease, async () => {
    const marker = await assertOwnedWorktree(lease);
    const mergeHead = await runGit(lease.worktreePath, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], 256);
    if (mergeHead.code === 1) return false;
    if (mergeHead.code !== 0) throw new WorkerWorktreeError('WORKTREE_MERGE_STATE_FAILED', mergeHead.stderr || 'merge state could not be inspected');
    const aborted = await runGit(lease.worktreePath, safeGitArgs(marker.hooksPath, ['merge', '--abort']));
    if (aborted.code !== 0) throw new WorkerWorktreeError('WORKTREE_MERGE_ABORT_FAILED', aborted.stderr || 'owned worker merge could not be aborted');
    return true;
  });
}

/**
 * Integrates only by fast-forwarding a clean checked-out target whose exact HEAD the caller
 * supplied. Divergence/conflicts must first be resolved in the worker worktree and re-gated.
 */
export function integrateWorkerWorkspace(input: {
  lease: WorkerWorktreeLease;
  targetWorkspace: WorkerWorkspace;
  approvedRoots: readonly Root[];
  authorization: WorkerIntegrationAuthorization;
  expectedTargetOid: string;
}): Promise<WorkerIntegrationResult> {
  return withLeaseMutation(input.lease, async () => {
    if (!OID.test(input.expectedTargetOid)) throw new WorkerWorktreeError('WORKTREE_TARGET_REVISION_INVALID', 'expectedTargetOid is invalid');
    const marker = await assertOwnedWorktree(input.lease);
    const plan = await prepareWorkerIntegration({ lease: input.lease, targetWorkspace: input.targetWorkspace, approvedRoots: input.approvedRoots, authorization: input.authorization });
    if (plan.status !== 'ready') return { status: 'not-ready', plan };
    if (plan.targetOid !== input.expectedTargetOid) throw new WorkerWorktreeError('WORKTREE_TARGET_STALE', 'target HEAD changed after integration was planned');
    const target = await targetContext(input.targetWorkspace, input.approvedRoots, input.lease);
    const targetStatus = await statusOf(target.cwd);
    if (targetStatus.headOid !== input.expectedTargetOid) throw new WorkerWorktreeError('WORKTREE_TARGET_STALE', 'target HEAD changed before integration');
    if (targetStatus.dirty) return { status: 'target-dirty', changes: targetStatus.changes, targetOid: targetStatus.headOid, workerHeadOid: plan.workerHeadOid, gateReceiptHash: input.authorization.gate.receiptHash };
    await symbolicHead(target.cwd);
    if (targetStatus.headOid === plan.workerHeadOid) return { status: 'already-integrated', targetOid: targetStatus.headOid, workerHeadOid: plan.workerHeadOid, gateReceiptHash: input.authorization.gate.receiptHash };
    // Re-run the live branded gate at the final mutation boundary. The target is clean and exact;
    // this second capture closes the worker-candidate race without trusting serialized evidence.
    await assertQualityGate(input.lease, input.authorization);
    const ff = await runGit(target.cwd, safeGitArgs(marker.hooksPath, ['merge', '--ff-only', plan.workerHeadOid]));
    if (ff.code !== 0) throw new WorkerWorktreeError('WORKTREE_FAST_FORWARD_FAILED', ff.stderr || 'target could not be fast-forwarded');
    const after = await statusOf(target.cwd);
    if (after.headOid !== plan.workerHeadOid || after.dirty) throw new WorkerWorktreeError('WORKTREE_INTEGRATION_VERIFY_FAILED', 'target did not settle on the gated worker revision');
    return { status: 'integrated', targetOidBefore: input.expectedTargetOid, targetOidAfter: after.headOid, workerHeadOid: plan.workerHeadOid, gateReceiptHash: input.authorization.gate.receiptHash };
  });
}

async function branchCheckedOut(cwd: string, branchRef: string): Promise<boolean> {
  const listed = await runGit(cwd, ['worktree', 'list', '--porcelain'], 1024 * 1024);
  if (listed.code !== 0) throw new WorkerWorktreeError('WORKTREE_LIST_FAILED', listed.stderr || 'Git worktrees could not be listed');
  return text(listed).split('\n').some(line => line === `branch ${branchRef}`);
}

async function deleteOwnedBranch(marker: Marker, disposition: WorkerFinalizeBranch): Promise<boolean> {
  if (disposition.mode === 'keep') return false;
  if (!(await branchExists(marker.sourceRepoRoot, marker.branchRef))) return false;
  const head = await runGit(marker.sourceRepoRoot, ['rev-parse', '--verify', `${marker.branchRef}^{commit}`], 256);
  const branchHead = text(head).trim();
  if (head.code !== 0 || !OID.test(branchHead)) throw new WorkerWorktreeError('WORKTREE_BRANCH_INVALID', head.stderr || 'worker branch could not be inspected');
  if (await branchCheckedOut(marker.sourceRepoRoot, marker.branchRef)) throw new WorkerWorktreeError('WORKTREE_BRANCH_IN_USE', 'worker branch is checked out by another worktree');
  if (disposition.mode === 'delete-if-integrated') {
    if (!OID.test(disposition.integratedIntoOid)) throw new WorkerWorktreeError('WORKTREE_INTEGRATED_REVISION_INVALID', 'integratedIntoOid is invalid');
    const merged = await runGit(marker.sourceRepoRoot, ['merge-base', '--is-ancestor', branchHead, disposition.integratedIntoOid], 128);
    if (merged.code !== 0) {
      if (merged.code === 1) throw new WorkerWorktreeError('WORKTREE_BRANCH_UNMERGED', 'worker branch is not contained by the supplied integrated revision');
      throw new WorkerWorktreeError('WORKTREE_ANCESTRY_FAILED', merged.stderr || 'worker branch ancestry could not be checked');
    }
  }
  const removed = await runGit(marker.sourceRepoRoot, ['update-ref', '-d', marker.branchRef, branchHead], 256);
  if (removed.code !== 0) throw new WorkerWorktreeError('WORKTREE_BRANCH_REMOVE_FAILED', removed.stderr || 'owned worker branch could not be removed');
  return true;
}

async function removeEmptyParents(marker: Marker): Promise<void> {
  for (const candidate of [marker.hooksPath, marker.ownerDir, path.dirname(marker.ownerDir), path.dirname(path.dirname(marker.ownerDir))]) {
    try { await fs.rmdir(candidate); }
    catch (error: unknown) { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error; }
  }
}

/**
 * Retires only a marker-proven worker worktree. Dirty/conflicted worker files survive unless the
 * caller explicitly opts into discardChanges; branch deletion likewise requires either proven
 * integration ancestry or an explicit discard of this owned worker branch.
 */
export function finalizeWorkerWorkspace(input: {
  lease: WorkerWorktreeLease;
  reason: 'completed' | 'cancelled' | 'failed' | 'superseded';
  discardChanges?: boolean;
  branch?: WorkerFinalizeBranch;
}): Promise<WorkerFinalizeResult> {
  return withLeaseMutation(input.lease, async () => {
    const marker = await markerForLease(input.lease);
    let changes: string[] = [];
    let worktreeExists = true;
    try {
      const status = await statusOf(marker.worktreePath);
      changes = status.changes;
      if (status.dirty && input.discardChanges !== true) return { removed: false, branchRemoved: false, branch: marker.branch, changes };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error instanceof WorkerWorktreeError && error.code === 'WORKTREE_PATH_INVALID')) worktreeExists = false;
      else throw error;
    }
    if (worktreeExists) {
      await assertOwnedWorktree(input.lease);
      const args = ['worktree', 'remove', ...(input.discardChanges === true ? ['--force'] : []), marker.worktreePath];
      const removed = await runGit(marker.sourceRepoRoot, safeGitArgs(marker.hooksPath, args));
      if (removed.code !== 0) throw new WorkerWorktreeError('WORKTREE_REMOVE_FAILED', removed.stderr || 'owned worker worktree could not be removed');
    }
    const disposition = input.branch ?? { mode: 'keep' as const };
    if (disposition.mode === 'discard' && !['cancelled', 'failed', 'superseded'].includes(input.reason)) {
      throw new WorkerWorktreeError('WORKTREE_BRANCH_DISCARD_FORBIDDEN', 'completed work can be deleted only after proving it was integrated');
    }
    const branchRemoved = await deleteOwnedBranch(marker, disposition);
    await fs.unlink(marker.markerPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    });
    await removeEmptyParents(marker);
    live.delete(keyOf(input.lease.runId, input.lease.agentId));
    return { removed: true, branchRemoved, branch: marker.branch, changes };
  });
}

/** Test seam only: does not touch disk or Git. */
export function resetWorkerWorktreeRegistryForTests(): void {
  live.clear();
  allocations.clear();
  busy.clear();
}

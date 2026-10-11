import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gitExecutable } from '../project-git.js';

const GIT_TIMEOUT_MS = 20_000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_OWNED_PATHS = 2_000;
const MAX_OWNED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_OWNED_TOTAL_BYTES = 256 * 1024 * 1024;

export interface AgentIdentity {
  runId: string;
  agentId: string;
}

export interface CandidatePathState {
  path: string;
  base: { kind: 'absent' } | { kind: 'file'; oid: string; mode: string };
  worktree: { kind: 'absent' } | { kind: 'file'; sha256: string; bytes: number; mode: number };
}

/**
 * Immutable evidence naming one worker candidate.
 *
 * `candidateRevision` / `candidateTreeOid` are Git's committed identity. `diffHash` closes the
 * gap for an uncommitted worktree by hashing the exact base/current state of every owned path,
 * including untracked additions and deletions. Consumers must compare all three, never one alone.
 */
export interface CandidateAnchor {
  version: 1;
  owner: AgentIdentity;
  repositoryRoot: string;
  gitCommonDir: string;
  baseRevision: string;
  candidateRevision: string;
  candidateTreeOid: string;
  diffHash: string;
  ownedPaths: string[];
  paths: CandidatePathState[];
}

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^GIT_/i.test(key)) delete environment[key];
  return {
    ...environment,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat',
    GIT_CONFIG_KEY_1: 'color.ui', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'diff.external', GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: 'core.fsmonitor', GIT_CONFIG_VALUE_3: 'false'
  };
}

export async function runEvidenceGit(
  cwd: string,
  args: readonly string[],
  input?: Buffer,
  maxOutputBytes = MAX_GIT_OUTPUT_BYTES
): Promise<GitResult> {
  const executable = gitExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--no-optional-locks', ...args], {
      cwd,
      env: cleanGitEnvironment(),
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error, code = -1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8').trim() });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Git took too long while collecting candidate evidence'));
    }, GIT_TIMEOUT_MS);
    child.once('error', error => finish(error));
    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        finish(new Error('Git returned too much candidate evidence'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.once('close', code => finish(undefined, code ?? -1));
    if (input !== undefined) child.stdin!.end(input);
  });
}

function decode(buffer: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function exactOid(value: string, what: string): string {
  const oid = value.trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`Git returned an invalid ${what}`);
  return oid;
}

export function normalizeOwnedPath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) {
    throw new Error('Owned paths must be non-empty repository-relative paths');
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Owned path must be repository-relative: ${value}`);
  }
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`Owned path contains an unsafe segment: ${value}`);
  }
  if (parts[0]!.toLowerCase() === '.git') throw new Error('Git metadata cannot be an owned code path');
  return parts.join('/');
}

function normalizeIdentity(value: AgentIdentity): AgentIdentity {
  const runId = value.runId.trim();
  const agentId = value.agentId.trim();
  if (!runId || runId.length > 128 || !agentId || agentId.length > 128) {
    throw new Error('Candidate owner requires bounded runId and agentId values');
  }
  return { runId, agentId };
}

async function repositoryIdentity(repository: string): Promise<{ root: string; commonDir: string }> {
  const cwd = await fs.realpath(path.resolve(repository));
  const result = await runEvidenceGit(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  if (result.code !== 0) throw new Error(result.stderr || 'Candidate folder is not a Git repository');
  const lines = decode(result.stdout).replaceAll('\r', '').trimEnd().split('\n');
  if (lines.length < 2) throw new Error('Git returned incomplete repository identity');
  const root = await fs.realpath(path.resolve(lines[0]!));
  const commonDir = await fs.realpath(path.resolve(cwd, lines[1]!));
  return { root, commonDir };
}

async function resolveCommit(root: string, revision: string, label: string): Promise<string> {
  if (!revision || revision.length > 512 || revision.includes('\0')) throw new Error(`${label} is invalid`);
  const result = await runEvidenceGit(root, ['rev-parse', '--verify', `${revision}^{commit}`]);
  if (result.code !== 0) throw new Error(result.stderr || `${label} could not be resolved`);
  return exactOid(decode(result.stdout), label);
}

async function resolveTree(root: string, revision: string): Promise<string> {
  const result = await runEvidenceGit(root, ['rev-parse', '--verify', `${revision}^{tree}`]);
  if (result.code !== 0) throw new Error(result.stderr || 'Candidate tree could not be resolved');
  return exactOid(decode(result.stdout), 'candidate tree');
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertNoSymlinkAncestors(root: string, relative: string): Promise<boolean> {
  let cursor = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]!);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try { stat = await fs.lstat(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Owned path crosses a symbolic link: ${relative}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Owned path parent is not a directory: ${relative}`);
  }
  return true;
}

async function worktreeFileState(root: string, relative: string): Promise<CandidatePathState['worktree']> {
  const target = path.resolve(root, ...relative.split('/'));
  if (!contained(root, target)) throw new Error(`Owned path escapes the repository: ${relative}`);
  if (!(await assertNoSymlinkAncestors(root, relative))) return { kind: 'absent' };
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try { stat = await fs.lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Owned path is not a regular file: ${relative}`);
  if (stat.size > MAX_OWNED_FILE_BYTES) throw new Error(`Owned file is too large to fingerprint safely: ${relative}`);
  const bytes = await fs.readFile(target);
  const after = await fs.lstat(target);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
    throw new Error(`Owned file changed while candidate evidence was captured: ${relative}`);
  }
  return { kind: 'file', sha256: hash(bytes), bytes: bytes.length, mode: stat.mode & 0o777 };
}

async function baseFileState(root: string, baseRevision: string, relative: string): Promise<CandidatePathState['base']> {
  const result = await runEvidenceGit(root, ['ls-tree', '-z', baseRevision, '--', relative]);
  if (result.code !== 0) throw new Error(result.stderr || `Git base could not be read for ${relative}`);
  if (result.stdout.length === 0) return { kind: 'absent' };
  const record = decode(result.stdout).replace(/\0$/, '');
  const tab = record.indexOf('\t');
  const header = tab === -1 ? '' : record.slice(0, tab);
  const [mode, type, oid] = header.split(' ');
  if ((mode !== '100644' && mode !== '100755') || type !== 'blob' || !oid || !/^[0-9a-f]{40,64}$/.test(oid)) {
    throw new Error(`Owned base path is not a regular Git file: ${relative}`);
  }
  return { kind: 'file', oid, mode };
}

export function candidateAnchorKey(anchor: CandidateAnchor): string {
  return hash(JSON.stringify([
    anchor.version,
    anchor.owner.runId,
    anchor.owner.agentId,
    anchor.repositoryRoot,
    anchor.gitCommonDir,
    anchor.baseRevision,
    anchor.candidateRevision,
    anchor.candidateTreeOid,
    anchor.diffHash,
    anchor.ownedPaths
  ]));
}

export async function captureCandidateAnchor(input: {
  repository: string;
  baseRevision: string;
  ownedPaths: readonly string[];
  owner: AgentIdentity;
}): Promise<CandidateAnchor> {
  if (input.ownedPaths.length === 0 || input.ownedPaths.length > MAX_OWNED_PATHS) {
    throw new Error(`Candidate must name 1-${MAX_OWNED_PATHS} owned paths`);
  }
  const owner = normalizeIdentity(input.owner);
  const { root, commonDir } = await repositoryIdentity(input.repository);
  const ownedPaths = [...new Set(input.ownedPaths.map(normalizeOwnedPath))].sort();
  if (ownedPaths.length !== input.ownedPaths.length) throw new Error('Candidate owned paths must be unique');
  const baseRevision = await resolveCommit(root, input.baseRevision, 'base revision');
  const candidateRevision = await resolveCommit(root, 'HEAD', 'candidate revision');
  const candidateTreeOid = await resolveTree(root, candidateRevision);
  const paths: CandidatePathState[] = [];
  let totalBytes = 0;
  for (const relative of ownedPaths) {
    const worktree = await worktreeFileState(root, relative);
    if (worktree.kind === 'file') {
      totalBytes += worktree.bytes;
      if (totalBytes > MAX_OWNED_TOTAL_BYTES) throw new Error('Candidate owned files exceed the aggregate fingerprint limit');
    }
    paths.push({ path: relative, base: await baseFileState(root, baseRevision, relative), worktree });
  }
  const diffHash = hash(JSON.stringify(paths));
  return {
    version: 1,
    owner,
    repositoryRoot: root,
    gitCommonDir: commonDir,
    baseRevision,
    candidateRevision,
    candidateTreeOid,
    diffHash,
    ownedPaths,
    paths
  };
}

export function sameCandidateAnchor(left: CandidateAnchor, right: CandidateAnchor): boolean {
  return candidateAnchorKey(left) === candidateAnchorKey(right) && JSON.stringify(left.paths) === JSON.stringify(right.paths);
}

export async function verifyCandidateAnchor(anchor: CandidateAnchor): Promise<boolean> {
  try {
    const current = await captureCandidateAnchor({
      repository: anchor.repositoryRoot,
      baseRevision: anchor.baseRevision,
      ownedPaths: anchor.ownedPaths,
      owner: anchor.owner
    });
    return sameCandidateAnchor(anchor, current);
  } catch {
    return false;
  }
}

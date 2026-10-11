import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  captureCandidateAnchor,
  normalizeOwnedPath,
  runEvidenceGit,
  type AgentIdentity,
  type CandidateAnchor
} from '../quality/candidate.js';

const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 512 * 1024 * 1024;
const CHECKPOINT_BRAND: unique symbol = Symbol('code-checkpoint');
const SEALED_CHECKPOINT_BRAND: unique symbol = Symbol('sealed-code-checkpoint');
const issuedCheckpoints = new WeakSet<object>();
const issuedSealedCheckpoints = new WeakSet<object>();

export type CheckpointFileImage =
  | { kind: 'absent' }
  | { kind: 'file'; blobOid: string; sha256: string; bytes: number; mode: number };

export type CheckpointIndexImage =
  | { kind: 'absent' }
  | { kind: 'file'; blobOid: string; mode: string };

export interface CheckpointPath {
  path: string;
  preimage: CheckpointFileImage;
  preindex: CheckpointIndexImage;
}

interface CodeCheckpointData {
  version: 1;
  checkpointId: string;
  owner: AgentIdentity;
  repositoryRoot: string;
  gitCommonDir: string;
  baseRevision: string;
  headRevision: string;
  headTreeOid: string;
  ownedPaths: string[];
  paths: CheckpointPath[];
  createdAt: number;
  checkpointHash: string;
}

export type CodeCheckpoint = CodeCheckpointData & { readonly [CHECKPOINT_BRAND]: true };

export interface SealedCheckpointPath extends CheckpointPath {
  postimage: CheckpointFileImage;
  postindex: CheckpointIndexImage;
}

interface SealedCodeCheckpointData extends Omit<CodeCheckpointData, 'paths' | 'checkpointHash'> {
  paths: SealedCheckpointPath[];
  checkpointHash: string;
  sealedAt: number;
  sealHash: string;
}

export type SealedCodeCheckpoint = SealedCodeCheckpointData & { readonly [SEALED_CHECKPOINT_BRAND]: true };

export interface CheckpointRestoreResult {
  restored: boolean;
  restoredPaths: string[];
  unchangedPaths: string[];
  reason?: string;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactOid(value: string, label: string): string {
  const oid = value.trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`Git returned an invalid ${label}`);
  return oid;
}

function checkpointIntegrity(value: Omit<CodeCheckpointData, 'checkpointHash'>): string {
  return sha256(JSON.stringify(value));
}

function sealIntegrity(value: Omit<SealedCodeCheckpointData, 'sealHash'>): string {
  return sha256(JSON.stringify(value));
}

function validCheckpoint(value: unknown): value is CodeCheckpoint {
  if (!value || typeof value !== 'object' || !issuedCheckpoints.has(value) || !(CHECKPOINT_BRAND in value)) return false;
  const checkpoint = value as CodeCheckpoint;
  const { checkpointHash, [CHECKPOINT_BRAND]: _brand, ...unsigned } = checkpoint;
  return checkpoint.version === 1 && checkpointHash === checkpointIntegrity(unsigned);
}

function validSealedCheckpoint(value: unknown): value is SealedCodeCheckpoint {
  if (!value || typeof value !== 'object' || !issuedSealedCheckpoints.has(value) || !(SEALED_CHECKPOINT_BRAND in value)) return false;
  const checkpoint = value as SealedCodeCheckpoint;
  const { sealHash, [SEALED_CHECKPOINT_BRAND]: _brand, ...unsigned } = checkpoint;
  return checkpoint.version === 1 && sealHash === sealIntegrity(unsigned);
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function safeTarget(root: string, relative: string): Promise<{ target: string; exists: boolean }> {
  const normalized = normalizeOwnedPath(relative);
  const segments = normalized.split('/');
  let cursor = root;
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]!);
    if (!contained(root, cursor)) throw new Error(`Checkpoint path escapes the repository: ${relative}`);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try { stat = await fs.lstat(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { target: path.resolve(root, ...segments), exists: false };
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Checkpoint path crosses a symbolic link: ${relative}`);
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(`Checkpoint parent is not a directory: ${relative}`);
    if (index === segments.length - 1 && !stat.isFile()) throw new Error(`Checkpoint path is not a regular file: ${relative}`);
  }
  return { target: path.resolve(root, ...segments), exists: true };
}

async function snapshotImage(root: string, relative: string, writeBlob: boolean): Promise<CheckpointFileImage> {
  const { target, exists } = await safeTarget(root, relative);
  if (!exists) return { kind: 'absent' };
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Checkpoint path is not a regular file: ${relative}`);
  if (before.size > MAX_SNAPSHOT_FILE_BYTES) throw new Error(`Checkpoint file is too large: ${relative}`);
  const bytes = await fs.readFile(target);
  const after = await fs.lstat(target);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error(`Checkpoint path changed while it was captured: ${relative}`);
  }
  const hash = sha256(bytes);
  const blob = await runEvidenceGit(root, ['hash-object', ...(writeBlob ? ['-w'] : []), '--no-filters', '--stdin'], bytes);
  if (blob.code !== 0) throw new Error(blob.stderr || `Git could not snapshot ${relative}`);
  const blobOid = exactOid(new TextDecoder().decode(blob.stdout), 'checkpoint blob');
  return { kind: 'file', blobOid, sha256: hash, bytes: bytes.length, mode: before.mode & 0o777 };
}

function sameImage(left: CheckpointFileImage, right: CheckpointFileImage): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'absent' || right.kind === 'absent') return true;
  return left.blobOid === right.blobOid && left.sha256 === right.sha256 && left.bytes === right.bytes && left.mode === right.mode;
}

async function snapshotIndex(root: string, relative: string): Promise<CheckpointIndexImage> {
  const result = await runEvidenceGit(root, ['ls-files', '--stage', '-z', '--', relative]);
  if (result.code !== 0) throw new Error(result.stderr || `Git index could not be read for ${relative}`);
  if (result.stdout.length === 0) return { kind: 'absent' };
  const records = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).split('\0').filter(Boolean);
  if (records.length !== 1) throw new Error(`Checkpoint path has unresolved index stages: ${relative}`);
  const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t(.+)$/.exec(records[0]!);
  if (!match || match[3] !== '0' || (match[1] !== '100644' && match[1] !== '100755')) {
    throw new Error(`Checkpoint path has unsupported index state: ${relative}`);
  }
  return { kind: 'file', mode: match[1]!, blobOid: match[2]! };
}

function sameIndex(left: CheckpointIndexImage, right: CheckpointIndexImage): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'absent' || right.kind === 'absent') return true;
  return left.mode === right.mode && left.blobOid === right.blobOid;
}

function repoMatches(anchor: CandidateAnchor, checkpoint: CodeCheckpointData): boolean {
  return anchor.repositoryRoot === checkpoint.repositoryRoot &&
    anchor.gitCommonDir === checkpoint.gitCommonDir &&
    anchor.baseRevision === checkpoint.baseRevision &&
    anchor.candidateRevision === checkpoint.headRevision &&
    anchor.candidateTreeOid === checkpoint.headTreeOid &&
    anchor.owner.runId === checkpoint.owner.runId && anchor.owner.agentId === checkpoint.owner.agentId;
}

async function recapture(checkpoint: Pick<CodeCheckpointData, 'repositoryRoot' | 'baseRevision' | 'ownedPaths' | 'owner'>): Promise<CandidateAnchor> {
  return captureCandidateAnchor({
    repository: checkpoint.repositoryRoot,
    baseRevision: checkpoint.baseRevision,
    ownedPaths: checkpoint.ownedPaths,
    owner: checkpoint.owner
  });
}

/** Captures exact owned-file preimages as Git blobs without changing index, HEAD or worktree. */
export async function createCodeCheckpoint(input: {
  repository: string;
  baseRevision: string;
  ownedPaths: readonly string[];
  owner: AgentIdentity;
  createdAt?: number;
}): Promise<CodeCheckpoint> {
  const anchor = await captureCandidateAnchor(input);
  const paths: CheckpointPath[] = [];
  let totalBytes = 0;
  for (const relative of anchor.ownedPaths) {
    const preimage = await snapshotImage(anchor.repositoryRoot, relative, true);
    if (preimage.kind === 'file') {
      totalBytes += preimage.bytes;
      if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) throw new Error('Checkpoint preimages exceed the aggregate snapshot limit');
    }
    paths.push({ path: relative, preimage, preindex: await snapshotIndex(anchor.repositoryRoot, relative) });
  }
  // Capture again after blob writes/read work. Git object creation must not have changed the
  // candidate, while an external worktree edit during capture must invalidate the checkpoint.
  const checked = await captureCandidateAnchor(input);
  if (anchor.diffHash !== checked.diffHash || anchor.candidateRevision !== checked.candidateRevision || anchor.candidateTreeOid !== checked.candidateTreeOid) {
    throw new Error('Candidate changed while the checkpoint was created');
  }
  // Index state is independent of working-tree bytes. Keep this as the final filesystem/Git
  // observation before issuing the checkpoint: a user's `git add` that races either the earlier
  // per-file snapshot or the final candidate recapture must never become a stale preindex that a
  // later restore can write back over the user's staging decision.
  for (const entry of paths) {
    const currentIndex = await snapshotIndex(anchor.repositoryRoot, entry.path);
    if (!sameIndex(currentIndex, entry.preindex)) {
      throw new Error(`Git index changed while the checkpoint was created: ${entry.path}`);
    }
  }
  const unsigned: Omit<CodeCheckpointData, 'checkpointHash'> = {
    version: 1,
    checkpointId: randomBytes(16).toString('hex'),
    owner: { ...anchor.owner },
    repositoryRoot: anchor.repositoryRoot,
    gitCommonDir: anchor.gitCommonDir,
    baseRevision: anchor.baseRevision,
    headRevision: anchor.candidateRevision,
    headTreeOid: anchor.candidateTreeOid,
    ownedPaths: [...anchor.ownedPaths],
    paths,
    createdAt: input.createdAt ?? Date.now()
  };
  const checkpointHash = checkpointIntegrity(unsigned);
  const checkpoint = Object.assign({ ...unsigned, checkpointHash }, { [CHECKPOINT_BRAND]: true as const });
  issuedCheckpoints.add(checkpoint);
  return checkpoint;
}

/**
 * Freezes the candidate postimages that a later restore is allowed to replace. Any later edit to
 * one owned path makes restore refuse the whole checkpoint before touching any file.
 */
export async function sealCodeCheckpoint(checkpoint: CodeCheckpoint, sealedAt = Date.now()): Promise<SealedCodeCheckpoint> {
  if (!validCheckpoint(checkpoint)) throw new Error('Checkpoint was not issued by the checkpoint owner');
  const anchor = await recapture(checkpoint);
  if (!repoMatches(anchor, checkpoint)) throw new Error('Repository revision changed before checkpoint sealing');
  const paths: SealedCheckpointPath[] = [];
  let totalBytes = 0;
  for (const entry of checkpoint.paths) {
    const postimage = await snapshotImage(checkpoint.repositoryRoot, entry.path, true);
    if (postimage.kind === 'file') {
      totalBytes += postimage.bytes;
      if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) throw new Error('Checkpoint postimages exceed the aggregate snapshot limit');
    }
    paths.push({ ...entry, postimage, postindex: await snapshotIndex(checkpoint.repositoryRoot, entry.path) });
  }
  const checked = await recapture(checkpoint);
  if (!repoMatches(checked, checkpoint) || checked.diffHash !== anchor.diffHash) throw new Error('Candidate changed while checkpoint postimages were sealed');
  const { [CHECKPOINT_BRAND]: _brand, ...plainCheckpoint } = checkpoint;
  const unsigned: Omit<SealedCodeCheckpointData, 'sealHash'> = {
    ...plainCheckpoint,
    paths,
    sealedAt
  };
  const sealed = Object.assign({ ...unsigned, sealHash: sealIntegrity(unsigned) }, { [SEALED_CHECKPOINT_BRAND]: true as const });
  issuedSealedCheckpoints.add(sealed);
  return sealed;
}

async function readBlob(root: string, image: Extract<CheckpointFileImage, { kind: 'file' }>): Promise<Buffer> {
  const size = await runEvidenceGit(root, ['cat-file', '-s', image.blobOid]);
  if (size.code !== 0) throw new Error(size.stderr || 'Checkpoint blob is no longer available');
  const bytes = Number(new TextDecoder().decode(size.stdout).trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes !== image.bytes || bytes > MAX_SNAPSHOT_FILE_BYTES) {
    throw new Error('Checkpoint blob size does not match its receipt');
  }
  const content = await runEvidenceGit(root, ['cat-file', 'blob', image.blobOid], undefined, image.bytes + 1);
  if (content.code !== 0 || content.stdout.length !== image.bytes || sha256(content.stdout) !== image.sha256) {
    throw new Error('Checkpoint blob content does not match its receipt');
  }
  return content.stdout;
}

async function restoreOne(root: string, entry: SealedCheckpointPath): Promise<'restored' | 'unchanged'> {
  const current = await snapshotImage(root, entry.path, false);
  if (!sameImage(current, entry.postimage)) throw new Error(`Checkpoint postimage no longer matches ${entry.path}`);
  const currentIndex = await snapshotIndex(root, entry.path);
  if (!sameIndex(currentIndex, entry.postindex)) throw new Error(`Checkpoint index postimage no longer matches ${entry.path}`);
  if (sameImage(entry.preimage, entry.postimage) && sameIndex(entry.preindex, entry.postindex)) return 'unchanged';
  const { target } = await safeTarget(root, entry.path);
  if (!sameImage(entry.preimage, entry.postimage) && entry.preimage.kind === 'absent') {
    // Current content was rechecked above. Never recurse: a checkpoint owns one exact file only.
    const beforeDelete = await snapshotImage(root, entry.path, false);
    if (!sameImage(beforeDelete, entry.postimage)) throw new Error(`Checkpoint postimage changed before restoring ${entry.path}`);
    await fs.rm(target, { force: false });
  } else if (!sameImage(entry.preimage, entry.postimage) && entry.preimage.kind === 'file') {
    const content = await readBlob(root, entry.preimage);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Recheck the path after mkdir too: a missing parent could have been replaced by a link
    // between the first target check and directory creation.
    await safeTarget(root, entry.path);
    // Recheck immediately before publication so an edit between the global preflight and this file
    // cannot be silently overwritten by a later restore step.
    const beforeWrite = await snapshotImage(root, entry.path, false);
    if (!sameImage(beforeWrite, entry.postimage)) throw new Error(`Checkpoint postimage changed before restoring ${entry.path}`);
    const tmp = `${target}.cos-checkpoint-${randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, content, { flag: 'wx', mode: entry.preimage.mode });
      await fs.rename(tmp, target);
      await fs.chmod(target, entry.preimage.mode).catch(() => undefined);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  // Index ownership is path-scoped. Do not use reset/checkout/read-tree: each operation below
  // names only this checkpoint-owned path and runs only after its sealed index state matched.
  const beforeIndex = await snapshotIndex(root, entry.path);
  if (!sameIndex(beforeIndex, entry.postindex)) throw new Error(`Checkpoint index changed before restoring ${entry.path}`);
  const indexResult = entry.preindex.kind === 'absent'
    ? await runEvidenceGit(root, ['update-index', '--force-remove', '--', entry.path])
    : await runEvidenceGit(root, ['update-index', '--add', '--cacheinfo', entry.preindex.mode, entry.preindex.blobOid, entry.path]);
  if (indexResult.code !== 0) throw new Error(indexResult.stderr || `Git index could not be restored for ${entry.path}`);
  return 'restored';
}

/**
 * Restores only owned files and only when every one still matches the sealed candidate postimage.
 * No reset, checkout, clean or recursive delete is used. Index restoration is path-scoped to the
 * exact owned entries captured by the checkpoint; unrelated dirty/staged work is not modified.
 */
export async function restoreCodeCheckpoint(checkpoint: SealedCodeCheckpoint): Promise<CheckpointRestoreResult> {
  if (!validSealedCheckpoint(checkpoint)) throw new Error('Sealed checkpoint was not issued by the checkpoint owner');
  let anchor: CandidateAnchor;
  try { anchor = await recapture(checkpoint); }
  catch (error) {
    return { restored: false, restoredPaths: [], unchangedPaths: [], reason: error instanceof Error ? error.message : String(error) };
  }
  if (!repoMatches(anchor, checkpoint)) {
    return { restored: false, restoredPaths: [], unchangedPaths: [], reason: 'Repository revision no longer matches the checkpoint' };
  }
  // All-or-none preflight for ordinary drift. No owned path is changed if any path was edited
  // externally after sealing.
  for (const entry of checkpoint.paths) {
    const current = await snapshotImage(checkpoint.repositoryRoot, entry.path, false);
    const currentIndex = await snapshotIndex(checkpoint.repositoryRoot, entry.path);
    if (!sameImage(current, entry.postimage) || !sameIndex(currentIndex, entry.postindex)) {
      return { restored: false, restoredPaths: [], unchangedPaths: [], reason: `Owned path changed after checkpoint seal: ${entry.path}` };
    }
  }
  const restoredPaths: string[] = [];
  const unchangedPaths: string[] = [];
  for (const entry of checkpoint.paths) {
    const outcome = await restoreOne(checkpoint.repositoryRoot, entry);
    (outcome === 'restored' ? restoredPaths : unchangedPaths).push(entry.path);
  }
  // Verify only the paths this checkpoint owns. A failure is reported; there is deliberately no
  // broad rollback that could overwrite a concurrent user edit made after an earlier restore.
  for (const entry of checkpoint.paths) {
    const current = await snapshotImage(checkpoint.repositoryRoot, entry.path, false);
    const currentIndex = await snapshotIndex(checkpoint.repositoryRoot, entry.path);
    if (!sameImage(current, entry.preimage) || !sameIndex(currentIndex, entry.preindex)) {
      return { restored: false, restoredPaths, unchangedPaths, reason: `Restore verification failed for ${entry.path}` };
    }
  }
  return { restored: true, restoredPaths, unchangedPaths };
}

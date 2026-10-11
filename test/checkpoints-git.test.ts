import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCodeCheckpoint,
  restoreCodeCheckpoint,
  sealCodeCheckpoint
} from '../src/main/checkpoints/index.js';
import type { AgentIdentity } from '../src/main/quality/index.js';

const exec = promisify(execFile);
const owner: AgentIdentity = { runId: 'run-checkpoint', agentId: 'worker-2' };
let temp: string;
let repository: string;
let baseRevision: string;

async function git(...args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd: repository, windowsHide: true });
  return result.stdout.trim();
}

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-checkpoint-'));
  repository = path.join(temp, 'repo');
  await fs.mkdir(repository);
  await git('init');
  await git('config', 'user.email', 'checkpoint@example.com');
  await git('config', 'user.name', 'Checkpoint Test');
  await fs.writeFile(path.join(repository, 'owned.ts'), 'base owned\n');
  await fs.writeFile(path.join(repository, 'deleted.ts'), 'base deleted\n');
  await fs.writeFile(path.join(repository, 'unrelated.ts'), 'base unrelated\n');
  await git('add', '.');
  await git('commit', '-m', 'base');
  baseRevision = await git('rev-parse', 'HEAD');
});

afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

describe('Git-backed code checkpoints', () => {
  it('restores exact owned preimages while preserving unrelated dirty user work', async () => {
    // This dirty value predates the worker and must survive restore rather than being reset to HEAD.
    await fs.writeFile(path.join(repository, 'owned.ts'), 'user preimage\n');
    await fs.writeFile(path.join(repository, 'unrelated.ts'), 'user staged unrelated edit\n');
    await git('add', 'unrelated.ts');
    const checkpoint = await createCodeCheckpoint({
      repository,
      baseRevision,
      ownedPaths: ['owned.ts', 'added.ts', 'deleted.ts'],
      owner
    });

    await fs.writeFile(path.join(repository, 'owned.ts'), 'worker candidate\n');
    await fs.writeFile(path.join(repository, 'added.ts'), 'worker added\n');
    await fs.rm(path.join(repository, 'deleted.ts'));
    await git('add', 'owned.ts', 'added.ts');
    const sealed = await sealCodeCheckpoint(checkpoint);

    const beforeHead = await git('rev-parse', 'HEAD');
    const result = await restoreCodeCheckpoint(sealed);
    expect(result).toMatchObject({ restored: true });
    expect(result.restoredPaths.sort()).toEqual(['added.ts', 'deleted.ts', 'owned.ts']);
    expect(await fs.readFile(path.join(repository, 'owned.ts'), 'utf8')).toBe('user preimage\n');
    await expect(fs.stat(path.join(repository, 'added.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(repository, 'deleted.ts'), 'utf8')).toBe('base deleted\n');
    expect(await fs.readFile(path.join(repository, 'unrelated.ts'), 'utf8')).toBe('user staged unrelated edit\n');
    expect(await git('rev-parse', 'HEAD')).toBe(beforeHead);
    expect(await git('diff', '--cached', '--name-only')).toBe('unrelated.ts');

    const status = await git('status', '--short', '--untracked-files=all');
    expect(status).toContain('owned.ts');
    expect(status).toContain('unrelated.ts');
    expect(status).not.toContain('added.ts');
    expect(status).not.toContain('deleted.ts');
  });

  it('fails the whole restore before writing when any owned postimage was externally edited', async () => {
    const checkpoint = await createCodeCheckpoint({
      repository,
      baseRevision,
      ownedPaths: ['owned.ts', 'added.ts', 'deleted.ts'],
      owner
    });
    await fs.writeFile(path.join(repository, 'owned.ts'), 'worker candidate\n');
    await fs.writeFile(path.join(repository, 'added.ts'), 'worker added\n');
    await fs.rm(path.join(repository, 'deleted.ts'));
    const sealed = await sealCodeCheckpoint(checkpoint);

    await fs.writeFile(path.join(repository, 'owned.ts'), 'external newer edit\n');
    const result = await restoreCodeCheckpoint(sealed);
    expect(result).toMatchObject({ restored: false, restoredPaths: [], unchangedPaths: [] });
    expect(result.reason).toContain('Owned path changed after checkpoint seal');
    expect(await fs.readFile(path.join(repository, 'owned.ts'), 'utf8')).toBe('external newer edit\n');
    expect(await fs.readFile(path.join(repository, 'added.ts'), 'utf8')).toBe('worker added\n');
    await expect(fs.stat(path.join(repository, 'deleted.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses restore after HEAD changes instead of moving branch or index state', async () => {
    const checkpoint = await createCodeCheckpoint({ repository, baseRevision, ownedPaths: ['owned.ts'], owner });
    await fs.writeFile(path.join(repository, 'owned.ts'), 'worker candidate\n');
    const sealed = await sealCodeCheckpoint(checkpoint);

    await fs.writeFile(path.join(repository, 'unrelated.ts'), 'committed later\n');
    await git('add', 'unrelated.ts');
    await git('commit', '-m', 'unrelated later commit');
    const changedHead = await git('rev-parse', 'HEAD');
    const result = await restoreCodeCheckpoint(sealed);
    expect(result).toMatchObject({ restored: false, restoredPaths: [] });
    expect(result.reason).toContain('Repository revision no longer matches');
    expect(await fs.readFile(path.join(repository, 'owned.ts'), 'utf8')).toBe('worker candidate\n');
    expect(await git('rev-parse', 'HEAD')).toBe(changedHead);
  });

  it('refuses restore when staging changed after seal even if file bytes still match', async () => {
    const checkpoint = await createCodeCheckpoint({ repository, baseRevision, ownedPaths: ['owned.ts'], owner });
    await fs.writeFile(path.join(repository, 'owned.ts'), 'worker candidate\n');
    const sealed = await sealCodeCheckpoint(checkpoint);

    await git('add', 'owned.ts');
    const result = await restoreCodeCheckpoint(sealed);
    expect(result).toMatchObject({ restored: false, restoredPaths: [] });
    expect(result.reason).toContain('Owned path changed after checkpoint seal');
    expect(await fs.readFile(path.join(repository, 'owned.ts'), 'utf8')).toBe('worker candidate\n');
    expect(await git('diff', '--cached', '--name-only')).toBe('owned.ts');
  });

  it('refuses checkpoint creation when an owned index entry changes during the multi-file snapshot', async () => {
    await fs.writeFile(path.join(repository, 'second.ts'), 'second\n');
    await git('add', 'second.ts');
    await git('commit', '-m', 'add second');
    baseRevision = await git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(repository, 'owned.ts'), 'user unstaged edit\n');

    const realRead = fs.readFile.bind(fs);
    let secondReads = 0;
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const value = await realRead(...args as Parameters<typeof fs.readFile>);
      // The third read is the final CandidateAnchor recapture, after every preindex was already
      // collected. This targets the late index-only race immediately before checkpoint issuance.
      if (path.resolve(String(args[0])) === path.resolve(repository, 'second.ts') && ++secondReads === 3) {
        await git('add', 'owned.ts');
      }
      return value as never;
    });
    try {
      await expect(createCodeCheckpoint({ repository, baseRevision, ownedPaths: ['owned.ts', 'second.ts'], owner }))
        .rejects.toThrow('Git index changed while the checkpoint was created: owned.ts');
      expect(await git('diff', '--cached', '--name-only')).toBe('owned.ts');
    } finally {
      readSpy.mockRestore();
    }
  });

  it('rejects traversal and non-file ownership instead of snapshotting broader workspace state', async () => {
    await expect(createCodeCheckpoint({ repository, baseRevision, ownedPaths: ['../outside.ts'], owner }))
      .rejects.toThrow('unsafe segment');
    await fs.mkdir(path.join(repository, 'folder'));
    await expect(createCodeCheckpoint({ repository, baseRevision, ownedPaths: ['folder'], owner }))
      .rejects.toThrow('not a regular file');
  });
});

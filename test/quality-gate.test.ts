import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Root } from '../src/shared/types.js';
import { gitExecutable } from '../src/main/project-git.js';
import { gateWorkerFinish, resetQualityGateForTests } from '../src/main/quality-gate.js';
import { normalizeQualityChecks, parseQualityCheck } from '../src/shared/quality-checks.js';
import { allocWorkerWorkspace, resetWorkerWorktreeRegistryForTests, type WorkerWorktreeLease } from '../src/main/worktrees/index.js';

const RUN_ID = '33333333-3333-4333-8333-333333333333';

function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  return execFileSync(gitExecutable(), args, { cwd, env, encoding: 'utf8', windowsHide: true }).trim();
}

describe('quality check lines', () => {
  it('splits arguments on whitespace and groups double-quoted text without a shell', () => {
    expect(parseQualityCheck('npm run  test -- --reporter dot')).toEqual(['npm', 'run', 'test', '--', '--reporter', 'dot']);
    expect(parseQualityCheck('"C:\\Program Files\\node.exe" "a b" "" x|y')).toEqual(['C:\\Program Files\\node.exe', 'a b', '', 'x|y']);
    expect(parseQualityCheck('node "unterminated')).toBeNull();
    expect(parseQualityCheck('""')).toBeNull();
  });

  it('keeps non-empty trimmed lines and refuses more than eight or an unparsable one', () => {
    expect(normalizeQualityChecks(['  npm test ', '', 'npm run typecheck'])).toEqual({ checks: ['npm test', 'npm run typecheck'] });
    expect(normalizeQualityChecks(Array.from({ length: 9 }, () => 'npm test'))).toHaveProperty('error');
    expect(normalizeQualityChecks(['node "x'])).toHaveProperty('error');
    expect(normalizeQualityChecks(['x'.repeat(501)])).toHaveProperty('error');
  });
});

describe('quality checks on a worker finish', () => {
  let temp = '';
  let repo = '';
  let scripts = '';
  let roots: Root[] = [];
  let lease: WorkerWorktreeLease;

  beforeEach(async () => {
    resetQualityGateForTests();
    resetWorkerWorktreeRegistryForTests();
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-quality-'));
    const approved = path.join(temp, 'approved');
    repo = path.join(approved, 'repo');
    scripts = path.join(temp, 'scripts');
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(scripts);
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'CoS Quality Test']);
    git(repo, ['config', 'user.email', 'quality-test@example.invalid']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    await fs.writeFile(path.join(repo, 'file.txt'), 'broken\n');
    await fs.writeFile(path.join(repo, '.gitignore'), 'build/\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'base']);
    roots = [{ name: 'approved', path: approved }];
    lease = await allocWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1', primeWorkspace: { real: repo, virtual: '/approved/repo' }, approvedRoots: roots });
  });

  afterEach(async () => {
    resetQualityGateForTests();
    resetWorkerWorktreeRegistryForTests();
    await fs.rm(temp, { recursive: true, force: true });
  });

  async function check(name: string, source: string, ...args: string[]): Promise<string> {
    const file = path.join(scripts, `${name}.cjs`);
    await fs.writeFile(file, source);
    return [process.execPath, file, ...args].map(part => `"${part}"`).join(' ');
  }
  const contentCheck = () => check('content', `
    const fs = require('fs');
    const text = fs.readFileSync('file.txt', 'utf8');
    console.log('file says ' + text.trim());
    process.exit(text.includes('fixed') ? 0 : 3);`);
  const gate = (checks: string[], waitMs = 20_000) => gateWorkerFinish({ lease, checks, roots, waitMs });

  it('does nothing without checks and says so when the worker has no isolated checkout', async () => {
    expect(await gate([])).toBeNull();
    expect(await gateWorkerFinish({ lease: null, checks: ['npm test'], roots })).toEqual({
      kind: 'accept', preface: expect.stringContaining('[Quality checks not run]')
    });
  });

  it('runs in the worker checkout, not the source repository, and names the passed candidate', async () => {
    const cwd = await check('cwd', `
      const fs = require('fs');
      process.exit(fs.realpathSync(process.cwd()) === fs.realpathSync(process.argv[2]) ? 0 : 4);`, lease.workspace.real);
    const head = git(lease.workspace.real, ['rev-parse', 'HEAD']);
    const result = await gate([cwd]);
    expect(result).toEqual({ kind: 'accept', preface: expect.stringContaining('[Quality checks passed]') });
    expect(result?.kind === 'accept' && result.preface).toContain(`commit ${head.slice(0, 12)}.`);
    expect(lease.workspace.real).not.toBe(repo);
  });

  it('refuses the first failed finish with its output, then accepts the unchanged candidate as failed', async () => {
    const checks = [await contentCheck()];
    const first = await gate(checks);
    expect(first?.kind).toBe('refuse');
    expect(first?.kind === 'refuse' && first.text).toMatch(/exited with 3/);
    expect(first?.kind === 'refuse' && first.text).toContain('file says broken');

    const second = await gate(checks);
    expect(second).toEqual({ kind: 'accept', preface: expect.stringContaining('[Quality checks FAILED]') });
    expect(second?.kind === 'accept' && second.preface).toContain('exited with 3');
  });

  it('runs again for a fixed candidate and reports the uncommitted change', async () => {
    const checks = [await contentCheck()];
    expect((await gate(checks))?.kind).toBe('refuse');
    await fs.writeFile(path.join(lease.workspace.real, 'file.txt'), 'fixed\n');
    const fixed = await gate(checks);
    expect(fixed).toEqual({ kind: 'accept', preface: expect.stringContaining('[Quality checks passed]') });
    expect(fixed?.kind === 'accept' && fixed.preface).toContain('with uncommitted changes');
  });

  it('applies a result only to the exact command list it ran with', async () => {
    await fs.writeFile(path.join(lease.workspace.real, 'file.txt'), 'fixed\n');
    const content = await contentCheck();
    expect((await gate([content]))?.kind).toBe('accept');
    const failing = await check('fail', 'process.exit(5);');
    const stricter = await gate([content, failing]);
    expect(stricter?.kind === 'refuse' && stricter.text).toMatch(/exited with 5/);
  });

  it('fails a run whose check changes the candidate, but not one that only writes ignored output', async () => {
    const ignored = await check('ignored', `
      const fs = require('fs');
      fs.mkdirSync('build', { recursive: true });
      fs.writeFileSync('build/out.txt', String(Date.now()));`);
    expect(await gate([ignored])).toEqual({ kind: 'accept', preface: expect.stringContaining('[Quality checks passed]') });

    resetQualityGateForTests();
    const mutating = await check('mutating', `require('fs').writeFileSync('generated.txt', 'new');`);
    const changed = await gate([mutating]);
    expect(changed?.kind === 'refuse' && changed.text).toContain('the checks changed the candidate');
  });

  it('refuses while checks run, keeps one run per worker, and accepts once it passes', async () => {
    const slow = await check('slow', 'setTimeout(() => process.exit(0), 1500);');
    const running = await gate([slow], 50);
    expect(running?.kind === 'refuse' && running.text).toMatch(/Quality checks are running on your checkout \(1\/1/);

    await fs.writeFile(path.join(lease.workspace.real, 'file.txt'), 'edited while running\n');
    const earlier = await gate([slow], 50);
    expect(earlier?.kind === 'refuse' && earlier.text).toContain('earlier version of your checkout');

    await new Promise(resolve => setTimeout(resolve, 1800));
    // The first run saw its candidate change underneath it, so it cannot pass.
    const rerun = await gate([slow], 5_000);
    expect(rerun).toEqual({ kind: 'accept', preface: expect.stringContaining('[Quality checks passed]') });
  });
});

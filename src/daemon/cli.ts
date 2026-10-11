import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { JobDaemonClient } from './client.js';
import { JobDaemonServer } from './server.js';
import type { CreateScheduledJob, MissedRunPolicy } from '../main/jobs/types.js';

type CliIo = { out: (text: string) => void; error: (text: string) => void };

function options(args: readonly string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i]!;
    if (!current.startsWith('--')) throw new Error(`unexpected argument: ${current}`);
    const [rawKey, inline] = current.slice(2).split('=', 2);
    if (!rawKey) throw new Error('empty option');
    if (inline !== undefined) { out.set(rawKey, inline); continue; }
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { out.set(rawKey, next); i += 1; }
    else out.set(rawKey, true);
  }
  return out;
}

function required(map: Map<string, string | true>, key: string): string {
  const value = map.get(key);
  if (typeof value !== 'string' || !value) throw new Error(`--${key} is required`);
  return value;
}

function integer(map: Map<string, string | true>, key: string): number | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`--${key} must be an integer`);
  return Number(value);
}

function timestamp(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('--at must be an epoch millisecond value or ISO date');
  return parsed;
}

function missed(map: Map<string, string | true>): MissedRunPolicy {
  const mode = map.get('missed') ?? 'fire-once';
  if (mode === 'fire-once') return { mode: 'fire-once' };
  if (mode !== 'skip') throw new Error('--missed must be fire-once or skip');
  return { mode: 'skip', graceMs: integer(map, 'grace-ms') ?? 60_000 };
}

function scheduleJob(map: Map<string, string | true>): CreateScheduledJob {
  const at = timestamp(required(map, 'at'));
  const every = integer(map, 'every-ms');
  return {
    id: typeof map.get('id') === 'string' ? map.get('id') as string : randomUUID(),
    sessionId: required(map, 'session'),
    text: required(map, 'text'),
    interrupt: map.get('interrupt') === true,
    schedule: every === undefined ? { kind: 'once', at } : { kind: 'interval', anchorAt: at, everyMs: every },
    missedRun: missed(map)
  };
}

export async function runDaemonCli(argv = process.argv.slice(2), io: CliIo = { out: console.log, error: console.error }): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'serve') {
      const map = options(rest);
      const server = new JobDaemonServer({
        stateDir: required(map, 'state-dir'),
        appDataDir: required(map, 'app-data'),
        tickMs: integer(map, 'tick-ms')
      });
      await server.start();
      io.out(JSON.stringify({ ok: true, port: server.port() }));
      const stop = () => { void server.stop().finally(() => process.exit(0)); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return 0;
    }

    if (command === 'schedule') {
      const map = options(rest);
      const client = new JobDaemonClient(required(map, 'state-dir'));
      io.out(JSON.stringify(await client.create(scheduleJob(map)), null, 2));
      return 0;
    }

    if (command === 'list') {
      const map = options(rest);
      const client = new JobDaemonClient(required(map, 'state-dir'));
      io.out(JSON.stringify(await client.list(), null, 2));
      return 0;
    }

    if (command === 'cancel') {
      const map = options(rest);
      const client = new JobDaemonClient(required(map, 'state-dir'));
      io.out(JSON.stringify({ cancelled: await client.cancel(required(map, 'id')) }));
      return 0;
    }

    throw new Error('usage: serve|schedule|list|cancel');
  } catch (error) {
    io.error((error as Error).message);
    return 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  void runDaemonCli().then((code) => { if (code !== 0) process.exitCode = code; });
}

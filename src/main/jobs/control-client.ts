import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ControlApiHealth, ControlApiInput, ControlApiInputs, ControlApiSessionDetail, ControlApiStatus } from '../../shared/control-api.js';
import type { JobReceipt } from './types.js';

interface EndpointFile { protocol: number; port: number; pid: number; appVersion: string; startedAt: string }
interface HttpReply<T = unknown> { status: number; body: T | null }

export type FirePreflight =
  | { ok: true }
  | { ok: false; retryable: boolean; code: string; detail: string };

export interface SendAdmission {
  status: number;
  body: Record<string, unknown> | null;
}

export class ControlApiClient {
  constructor(private readonly appDataDir: string, private readonly timeoutMs = 10_000) {}

  private async credentials(): Promise<{ port: number; token: string } | null> {
    const dir = path.join(this.appDataDir, 'control-api');
    try {
      const [endpointText, tokenText] = await Promise.all([
        fs.readFile(path.join(dir, 'endpoint.json'), 'utf8'),
        fs.readFile(path.join(dir, 'token'), 'utf8')
      ]);
      const endpoint = JSON.parse(endpointText) as Partial<EndpointFile>;
      const token = tokenText.trim();
      if (endpoint.protocol !== 1 || !Number.isSafeInteger(endpoint.port) || endpoint.port! <= 0 || endpoint.port! > 65535 || !token) return null;
      return { port: endpoint.port!, token };
    } catch {
      return null;
    }
  }

  private async request<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<HttpReply<T>> {
    const credentials = await this.credentials();
    if (!credentials) throw new Error('app_unavailable');
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise<HttpReply<T>>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: credentials.port,
        path: route,
        method,
        headers: {
          authorization: `Bearer ${credentials.token}`,
          host: `127.0.0.1:${credentials.port}`,
          ...(payload ? { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) } : {})
        }
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try { parsed = text ? JSON.parse(text) : null; }
          catch { parsed = null; }
          resolve({ status: res.statusCode ?? 0, body: parsed as T | null });
        });
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('control_api_timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async preflight(sessionId: string): Promise<FirePreflight> {
    let health: HttpReply<ControlApiHealth>;
    try { health = await this.request<ControlApiHealth>('GET', '/v1/health'); }
    catch (error) { return { ok: false, retryable: true, code: 'app_unavailable', detail: (error as Error).message }; }
    if (health.status !== 200 || !health.body?.ok) return { ok: false, retryable: true, code: 'app_unavailable', detail: `health returned ${health.status}` };
    if (!health.body.actions.enabled) return { ok: false, retryable: false, code: 'actions_disabled', detail: 'control API actions are disabled at fire time' };

    let status: HttpReply<ControlApiStatus>;
    try { status = await this.request<ControlApiStatus>('GET', '/v1/status'); }
    catch (error) { return { ok: false, retryable: true, code: 'app_unavailable', detail: (error as Error).message }; }
    if (status.status !== 200 || !status.body) return { ok: false, retryable: true, code: 'status_unavailable', detail: `status returned ${status.status}` };
    const bridge = status.body.bridge;
    if (!bridge.running || !bridge.paired || !bridge.present) {
      return { ok: false, retryable: true, code: 'browser_unobserved', detail: 'the app has no currently observed paired browser' };
    }

    let detail: HttpReply<ControlApiSessionDetail>;
    try { detail = await this.request<ControlApiSessionDetail>('GET', `/v1/sessions/${encodeURIComponent(sessionId)}?live=1`); }
    catch (error) { return { ok: false, retryable: true, code: 'session_unavailable', detail: (error as Error).message }; }
    if (detail.status === 404) return { ok: false, retryable: false, code: 'session_not_found', detail: 'the target session no longer exists' };
    if (detail.status !== 200 || !detail.body) return { ok: false, retryable: true, code: 'session_unavailable', detail: `session read returned ${detail.status}` };
    if (!detail.body.session.conversationId) return { ok: false, retryable: false, code: 'no_chat', detail: 'the target session has no ChatGPT conversation' };
    if (!detail.body.live) return { ok: false, retryable: true, code: 'live_state_unavailable', detail: 'the target chat moved or its live state is unavailable' };
    if (detail.body.live?.blocked) return { ok: false, retryable: false, code: `chat_${detail.body.live.blocked}`, detail: 'the target chat is not controllable at fire time' };
    return { ok: true };
  }

  async send(receipt: JobReceipt): Promise<SendAdmission> {
    const reply = await this.request<Record<string, unknown>>('POST', '/v1/inputs', {
      id: receipt.outboxId,
      sessionId: receipt.sessionId,
      text: receipt.text,
      ...(receipt.interrupt ? { interrupt: true } : {})
    });
    return { status: reply.status, body: reply.body };
  }

  async findInput(id: string): Promise<ControlApiInput | null> {
    const reply = await this.request<ControlApiInputs>('GET', '/v1/inputs?limit=500');
    if (reply.status !== 200 || !reply.body) return null;
    return reply.body.inputs.find((input) => input.id === id) ?? null;
  }
}

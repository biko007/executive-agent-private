/**
 * cue-delegation/manus-client — minimaler HTTP-Client fuer die Manus API v2.
 *
 * Verifiziert gegen die offizielle Doku (Stand 2026-10-08):
 *   Index            https://open.manus.ai/docs/llms.txt
 *   Authentifizierung https://open.manus.ai/docs/v2/authentication
 *   Rate Limits      https://open.manus.ai/docs/v2/rate-limits
 *   Agenten          https://open.manus.ai/docs/v2/agents-overview
 *   Spezifikation    https://open.manus.ai/docs/v2/openapi_v2.json  (OpenAPI 3.1.0)
 *
 * Bewusst kein SDK: die vier benoetigten Endpunkte sind vier GET/POST-Aufrufe mit
 * einem Header. Eine Abhaengigkeit mehr in package.json wuerde hier nichts tragen.
 *
 * Alle Antworten tragen dieselbe Huelle:
 *   Erfolg  { "ok": true,  "request_id": "...", <Nutzlast> }
 *   Fehler  { "ok": false, "request_id": "...", "error": { "code", "message" } }
 * Deshalb wird `ok` immer ausgewertet — ein HTTP 200 allein bedeutet nicht Erfolg.
 *
 * Der API-Key erscheint niemals in einer Fehlermeldung oder einem Log: jede nach
 * aussen gehende Zeichenkette laeuft durch `scrubKey()`.
 */
import { fetchWithTimeout, sleep } from '../../shared/utils/index.js';

/** Basis-URL laut OpenAPI `servers[0].url`; alle Pfade tragen das Prefix /v2/. */
export const MANUS_BASE_URL = 'https://api.manus.ai';

/** Obergrenze fuer uebernommene Fehlertexte der Gegenseite. */
const MAX_ERROR_TEXT = 300;

/** Fehlercodes, bei denen ein Wiederholungsversuch sinnvoll ist. */
const RETRYABLE_CODES = new Set(['rate_limited', 'network_error', 'fetch_timeout']);

export class ManusError extends Error {
  /** API-Fehlercode (z. B. `unauthenticated`, `rate_limited`) oder `http_<status>`. */
  readonly code: string;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  /** true, wenn ein erneuter Versuch Aussicht auf Erfolg hat. */
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    opts: { httpStatus?: number | null; requestId?: string | null; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ManusError';
    this.code = code;
    this.httpStatus = opts.httpStatus ?? null;
    this.requestId = opts.requestId ?? null;
    this.retryable =
      opts.retryable ?? (RETRYABLE_CODES.has(code) || (opts.httpStatus ?? 0) >= 500);
  }
}

// ── Antwort-Typen (nur die in Phase 1 genutzten Felder) ────────────────────

/** https://open.manus.ai/docs/v2/agent.list — Agent.task_id ist der Main-Task. */
export interface ManusAgent {
  id: string;
  task_id: string;
  nickname?: string;
  about?: string;
}

export type ManusAgentStatus = 'running' | 'stopped' | 'waiting' | 'error';

/**
 * Ein Ereignis aus task.listMessages. Genau ein Nutzlastfeld ist gesetzt,
 * bestimmt durch `type`. Ohne `verbose=true` liefert die API nur die Typen
 * user_message, assistant_message, error_message, status_update, user_stop.
 */
export interface ManusTaskEvent {
  id: string;
  type: string;
  timestamp?: number;
  user_message?: { content?: string };
  assistant_message?: { content?: string; delivery_kind?: string };
  error_message?: { error_type?: string; content?: string };
  status_update?: {
    agent_status?: ManusAgentStatus;
    brief?: string;
    description?: string;
    status_detail?: {
      waiting_for_event_id?: string;
      waiting_for_event_type?: string;
      waiting_description?: string;
    };
  };
}

export interface ManusListMessagesResult {
  taskId: string;
  messages: ManusTaskEvent[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ManusClientOptions {
  apiKey: string;
  /** Nur fuer Tests: ersetzt den HTTP-Aufruf vollstaendig. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Nur fuer Tests: ersetzt die Wartezeit zwischen Versuchen. */
  sleepImpl?: (ms: number) => Promise<void>;
  baseUrl?: string;
  timeoutMs?: number;
  /** Gesamtzahl der Versuche je Aufruf (inklusive Erstversuch). */
  maxAttempts?: number;
}

export interface ManusClient {
  getAgent(agentId: string): Promise<ManusAgent>;
  listAgents(): Promise<ManusAgent[]>;
  sendMessage(taskId: string, text: string): Promise<{ taskId: string; requestId: string | null }>;
  listMessages(
    taskId: string,
    opts?: { limit?: number; order?: 'asc' | 'desc' },
  ): Promise<ManusListMessagesResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

/**
 * Wartezeit vor dem naechsten Versuch: exponentiell mit Streuung.
 * Die Doku verlangt ausdruecklich "exponential delay plus jitter" und keine
 * engen Wiederholungsschleifen (https://open.manus.ai/docs/v2/rate-limits).
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  const jitter = 1 + (random() - 0.5) / 2; // +/- 25 %
  return Math.round(Math.min(base * jitter, BACKOFF_CAP_MS));
}

/** Jede nach aussen gehende Zeichenkette von Key-Material befreien. */
function scrubKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

function shorten(text: string): string {
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

export function createManusClient(options: ManusClientOptions): ManusClient {
  const apiKey = options.apiKey;
  const baseUrl = options.baseUrl ?? MANUS_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const wait = options.sleepImpl ?? sleep;
  const doFetch =
    options.fetchImpl ?? ((url: string, init: RequestInit) => fetchWithTimeout(url, init, timeoutMs));

  function fail(code: string, message: string, extra: { httpStatus?: number | null; requestId?: string | null } = {}): never {
    throw new ManusError(code, shorten(scrubKey(message, apiKey)), extra);
  }

  /** Einen Versuch ausfuehren und die Antwort-Huelle auswerten. */
  async function attempt(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'x-manus-api-key': apiKey,
          'Content-Type': 'application/json',
          ...((init.headers as Record<string, string>) ?? {}),
        },
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // fetchWithTimeout meldet Zeitueberschreitung als fetch_timeout_after_<ms>ms
      const code = msg.includes('fetch_timeout') ? 'fetch_timeout' : 'network_error';
      fail(code, `Manus nicht erreichbar: ${msg}`);
    }

    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      fail('invalid_response', `Manus antwortete ohne verwertbares JSON (HTTP ${res.status})`, {
        httpStatus: res.status,
      });
    }

    const requestId = typeof body.request_id === 'string' ? body.request_id : null;

    if (body.ok === true) return body;

    // Fehlerhuelle auswerten; bei fehlendem error-Objekt auf den HTTP-Status zurueckfallen.
    const err = (body.error ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof err.code === 'string' && err.code ? err.code : `http_${res.status}`;
    const message = typeof err.message === 'string' && err.message ? err.message : `HTTP ${res.status}`;
    fail(code, message, { httpStatus: res.status, requestId });
  }

  /** Versuch plus Wiederholungen. Wiederholt nur, was laut `retryable` Sinn hat. */
  async function request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let last: ManusError | null = null;
    for (let n = 1; n <= maxAttempts; n++) {
      try {
        return await attempt(path, init);
      } catch (e: any) {
        if (!(e instanceof ManusError) || !e.retryable || n === maxAttempts) throw e;
        last = e;
        await wait(backoffMs(n));
      }
    }
    throw last ?? new ManusError('unknown', 'Manus-Aufruf fehlgeschlagen');
  }

  return {
    async getAgent(agentId: string): Promise<ManusAgent> {
      const q = new URLSearchParams({ agent_id: agentId });
      const body = await request(`/v2/agent.detail?${q}`, { method: 'GET' });
      const agent = body.agent as ManusAgent | undefined;
      if (!agent?.task_id) {
        fail('invalid_response', `Agent ${agentId} hat keinen Main-Task (task_id fehlt)`);
      }
      return agent;
    },

    async listAgents(): Promise<ManusAgent[]> {
      const body = await request('/v2/agent.list', { method: 'GET' });
      return Array.isArray(body.data) ? (body.data as ManusAgent[]) : [];
    },

    async sendMessage(taskId: string, text: string) {
      const body = await request('/v2/task.sendMessage', {
        method: 'POST',
        body: JSON.stringify({ task_id: taskId, message: { content: text } }),
      });
      return {
        taskId: typeof body.task_id === 'string' ? body.task_id : taskId,
        requestId: typeof body.request_id === 'string' ? body.request_id : null,
      };
    },

    async listMessages(taskId: string, opts: { limit?: number; order?: 'asc' | 'desc' } = {}) {
      const q = new URLSearchParams({ task_id: taskId });
      q.set('limit', String(opts.limit ?? 50));
      q.set('order', opts.order ?? 'desc');
      const body = await request(`/v2/task.listMessages?${q}`, { method: 'GET' });
      return {
        taskId: typeof body.task_id === 'string' ? body.task_id : taskId,
        messages: Array.isArray(body.messages) ? (body.messages as ManusTaskEvent[]) : [],
        hasMore: body.has_more === true,
        nextCursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
      };
    },
  };
}

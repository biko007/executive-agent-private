/**
 * cue-delegation — Fehlerpfade des Manus-Clients.
 *
 * Reine Unit-Tests: der HTTP-Aufruf wird ueber `fetchImpl` ersetzt, die
 * Wartezeit ueber `sleepImpl`. Es geht nie ein Aufruf nach aussen — ein echter
 * API-Kontakt findet ausschliesslich im manuellen E2E-Test statt.
 */
import { describe, test, expect } from 'bun:test';
import { createManusClient, ManusError, backoffMs, MANUS_BASE_URL } from '../manus-client.js';

const KEY = 'sk-manus-geheim-0123456789';

/** Minimale Response-Attrappe: der Client nutzt nur status und json(). */
function antwort(status: number, body: unknown): Response {
  return {
    status,
    json: async () => {
      if (body === undefined) throw new Error('not json');
      return body;
    },
  } as unknown as Response;
}

interface Aufruf { url: string; init: RequestInit }

function client(
  antworten: Array<Response | Error>,
  opts: { maxAttempts?: number } = {},
): { c: ReturnType<typeof createManusClient>; aufrufe: Aufruf[]; wartezeiten: number[] } {
  const aufrufe: Aufruf[] = [];
  const wartezeiten: number[] = [];
  let i = 0;
  const c = createManusClient({
    apiKey: KEY,
    maxAttempts: opts.maxAttempts ?? 3,
    sleepImpl: async (ms) => { wartezeiten.push(ms); },
    fetchImpl: async (url, init) => {
      aufrufe.push({ url, init });
      const next = antworten[Math.min(i, antworten.length - 1)];
      i++;
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { c, aufrufe, wartezeiten };
}

describe('manus-client — Antwort-Huelle', () => {
  test('ok:true liefert die Nutzlast', async () => {
    const { c, aufrufe } = client([antwort(200, { ok: true, request_id: 'req_1', task_id: 'T1' })]);
    const res = await c.sendMessage('T1', 'Hallo');
    expect(res.taskId).toBe('T1');
    expect(res.requestId).toBe('req_1');
    expect(aufrufe[0].url).toBe(`${MANUS_BASE_URL}/v2/task.sendMessage`);
    expect(JSON.parse(String(aufrufe[0].init.body))).toEqual({
      task_id: 'T1',
      message: { content: 'Hallo' },
    });
  });

  test('API-Key geht als x-manus-api-key-Header mit', async () => {
    const { c, aufrufe } = client([antwort(200, { ok: true, data: [] })]);
    await c.listAgents();
    const headers = aufrufe[0].init.headers as Record<string, string>;
    expect(headers['x-manus-api-key']).toBe(KEY);
    expect(headers['Authorization']).toBeUndefined();
  });

  test('ok:false wird zum ManusError mit API-Fehlercode', async () => {
    const { c } = client([
      antwort(400, { ok: false, request_id: 'req_2', error: { code: 'invalid_argument', message: 'zu lang' } }),
    ]);
    const err = await c.sendMessage('T1', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(ManusError);
    expect(err.code).toBe('invalid_argument');
    expect(err.requestId).toBe('req_2');
    expect(err.retryable).toBe(false);
  });

  test('HTTP 200 mit ok:false gilt als Fehler, nicht als Erfolg', async () => {
    const { c } = client([antwort(200, { ok: false, error: { code: 'permission_denied', message: 'nein' } })]);
    const err = await c.listAgents().catch((e) => e);
    expect(err.code).toBe('permission_denied');
  });

  test('Fehlerhuelle ohne error-Objekt fällt auf den HTTP-Status zurueck', async () => {
    const { c } = client([antwort(418, { ok: false })], { maxAttempts: 1 });
    const err = await c.listAgents().catch((e) => e);
    expect(err.code).toBe('http_418');
  });

  test('Antwort ohne JSON wird zu invalid_response', async () => {
    const { c } = client([antwort(502, undefined)], { maxAttempts: 1 });
    const err = await c.listAgents().catch((e) => e);
    expect(err.code).toBe('invalid_response');
    expect(err.httpStatus).toBe(502);
  });
});

describe('manus-client — Wiederholungsverhalten', () => {
  test('unauthenticated wird nicht wiederholt', async () => {
    const { c, aufrufe } = client([
      antwort(401, { ok: false, error: { code: 'unauthenticated', message: 'missing authentication' } }),
    ]);
    const err = await c.listAgents().catch((e) => e);
    expect(err.code).toBe('unauthenticated');
    expect(aufrufe.length).toBe(1);
  });

  test('rate_limited wird mit Backoff wiederholt und kann danach gelingen', async () => {
    const { c, aufrufe, wartezeiten } = client([
      antwort(429, { ok: false, error: { code: 'rate_limited', message: 'Rate limit exceeded' } }),
      antwort(200, { ok: true, data: [] }),
    ]);
    await c.listAgents();
    expect(aufrufe.length).toBe(2);
    expect(wartezeiten.length).toBe(1);
    expect(wartezeiten[0]).toBeGreaterThan(0);
  });

  test('dauerhafte 5xx scheitern nach maxAttempts Versuchen', async () => {
    const { c, aufrufe } = client([antwort(500, { ok: false, error: { code: 'internal', message: 'boom' } })]);
    const err = await c.listAgents().catch((e) => e);
    expect(err).toBeInstanceOf(ManusError);
    expect(aufrufe.length).toBe(3);
  });

  test('Netzwerkfehler ergibt network_error und wird wiederholt', async () => {
    const { c, aufrufe } = client([new Error('fetch failed')]);
    const err = await c.listAgents().catch((e) => e);
    expect(err.code).toBe('network_error');
    expect(aufrufe.length).toBe(3);
  });

  test('Zeitueberschreitung ergibt fetch_timeout', async () => {
    const { c } = client([new Error('fetch_timeout_after_30000ms')], { maxAttempts: 1 });
    const err = await c.listAgents().catch((e) => e);
    expect(err.code).toBe('fetch_timeout');
  });

  test('backoffMs waechst exponentiell und bleibt gedeckelt', () => {
    expect(backoffMs(1, () => 0.5)).toBe(1_000);
    expect(backoffMs(2, () => 0.5)).toBe(2_000);
    expect(backoffMs(3, () => 0.5)).toBe(4_000);
    expect(backoffMs(20, () => 0.5)).toBe(30_000);
    // Streuung bleibt innerhalb +/- 25 %
    expect(backoffMs(1, () => 0)).toBe(750);
    expect(backoffMs(1, () => 1)).toBe(1_250);
  });
});

describe('manus-client — kein Key-Material nach aussen', () => {
  test('ein in der Fehlermeldung gespiegelter Key wird unkenntlich gemacht', async () => {
    const { c } = client([
      antwort(400, { ok: false, error: { code: 'invalid_argument', message: `bad key ${KEY} supplied` } }),
    ]);
    const err = await c.listAgents().catch((e) => e);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('***');
  });

  test('Netzwerkfehlertexte enthalten keinen Key', async () => {
    const { c } = client([new Error(`connect to host with ${KEY}`)], { maxAttempts: 1 });
    const err = await c.listAgents().catch((e) => e);
    expect(err.message).not.toContain(KEY);
  });
});

describe('manus-client — Endpunktform laut Doku', () => {
  test('getAgent liefert den Main-Task des Agenten', async () => {
    const { c, aufrufe } = client([
      antwort(200, { ok: true, agent: { id: 'A1', task_id: 'T9', nickname: 'Hans' } }),
    ]);
    const agent = await c.getAgent('A1');
    expect(agent.task_id).toBe('T9');
    expect(aufrufe[0].url).toBe(`${MANUS_BASE_URL}/v2/agent.detail?agent_id=A1`);
  });

  test('Agent ohne task_id ist unbrauchbar und wird abgewiesen', async () => {
    const { c } = client([antwort(200, { ok: true, agent: { id: 'A1' } })]);
    const err = await c.getAgent('A1').catch((e) => e);
    expect(err.code).toBe('invalid_response');
  });

  test('listMessages setzt task_id, limit und order', async () => {
    const { c, aufrufe } = client([antwort(200, { ok: true, task_id: 'T1', messages: [], has_more: false })]);
    const res = await c.listMessages('T1', { limit: 50, order: 'desc' });
    expect(aufrufe[0].url).toBe(`${MANUS_BASE_URL}/v2/task.listMessages?task_id=T1&limit=50&order=desc`);
    expect(res.messages).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  test('getTask liest status und has_running_background_jobs', async () => {
    const { c, aufrufe } = client([antwort(200, {
      ok: true, task: { id: 'T1', status: 'stopped', has_running_background_jobs: true, task_type: 'standard' },
    })]);
    const t = await c.getTask('T1');
    expect(aufrufe[0].url).toBe(`${MANUS_BASE_URL}/v2/task.detail?task_id=T1`);
    expect(t.status).toBe('stopped');
    expect(t.hasRunningBackgroundJobs).toBe(true);
  });

  test('fehlt has_running_background_jobs, ist es null — nicht false', async () => {
    // Die Doku verlangt ausdruecklich, ein Fehlen nicht als false zu lesen.
    const { c } = client([antwort(200, { ok: true, task: { id: 'T1', status: 'stopped' } })]);
    const t = await c.getTask('T1');
    expect(t.hasRunningBackgroundJobs).toBeNull();
    expect(t.status).toBe('stopped');
  });

  test('getTask verkraftet eine Antwort ohne task-Feld', async () => {
    const { c } = client([antwort(200, { ok: true })]);
    const t = await c.getTask('T1');
    expect(t.id).toBe('T1');
    expect(t.status).toBeNull();
    expect(t.hasRunningBackgroundJobs).toBeNull();
  });

  test('listMessages verkraftet eine Antwort ohne messages-Feld', async () => {
    const { c } = client([antwort(200, { ok: true })]);
    const res = await c.listMessages('T1');
    expect(res.messages).toEqual([]);
    expect(res.taskId).toBe('T1');
  });
});

/**
 * cue-delegation — Konfiguration, Abschluss-Erkennung, Mutex und Meldewege.
 *
 * Alles mit injizierten Abhaengigkeiten; keine DB, kein Netz, keine Zeitgeber.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { cueStatus, cueStatusText, loadCueConfig } from '../config.js';
import {
  activeCueDelegation, evaluateEvents, initCueDelegation, resetCueState,
  shortTaskRef, startCueDelegation,
} from '../delegation.js';
import type { ManusClient, ManusTaskEvent } from '../manus-client.js';

// ── Konfiguration ──────────────────────────────────────────────────────────

describe('cue-config', () => {
  test('ohne Flag ist das Modul deaktiviert', () => {
    const s = cueStatus(loadCueConfig({} as NodeJS.ProcessEnv));
    expect(s.ready).toBe(false);
    expect(s.reason).toBe('disabled');
    expect(cueStatusText(s)).toContain('CUE_DELEGATION_ENABLED');
  });

  test('Flag an, aber Key fehlt', () => {
    const s = cueStatus(loadCueConfig({ CUE_DELEGATION_ENABLED: 'true' } as NodeJS.ProcessEnv));
    expect(s.reason).toBe('no_key');
    expect(s.missing).toEqual(['MANUS_API_KEY']);
  });

  test('Platzhalter gelten als nicht eingetragen', () => {
    const cfg = loadCueConfig({
      CUE_DELEGATION_ENABLED: 'true',
      MANUS_API_KEY: 'CHANGEME',
      MANUS_CUE_AGENT_ID: 'A1',
    } as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe('');
    expect(cueStatus(cfg).reason).toBe('no_key');
  });

  test('Key gesetzt, agent_id fehlt', () => {
    const s = cueStatus(loadCueConfig({
      CUE_DELEGATION_ENABLED: 'true', MANUS_API_KEY: 'k',
    } as NodeJS.ProcessEnv));
    expect(s.reason).toBe('no_agent');
  });

  test('vollstaendig konfiguriert ist einsatzbereit', () => {
    const s = cueStatus(loadCueConfig({
      CUE_DELEGATION_ENABLED: 'true', MANUS_API_KEY: 'k', MANUS_CUE_AGENT_ID: 'A1',
    } as NodeJS.ProcessEnv));
    expect(s.ready).toBe(true);
    expect(s.reason).toBe('ok');
  });

  test('ein anderer Wert als true schaltet nicht ein', () => {
    for (const v of ['false', '1', 'yes', 'TRUE ']) {
      const cfg = loadCueConfig({
        CUE_DELEGATION_ENABLED: v, MANUS_API_KEY: 'k', MANUS_CUE_AGENT_ID: 'A1',
      } as NodeJS.ProcessEnv);
      expect(cfg.enabled).toBe(v.trim().toLowerCase() === 'true');
    }
  });
});

// ── Abschluss-Erkennung ───────────────────────────────────────────────────

function ev(id: string, type: string, extra: Partial<ManusTaskEvent> = {}): ManusTaskEvent {
  return { id, type, ...extra };
}

/** Die API liefert order=desc, also neueste zuerst. */
function desc(...events: ManusTaskEvent[]): ManusTaskEvent[] {
  return [...events].reverse();
}

describe('evaluateEvents', () => {
  test('nur running bedeutet: noch nicht fertig', () => {
    const v = evaluateEvents(desc(ev('1', 'status_update', { status_update: { agent_status: 'running' } })), new Set());
    expect(v.outcome).toBeNull();
    expect(v.answers).toEqual([]);
  });

  test('stopped schliesst ab und liefert die Antworten chronologisch', () => {
    const v = evaluateEvents(desc(
      ev('1', 'assistant_message', { assistant_message: { content: 'erstens' } }),
      ev('2', 'assistant_message', { assistant_message: { content: 'zweitens' } }),
      ev('3', 'status_update', { status_update: { agent_status: 'stopped' } }),
    ), new Set());
    expect(v.outcome).toBe('ok');
    expect(v.answers).toEqual(['erstens', 'zweitens']);
  });

  test('bereits bekannte Ereignisse zaehlen nicht als Antwort', () => {
    const bekannt = new Set(['alt']);
    const v = evaluateEvents(desc(
      ev('alt', 'assistant_message', { assistant_message: { content: 'frueherer Verlauf' } }),
      ev('neu', 'assistant_message', { assistant_message: { content: 'unsere Antwort' } }),
      ev('end', 'status_update', { status_update: { agent_status: 'stopped' } }),
    ), bekannt);
    expect(v.answers).toEqual(['unsere Antwort']);
    expect(v.outcome).toBe('ok');
  });

  test('bearbeitete Ereignisse werden gemerkt und nicht doppelt gezaehlt', () => {
    const bekannt = new Set<string>();
    const events = desc(ev('1', 'assistant_message', { assistant_message: { content: 'a' } }));
    expect(evaluateEvents(events, bekannt).answers).toEqual(['a']);
    expect(evaluateEvents(events, bekannt).answers).toEqual([]);
  });

  test('error_message ergibt Fehler mit Text', () => {
    const v = evaluateEvents(desc(
      ev('1', 'error_message', { error_message: { error_type: 'tool', content: 'Browser abgestuerzt' } }),
    ), new Set());
    expect(v.outcome).toBe('error');
    expect(v.errorText).toBe('Browser abgestuerzt');
  });

  test('agent_status error ergibt Fehler', () => {
    const v = evaluateEvents(desc(
      ev('1', 'status_update', { status_update: { agent_status: 'error', description: 'Kontingent erschoepft' } }),
    ), new Set());
    expect(v.outcome).toBe('error');
    expect(v.errorText).toBe('Kontingent erschoepft');
  });

  test('waiting wird als Rueckfrage erkannt, nicht als Abschluss', () => {
    const v = evaluateEvents(desc(
      ev('1', 'assistant_message', { assistant_message: { content: 'Welches Baujahr?' } }),
      ev('2', 'status_update', {
        status_update: {
          agent_status: 'waiting',
          status_detail: { waiting_for_event_type: 'messageAskUser', waiting_description: 'Welches Baujahr?' },
        },
      }),
    ), new Set());
    expect(v.outcome).toBe('waiting');
    expect(v.waitingText).toBe('Welches Baujahr?');
  });

  test('leere assistant_message-Inhalte werden uebersprungen', () => {
    const v = evaluateEvents(desc(
      ev('1', 'assistant_message', { assistant_message: { content: '   ' } }),
      ev('2', 'status_update', { status_update: { agent_status: 'stopped' } }),
    ), new Set());
    expect(v.outcome).toBe('ok');
    expect(v.answers).toEqual([]);
  });

  test('shortTaskRef kuerzt lange IDs und laesst kurze unberuehrt', () => {
    expect(shortTaskRef('kurz')).toBe('kurz');
    expect(shortTaskRef('abcdefghijklmnopqrst')).toBe('abcdefgh…qrst');
  });
});

// ── Delegation: Ablauf, Mutex, Meldewege ──────────────────────────────────

interface Protokoll {
  telegram: string[];
  audit: Array<{ action: string; after: Record<string, unknown> }>;
  gesendet: Array<{ taskId: string; text: string }>;
  fehler: string[];
}

function bauAufbau(opts: {
  seiten?: ManusTaskEvent[][];
  env?: Record<string, string>;
  sendFehler?: Error;
  parken?: boolean;
}) {
  const p: Protokoll = { telegram: [], audit: [], gesendet: [], fehler: [] };
  const seiten = opts.seiten ?? [];
  let abfrage = -1; // erster Aufruf ist der Anker

  const client: ManusClient = {
    getAgent: async (agentId) => ({ id: agentId, task_id: 'TASK-123456789012', nickname: 'Hans' }),
    listAgents: async () => [{ id: 'A1', task_id: 'T1', nickname: 'Hans' }],
    sendMessage: async (taskId, text) => {
      if (opts.sendFehler) throw opts.sendFehler;
      p.gesendet.push({ taskId, text });
      return { taskId, requestId: 'req_x' };
    },
    listMessages: async () => {
      const seite = abfrage < 0 ? [] : (seiten[abfrage] ?? []);
      abfrage++;
      return { taskId: 'TASK-123456789012', messages: seite, hasMore: false, nextCursor: null };
    },
  };

  initCueDelegation({
    notifyOperativ: async (t) => { p.telegram.push(t); return true; },
    logger: {
      info: () => {}, warn: () => {},
      error: (m) => { p.fehler.push(m); },
    },
    auditLog: async (e) => { p.audit.push({ action: e.action, after: e.after ?? {} }); },
    createClient: () => client,
    // Geparkt: die Wartezeit loest nie auf — der Hintergrundlauf bleibt stehen
    // und haelt den Mutex, so wird "genau einer gleichzeitig" pruefbar.
    sleepImpl: opts.parken ? () => new Promise<void>(() => {}) : async () => {},
    now: () => 1_000,
    pollIntervalMs: 0,
    maxRuntimeMs: 60_000,
    env: {
      CUE_DELEGATION_ENABLED: 'true',
      MANUS_API_KEY: 'test-key',
      MANUS_CUE_AGENT_ID: 'A1',
      ...(opts.env ?? {}),
    } as NodeJS.ProcessEnv,
  });

  return p;
}

/** Hintergrundlauf (Mikrotask-Kette) zu Ende laufen lassen. */
async function abwarten(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('startCueDelegation', () => {
  beforeEach(() => { resetCueState(); });

  test('ohne Konfiguration: sauberer deaktiviert-Pfad, kein externer Aufruf', async () => {
    const p = bauAufbau({ env: { CUE_DELEGATION_ENABLED: 'false' } });
    const res = await startCueDelegation('egal');
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('disabled');
    expect(res.message).toContain('deaktiviert');
    expect(p.gesendet).toEqual([]);
    expect(p.audit).toEqual([]);
    expect(activeCueDelegation()).toBeNull();
  });

  test('sendet ausschliesslich den getippten Text und quittiert mit Task-Referenz', async () => {
    const p = bauAufbau({
      seiten: [[{ id: 's', type: 'status_update', status_update: { agent_status: 'stopped' } }]],
    });
    const res = await startCueDelegation('Nenne drei Primaerquellen');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('An Cue uebergeben');
    expect(res.message).toContain('TASK-123…9012');
    expect(p.gesendet).toEqual([{ taskId: 'TASK-123456789012', text: 'Nenne drei Primaerquellen' }]);
    await abwarten();
    expect(p.audit[0].action).toBe('cue.delegation.sent');
    expect(p.audit[0].after.notes).toBe('Nenne drei Primaerquellen');
  });

  test('Ergebnis wird als eigene Telegram-Nachricht nachgeliefert', async () => {
    const p = bauAufbau({
      seiten: [[
        { id: 'b', type: 'status_update', status_update: { agent_status: 'stopped' } },
        { id: 'a', type: 'assistant_message', assistant_message: { content: 'Drei Quellen: …' } },
      ]],
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram.length).toBe(1);
    expect(p.telegram[0]).toContain('Cue-Ergebnis');
    expect(p.telegram[0]).toContain('Drei Quellen: …');
    const fertig = p.audit.find((a) => a.action === 'cue.delegation.finished');
    expect(fertig?.after.status).toBe('ok');
    expect(activeCueDelegation()).toBeNull();
  });

  test('Fehler des Agenten endet mit klarer Meldung, nicht mit Stille', async () => {
    const p = bauAufbau({
      seiten: [[{ id: 'e', type: 'error_message', error_message: { content: 'Quelle nicht erreichbar' } }]],
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram[0]).toContain('Cue-Fehler');
    expect(p.telegram[0]).toContain('Quelle nicht erreichbar');
    expect(p.audit.find((a) => a.action === 'cue.delegation.finished')?.after.status).toBe('error');
  });

  test('Rueckfrage des Agenten wird gemeldet und beendet Phase 1', async () => {
    const p = bauAufbau({
      seiten: [[{
        id: 'w', type: 'status_update',
        status_update: { agent_status: 'waiting', status_detail: { waiting_description: 'Welches Baujahr?' } },
      }]],
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram[0]).toContain('Cue fragt zurueck');
    expect(p.telegram[0]).toContain('antwortet nicht automatisch');
    expect(p.audit.find((a) => a.action === 'cue.delegation.finished')?.after.status).toBe('waiting');
  });

  test('Laufzeitgrenze endet im Timeout mit Meldung', async () => {
    // now() ist konstant 1000, maxRuntimeMs 0 → Schleife laeuft nicht an.
    const p = bauAufbau({ seiten: [] });
    initCueDelegation({
      notifyOperativ: async (t) => { p.telegram.push(t); return true; },
      logger: { info: () => {}, warn: () => {}, error: (m) => { p.fehler.push(m); } },
      auditLog: async (e) => { p.audit.push({ action: e.action, after: e.after ?? {} }); },
      createClient: () => ({
        getAgent: async (id) => ({ id, task_id: 'T-TIMEOUT' }),
        listAgents: async () => [],
        sendMessage: async (taskId, text) => { p.gesendet.push({ taskId, text }); return { taskId, requestId: null }; },
        listMessages: async () => ({ taskId: 'T-TIMEOUT', messages: [], hasMore: false, nextCursor: null }),
      }),
      sleepImpl: async () => {},
      now: () => 1_000,
      maxRuntimeMs: 0,
      env: {
        CUE_DELEGATION_ENABLED: 'true', MANUS_API_KEY: 'k', MANUS_CUE_AGENT_ID: 'A1',
      } as NodeJS.ProcessEnv,
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram[0]).toContain('Cue-Timeout');
    expect(p.audit.find((a) => a.action === 'cue.delegation.finished')?.after.status).toBe('timeout');
  });

  test('fehlgeschlagene Uebergabe gibt den Mutex sofort frei', async () => {
    const p = bauAufbau({ sendFehler: new Error('Netz weg') });
    const res = await startCueDelegation('Frage');
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('error');
    expect(res.message).toContain('Netz weg');
    expect(activeCueDelegation()).toBeNull();
    expect(p.audit[0].action).toBe('cue.delegation.finished');
    expect(p.audit[0].after.status).toBe('error');
  });

  test('genau ein Auftrag gleichzeitig — der zweite wird abgewiesen', async () => {
    bauAufbau({ parken: true });
    const erster = await startCueDelegation('Auftrag A');
    expect(erster.ok).toBe(true);
    expect(activeCueDelegation()).not.toBeNull();

    const zweiter = await startCueDelegation('Auftrag B');
    expect(zweiter.ok).toBe(false);
    expect(zweiter.kind).toBe('busy');
    expect(zweiter.message).toContain('bereits ein Cue-Auftrag');
    resetCueState();
  });

  test('ein fehlgeschlagener audit_log-Eintrag bricht die Delegation nicht ab', async () => {
    const telegram: string[] = [];
    const fehler: string[] = [];
    initCueDelegation({
      notifyOperativ: async (t) => { telegram.push(t); return true; },
      logger: { info: () => {}, warn: () => {}, error: (m) => { fehler.push(m); } },
      auditLog: async () => { throw new Error('DB weg'); },
      createClient: () => {
        // Erster Aufruf ist der Anker (leer), ab dem zweiten liegt der Abschluss vor.
        let aufruf = 0;
        return {
          getAgent: async (id) => ({ id, task_id: 'T-AUDIT' }),
          listAgents: async () => [],
          sendMessage: async (taskId) => ({ taskId, requestId: null }),
          listMessages: async () => ({
            taskId: 'T-AUDIT',
            messages: aufruf++ === 0
              ? []
              : [{ id: 'x', type: 'status_update', status_update: { agent_status: 'stopped' as const } }],
            hasMore: false, nextCursor: null,
          }),
        };
      },
      sleepImpl: async () => {},
      now: () => 1_000,
      maxRuntimeMs: 60_000,
      env: {
        CUE_DELEGATION_ENABLED: 'true', MANUS_API_KEY: 'k', MANUS_CUE_AGENT_ID: 'A1',
      } as NodeJS.ProcessEnv,
    });
    const res = await startCueDelegation('Frage');
    expect(res.ok).toBe(true);
    await abwarten();
    expect(telegram.length).toBe(1);
    expect(fehler.some((m) => m.includes('audit_log'))).toBe(true);
  });
});

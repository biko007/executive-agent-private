/**
 * cue-delegation — Konfiguration, Abschluss-Erkennung, Mutex und Meldewege.
 *
 * Alles mit injizierten Abhaengigkeiten; keine DB, kein Netz, keine echten
 * Zeitgeber. Die Uhr laeuft mit der Wartezeit mit, damit die
 * Bestaetigungsfenster und der Laufzeitdeckel pruefbar sind.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { cueStatus, cueStatusText, loadCueConfig } from '../config.js';
import {
  activeCueDelegation, agentLabel, evaluateEvents, initCueDelegation, resetCueState,
  shortTaskRef, startCueDelegation,
} from '../delegation.js';
import { ManusError } from '../manus-client.js';
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

// ── Ereignisauswertung ────────────────────────────────────────────────────

function ev(id: string, type: string, extra: Partial<ManusTaskEvent> = {}): ManusTaskEvent {
  return { id, type, ...extra };
}
function status(id: string, agent_status: 'running' | 'stopped' | 'waiting' | 'error', rest: Record<string, unknown> = {}) {
  return ev(id, 'status_update', { status_update: { agent_status, ...rest } });
}
function antwort(id: string, content: string) {
  return ev(id, 'assistant_message', { assistant_message: { content } });
}

/** Die API liefert order=desc, also neueste zuerst. */
function desc(...events: ManusTaskEvent[]): ManusTaskEvent[] {
  return [...events].reverse();
}

describe('evaluateEvents', () => {
  test('nur running bedeutet: noch nicht fertig', () => {
    const v = evaluateEvents(desc(status('1', 'running')), new Set());
    expect(v.outcome).toBeNull();
    expect(v.answers).toEqual([]);
    expect(v.lastStatus).toBe('running');
  });

  test('stopped setzt den Kandidaten und liefert die Antworten chronologisch', () => {
    const v = evaluateEvents(desc(
      antwort('1', 'erstens'), antwort('2', 'zweitens'), status('3', 'stopped'),
    ), new Set());
    expect(v.outcome).toBe('ok');
    expect(v.answers).toEqual(['erstens', 'zweitens']);
    expect(v.lastStatus).toBe('stopped');
    expect(v.newEventCount).toBe(3);
  });

  test('stopped gefolgt von running: lastStatus ist running', () => {
    // Genau dieser Stapel darf nicht als Abschluss gelten.
    const v = evaluateEvents(desc(status('1', 'stopped'), status('2', 'running')), new Set());
    expect(v.outcome).toBe('ok');
    expect(v.lastStatus).toBe('running');
  });

  test('bereits bekannte Ereignisse zaehlen nicht als Antwort', () => {
    const bekannt = new Set(['alt']);
    const v = evaluateEvents(desc(
      antwort('alt', 'frueherer Verlauf'), antwort('neu', 'unsere Antwort'), status('end', 'stopped'),
    ), bekannt);
    expect(v.answers).toEqual(['unsere Antwort']);
    expect(v.newEventCount).toBe(2);
  });

  test('bearbeitete Ereignisse werden gemerkt und nicht doppelt gezaehlt', () => {
    const bekannt = new Set<string>();
    const events = desc(antwort('1', 'a'));
    expect(evaluateEvents(events, bekannt).answers).toEqual(['a']);
    const zweiter = evaluateEvents(events, bekannt);
    expect(zweiter.answers).toEqual([]);
    expect(zweiter.newEventCount).toBe(0);
  });

  test('error_message ergibt Fehler mit Text', () => {
    const v = evaluateEvents(desc(
      ev('1', 'error_message', { error_message: { error_type: 'tool', content: 'Browser abgestuerzt' } }),
    ), new Set());
    expect(v.outcome).toBe('error');
    expect(v.errorText).toBe('Browser abgestuerzt');
  });

  test('agent_status error ergibt Fehler', () => {
    const v = evaluateEvents(desc(status('1', 'error', { description: 'Kontingent erschoepft' })), new Set());
    expect(v.outcome).toBe('error');
    expect(v.errorText).toBe('Kontingent erschoepft');
  });

  test('waiting wird als Rueckfrage erkannt, nicht als Abschluss', () => {
    const v = evaluateEvents(desc(
      antwort('1', 'Welches Baujahr?'),
      status('2', 'waiting', {
        status_detail: { waiting_for_event_type: 'messageAskUser', waiting_description: 'Welches Baujahr?' },
      }),
    ), new Set());
    expect(v.outcome).toBe('waiting');
    expect(v.waitingText).toBe('Welches Baujahr?');
  });

  test('leere assistant_message-Inhalte werden uebersprungen', () => {
    const v = evaluateEvents(desc(antwort('1', '   '), status('2', 'stopped')), new Set());
    expect(v.outcome).toBe('ok');
    expect(v.answers).toEqual([]);
  });

  test('agentLabel stellt immer "Agent" voran', () => {
    expect(agentLabel('Hans')).toBe('Agent Hans');
    expect(agentLabel('  Hans  ')).toBe('Agent Hans');
    // Ohne Namen bleibt der neutrale Ersatz.
    expect(agentLabel('')).toBe('Agent Cue');
    expect(agentLabel('   ')).toBe('Agent Cue');
    expect(agentLabel(null)).toBe('Agent Cue');
    expect(agentLabel(undefined)).toBe('Agent Cue');
  });

  test('shortTaskRef kuerzt lange IDs und laesst kurze unberuehrt', () => {
    expect(shortTaskRef('kurz')).toBe('kurz');
    expect(shortTaskRef('abcdefghijklmnopqrst')).toBe('abcdefgh…qrst');
  });
});

// ── Delegation: Ablauf, Haertung, Mutex, Meldewege ────────────────────────

const TASK = 'TASK-123456789012';

/** Hintergrundarbeit je getTask-Aufruf: true/false/null oder Fehler. */
type BgWert = boolean | null | 'throw';

interface Protokoll {
  telegram: string[];
  audit: Array<{ action: string; after: Record<string, unknown> }>;
  gesendet: Array<{ taskId: string; text: string }>;
  fehler: string[];
  getTaskAufrufe: number;
  uhr: { ms: number };
}

function bauAufbau(opts: {
  /** Eine Seite je Abfrage (order=desc). Der erste Aufruf ist der Anker. */
  seiten?: ManusTaskEvent[][];
  bg?: BgWert[];
  env?: Record<string, string>;
  sendFehler?: Error;
  parken?: boolean;
  nickname?: string;
  pollIntervalMs?: number;
  confirmWindowMs?: number;
  unknownConfirmWindowMs?: number;
  maxRuntimeMs?: number;
}): Protokoll {
  const p: Protokoll = {
    telegram: [], audit: [], gesendet: [], fehler: [], getTaskAufrufe: 0, uhr: { ms: 1_000 },
  };
  const seiten = opts.seiten ?? [];
  const bg = opts.bg ?? [false];
  let abfrage = -1; // erster Aufruf ist der Anker

  const client: ManusClient = {
    getAgent: async (agentId) => ({ id: agentId, task_id: TASK, nickname: opts.nickname ?? 'Hans' }),
    listAgents: async () => [{ id: 'A1', task_id: TASK, nickname: 'Hans' }],
    getTask: async (taskId) => {
      const wert = bg[Math.min(p.getTaskAufrufe, bg.length - 1)];
      p.getTaskAufrufe++;
      if (wert === 'throw') throw new ManusError('rate_limited', 'Rate limit exceeded');
      return { id: taskId, status: 'stopped', hasRunningBackgroundJobs: wert, taskType: 'standard', title: null };
    },
    sendMessage: async (taskId, text) => {
      if (opts.sendFehler) throw opts.sendFehler;
      p.gesendet.push({ taskId, text });
      return { taskId, requestId: 'req_x' };
    },
    listMessages: async () => {
      const seite = abfrage < 0 ? [] : (seiten[abfrage] ?? []);
      abfrage++;
      return { taskId: TASK, messages: seite, hasMore: false, nextCursor: null };
    },
  };

  initCueDelegation({
    notifyOperativ: async (t) => { p.telegram.push(t); return true; },
    logger: { info: () => {}, warn: () => {}, error: (m) => { p.fehler.push(m); } },
    auditLog: async (e) => { p.audit.push({ action: e.action, after: e.after ?? {} }); },
    createClient: () => client,
    // Geparkt: die Wartezeit loest nie auf — der Hintergrundlauf bleibt stehen
    // und haelt den Mutex, so wird "genau einer gleichzeitig" pruefbar.
    sleepImpl: opts.parken
      ? () => new Promise<void>(() => {})
      : async (ms) => { p.uhr.ms += ms; },
    now: () => p.uhr.ms,
    pollIntervalMs: opts.pollIntervalMs ?? 15_000,
    confirmWindowMs: opts.confirmWindowMs ?? 0,
    unknownConfirmWindowMs: opts.unknownConfirmWindowMs ?? 0,
    maxRuntimeMs: opts.maxRuntimeMs ?? 15 * 60_000,
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
  for (let i = 0; i < 2_000; i++) await Promise.resolve();
}

function fertig(p: Protokoll) {
  return p.audit.find((a) => a.action === 'cue.delegation.finished');
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

  test('Quittung nennt den Agentennamen, nicht die Task-ID', async () => {
    const p = bauAufbau({ seiten: [desc(status('s', 'stopped'))] });
    const res = await startCueDelegation('Nenne drei Primaerquellen');
    expect(res.ok).toBe(true);
    expect(res.message).toBe('An Agent Hans uebergeben — Ergebnis folgt als eigene Nachricht.');
    expect(res.message).not.toContain(TASK);
    expect(res.agentName).toBe('Hans');
    expect(p.gesendet).toEqual([{ taskId: TASK, text: 'Nenne drei Primaerquellen' }]);
    await abwarten();
    // Die Task-ID bleibt im audit_log erhalten.
    expect(p.audit[0].action).toBe('cue.delegation.sent');
    expect(p.audit[0].after.notes).toBe('Nenne drei Primaerquellen');
    // Im audit_log bleibt der rohe Name stehen, nicht das Anzeigelabel.
    expect(p.audit[0].after.label).toBe('Hans');
  });

  test('Ergebnis-Nachricht nennt den Agentennamen und keine Task-ID', async () => {
    const p = bauAufbau({
      seiten: [desc(antwort('a', 'Drei Quellen: …'), status('b', 'stopped'))],
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram.length).toBe(1);
    expect(p.telegram[0]).toBe('Ergebnis von Agent Hans:\n\nDrei Quellen: …');
    expect(p.telegram[0]).not.toContain(TASK);
    expect(fertig(p)?.after.status).toBe('ok');
    expect(activeCueDelegation()).toBeNull();
  });

  test('ohne aufgeloesten Namen bleibt ein neutraler Ersatz stehen', async () => {
    const p = bauAufbau({ nickname: '  ', seiten: [desc(status('s', 'stopped'))] });
    const res = await startCueDelegation('Frage');
    expect(res.message).toBe('An Agent Cue uebergeben — Ergebnis folgt als eigene Nachricht.');
    await abwarten();
    expect(p.telegram[0]).toContain('Agent Cue hat den Auftrag beendet');
  });

  // ── Haertung der Abschluss-Erkennung ────────────────────────────────────

  test('stopped mit laufender Hintergrundarbeit schliesst NICHT ab', async () => {
    // Genau der Live-Fall vom 08.10.2026, 09:13: Eroeffnungssatz, stopped,
    // 7,5 Minuten Pause, dann das echte Ergebnis.
    const p = bauAufbau({
      seiten: [
        desc(antwort('a1', 'Ich recherchiere drei Angebote …'), status('s1', 'stopped')),
        [],
        desc(status('r1', 'running'), antwort('a2', 'Das echte Ergebnis'), status('s2', 'stopped')),
      ],
      // Erster stopped: Hintergrundarbeit laeuft → verworfen.
      // Zweiter stopped: keine Arbeit mehr → Abschluss.
      bg: [true, false],
      confirmWindowMs: 0,
    });
    await startCueDelegation('Frage');
    await abwarten();

    expect(p.telegram.length).toBe(1);
    expect(p.telegram[0]).toContain('Ergebnis von Agent Hans:');
    expect(p.telegram[0]).toContain('Ich recherchiere drei Angebote …');
    expect(p.telegram[0]).toContain('Das echte Ergebnis');
    expect(fertig(p)?.after.status).toBe('ok');
    // Mindestens ein stopped wurde verworfen.
    expect(Number(fertig(p)?.after.discarded_stops)).toBeGreaterThan(0);
  });

  test('stopped ohne Hintergrundarbeit schliesst nach dem Bestaetigungsfenster ab', async () => {
    const p = bauAufbau({
      seiten: [desc(antwort('a1', 'Fertige Antwort'), status('s1', 'stopped')), [], []],
      bg: [false],
      pollIntervalMs: 15_000,
      confirmWindowMs: 30_000,
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram[0]).toContain('Fertige Antwort');
    // Start 1000, erste Abfrage 16000, Fenster 30 s → Abschluss ab 46000.
    expect(Number(fertig(p)?.after.duration_ms)).toBeGreaterThanOrEqual(45_000);
  });

  test('kehrt der Agent auf running zurueck, wird der Kandidat verworfen', async () => {
    const p = bauAufbau({
      seiten: [
        desc(antwort('a1', 'Eroeffnung'), status('s1', 'stopped')),
        desc(status('r1', 'running')),
        desc(antwort('a2', 'Echtes Ergebnis'), status('s2', 'stopped')),
        [], [],
      ],
      bg: [false],
      pollIntervalMs: 15_000,
      confirmWindowMs: 30_000,
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram[0]).toContain('Eroeffnung');
    expect(p.telegram[0]).toContain('Echtes Ergebnis');
  });

  test('unbekannte Hintergrundarbeit wartet laenger als der bestaetigte Fall', async () => {
    // task.detail nicht lesbar → laut Doku nicht wie "keine Arbeit" behandeln.
    const p = bauAufbau({
      seiten: [desc(antwort('a1', 'Antwort'), status('s1', 'stopped'))],
      bg: ['throw'],
      pollIntervalMs: 15_000,
      confirmWindowMs: 0,
      unknownConfirmWindowMs: 60_000,
      maxRuntimeMs: 10 * 60_000,
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram[0]).toContain('Antwort');
    // Erste Abfrage 16000 + 60 s Fenster → nicht vor 76000.
    expect(Number(fertig(p)?.after.duration_ms)).toBeGreaterThanOrEqual(75_000);
    expect(p.getTaskAufrufe).toBeGreaterThan(1);
  });

  test('fehlendes Feld gilt nicht als "keine Hintergrundarbeit"', async () => {
    const p = bauAufbau({
      seiten: [desc(antwort('a1', 'Antwort'), status('s1', 'stopped'))],
      bg: [null],
      pollIntervalMs: 15_000,
      confirmWindowMs: 0,
      unknownConfirmWindowMs: 45_000,
      maxRuntimeMs: 10 * 60_000,
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(Number(fertig(p)?.after.duration_ms)).toBeGreaterThanOrEqual(45_000);
  });

  test('der Laufzeitdeckel greift auch bei dauerhafter Hintergrundarbeit', async () => {
    const p = bauAufbau({
      seiten: [desc(antwort('a1', 'Zwischenstand'), status('s1', 'stopped'))],
      bg: [true],
      pollIntervalMs: 15_000,
      maxRuntimeMs: 60_000,
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram.length).toBe(1);
    expect(p.telegram[0]).toContain('Zeitueberschreitung bei Agent Hans');
    expect(p.telegram[0]).toContain('Zwischenstand');
    expect(fertig(p)?.after.status).toBe('timeout');
    expect(activeCueDelegation()).toBeNull();
  });

  // ── Fehler- und Rueckfragepfade bleiben unveraendert ────────────────────

  test('Fehler des Agenten endet sofort mit klarer Meldung', async () => {
    const p = bauAufbau({
      seiten: [desc(ev('e', 'error_message', { error_message: { content: 'Quelle nicht erreichbar' } }))],
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram[0]).toBe('Agent Hans meldet einen Fehler: Quelle nicht erreichbar');
    expect(fertig(p)?.after.status).toBe('error');
    // Kein task.detail noetig — Fehler schliessen unmittelbar ab.
    expect(p.getTaskAufrufe).toBe(0);
  });

  test('Rueckfrage des Agenten wird gemeldet und beendet Phase 1', async () => {
    const p = bauAufbau({
      seiten: [desc(status('w', 'waiting', { status_detail: { waiting_description: 'Welches Baujahr?' } }))],
    });
    await startCueDelegation('Frage');
    await abwarten();
    expect(p.telegram[0]).toContain('Agent Hans fragt zurueck:');
    expect(p.telegram[0]).toContain('antwortet nicht automatisch');
    expect(fertig(p)?.after.status).toBe('waiting');
    expect(p.getTaskAufrufe).toBe(0);
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
    expect(zweiter.message).toContain('bereits ein Auftrag bei Agent Hans');
    resetCueState();
  });

  test('ein fehlgeschlagener audit_log-Eintrag bricht die Delegation nicht ab', async () => {
    const telegram: string[] = [];
    const fehler: string[] = [];
    const uhr = { ms: 1_000 };
    let abfrage = -1;
    initCueDelegation({
      notifyOperativ: async (t) => { telegram.push(t); return true; },
      logger: { info: () => {}, warn: () => {}, error: (m) => { fehler.push(m); } },
      auditLog: async () => { throw new Error('DB weg'); },
      createClient: () => ({
        getAgent: async (id) => ({ id, task_id: 'T-AUDIT', nickname: 'Hans' }),
        listAgents: async () => [],
        getTask: async (taskId) => ({
          id: taskId, status: 'stopped' as const, hasRunningBackgroundJobs: false,
          taskType: 'standard', title: null,
        }),
        sendMessage: async (taskId) => ({ taskId, requestId: null }),
        listMessages: async () => {
          const seite = abfrage < 0 ? [] : desc(status('x', 'stopped'));
          abfrage++;
          return { taskId: 'T-AUDIT', messages: seite, hasMore: false, nextCursor: null };
        },
      }),
      sleepImpl: async (ms) => { uhr.ms += ms; },
      now: () => uhr.ms,
      pollIntervalMs: 15_000,
      confirmWindowMs: 0,
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

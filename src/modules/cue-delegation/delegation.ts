/**
 * cue-delegation/delegation — Ablaufsteuerung einer einzelnen Cue-Delegation.
 *
 * Phase 1 (Machbarkeitstest, Owner-Auftrag 08.10.2026): der Owner tippt
 * `/cue <text>`, genau dieser Text geht an den Main-Task des konfigurierten
 * Manus-Agenten, die Antwort kommt als Telegram-Nachricht zurueck. Nichts
 * anderes wird gesendet — keine Kontexte, kein Verlauf, keine internen Daten.
 *
 * Abschluss-Erkennung laut verifizierter Doku
 * (https://open.manus.ai/docs/v2/task.listMessages, openapi_v2.json):
 *   status_update.agent_status === 'stopped'  → fertig
 *   status_update.agent_status === 'error'    → Fehlerzustand
 *   status_update.agent_status === 'waiting'  → Agent braucht eine Antwort
 *   error_message                             → Fehler im Auftrag
 *
 * Neue Ereignisse werden ueber ihre Event-ID erkannt, nicht ueber Zeitstempel:
 * vor dem Senden wird einmal der aktuelle Stand gelesen und die bekannten IDs
 * gemerkt. Damit ist das Verfahren unabhaengig von einer Uhr-Abweichung
 * zwischen VPS und Manus.
 *
 * Genau eine Delegation darf gleichzeitig laufen (einfacher Mutex auf
 * globalThis, multi-load-sicher wie der uebrige Shared State in index.ts).
 * Der Zustand lebt nur im Prozess: ein Gateway-Restart beendet einen laufenden
 * Auftrag ohne Ergebnis. Fuer einen Machbarkeitstest bewusst akzeptiert.
 */
import { createManusClient, ManusError } from './manus-client.js';
import type { ManusClient, ManusTaskEvent } from './manus-client.js';
import { cueStatus, cueStatusText, loadCueConfig } from './config.js';
import type { CueConfig } from './config.js';
import { sleep } from '../../shared/utils/index.js';

/** Standard-Abfragetakt. 15 s liegt weit unter dem Leselimit von 100/min. */
const DEFAULT_POLL_INTERVAL_MS = 15_000;
/** Harte Obergrenze je Auftrag. */
const DEFAULT_MAX_RUNTIME_MS = 15 * 60_000;
/** Telegram erlaubt 4096 Zeichen; Rest ist Platz fuer die Kopfzeile. */
const MAX_RESULT_CHARS = 3_500;
/** Obergrenze fuer den im audit_log festgehaltenen Prompt-Text. */
const MAX_AUDIT_PROMPT_CHARS = 2_000;

export type CueOutcome = 'ok' | 'waiting' | 'error' | 'timeout';

export interface CueAuditEntry {
  module: string;
  action: string;
  entityType?: string;
  entityId?: string;
  after?: Record<string, unknown>;
  source?: string;
}

export interface CueDelegationDeps {
  /** Nachricht in den operativen Telegram-Chat. */
  notifyOperativ: (text: string) => Promise<boolean>;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /** Schreibt in audit_log (src/shared/audit). */
  auditLog: (entry: CueAuditEntry) => Promise<void>;
  /** Nur fuer Tests: Client-Fabrik, Wartezeit, Uhr und Takt ersetzen. */
  createClient?: (cfg: CueConfig) => ManusClient;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  maxRuntimeMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface ActiveDelegation {
  startedAtMs: number;
  startedAtIso: string;
  taskId: string | null;
}

let deps: CueDelegationDeps | null = null;

export function initCueDelegation(d: CueDelegationDeps): void {
  deps = d;
}

function requireDeps(): CueDelegationDeps {
  if (!deps) throw new Error('cue_delegation_not_initialized');
  return deps;
}

// ── Prozessweiter Zustand (multi-load-sicher) ──────────────────────────────

interface CueGlobals {
  __ea_cueActive?: ActiveDelegation | null;
  __ea_cueTaskIdByAgent?: Record<string, string>;
}

function globals(): CueGlobals {
  const g = globalThis as unknown as CueGlobals;
  g.__ea_cueActive ??= null;
  g.__ea_cueTaskIdByAgent ??= {};
  return g;
}

/** Laufender Auftrag oder null. */
export function activeCueDelegation(): ActiveDelegation | null {
  return globals().__ea_cueActive ?? null;
}

/** Nur fuer Tests: Zustand zuruecksetzen. */
export function resetCueState(): void {
  const g = globals();
  g.__ea_cueActive = null;
  g.__ea_cueTaskIdByAgent = {};
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────

/** Kurzform der Task-ID fuer owner-sichtbare Meldungen. */
export function shortTaskRef(taskId: string): string {
  return taskId.length > 12 ? `${taskId.slice(0, 8)}…${taskId.slice(-4)}` : taskId;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (gekuerzt)` : text;
}

export interface CueStartResult {
  ok: boolean;
  kind: 'started' | 'disabled' | 'busy' | 'error';
  message: string;
  taskId?: string;
}

/**
 * Eine Delegation starten. Kehrt zurueck, sobald der Text uebergeben ist —
 * das Einsammeln der Antwort laeuft danach im Hintergrund weiter.
 */
export async function startCueDelegation(text: string): Promise<CueStartResult> {
  const d = requireDeps();
  const cfg = loadCueConfig(d.env ?? process.env);
  const status = cueStatus(cfg);
  if (!status.ready) {
    return { ok: false, kind: 'disabled', message: cueStatusText(status) };
  }

  const g = globals();
  const running = g.__ea_cueActive;
  if (running) {
    return {
      ok: false,
      kind: 'busy',
      message:
        `Es laeuft bereits ein Cue-Auftrag (seit ${running.startedAtIso}` +
        `${running.taskId ? `, Task ${shortTaskRef(running.taskId)}` : ''}). ` +
        'Phase 1 erlaubt genau einen gleichzeitig — bitte Ergebnis abwarten.',
    };
  }

  const nowMs = (d.now ?? Date.now)();
  const active: ActiveDelegation = {
    startedAtMs: nowMs,
    startedAtIso: new Date(nowMs).toISOString(),
    taskId: null,
  };
  g.__ea_cueActive = active;

  try {
    const client = (d.createClient ?? defaultClientFactory)(cfg);

    // 1. Main-Task des Agenten bestimmen (nach erstem Erfolg im Prozess gemerkt).
    let taskId = g.__ea_cueTaskIdByAgent![cfg.agentId];
    if (!taskId) {
      const agent = await client.getAgent(cfg.agentId);
      taskId = agent.task_id;
      g.__ea_cueTaskIdByAgent![cfg.agentId] = taskId;
    }
    active.taskId = taskId;

    // 2. Anker: alles, was jetzt schon im Strang steht, ist nicht unsere Antwort.
    const anchor = await client.listMessages(taskId, { limit: 50, order: 'desc' });
    const known = new Set(anchor.messages.map((m) => m.id));

    // 3. Ausschliesslich den getippten Text uebergeben.
    await client.sendMessage(taskId, text);

    d.logger.info(`[cue] Delegation gestartet (Task ${shortTaskRef(taskId)}, ${text.length} Zeichen)`);
    void writeAudit(d, 'cue.delegation.sent', taskId, {
      // `notes` ist im Audit-Whitelist-Filter freigegeben, damit der Prompt des
      // Owners lesbar erhalten bleibt (src/shared/audit/index.ts).
      notes: cut(text, MAX_AUDIT_PROMPT_CHARS),
      prompt_chars: text.length,
    });

    // 4. Antwort im Hintergrund einsammeln. Fehler landen in Telegram, nie im Aufrufer.
    void collectResult(d, client, taskId, known, active).catch((e: any) => {
      d.logger.error(`[cue] Hintergrundlauf abgebrochen: ${e?.message}`);
      globals().__ea_cueActive = null;
    });

    return {
      ok: true,
      kind: 'started',
      taskId,
      message: `An Cue uebergeben (Task ${shortTaskRef(taskId)}). Ergebnis kommt als eigene Nachricht.`,
    };
  } catch (e: any) {
    g.__ea_cueActive = null;
    const msg = describeError(e);
    d.logger.error(`[cue] Uebergabe fehlgeschlagen: ${msg}`);
    await writeAudit(d, 'cue.delegation.finished', active.taskId ?? 'unknown', {
      status: 'error',
      notes: cut(text, MAX_AUDIT_PROMPT_CHARS),
      prompt_chars: text.length,
      label: msg,
    });
    return { ok: false, kind: 'error', message: `Cue-Uebergabe fehlgeschlagen: ${msg}` };
  }
}

function defaultClientFactory(cfg: CueConfig): ManusClient {
  return createManusClient({ apiKey: cfg.apiKey });
}

/** Fehlertext fuer den Owner — mit Fehlercode, ohne Key-Material. */
export function describeError(e: unknown): string {
  if (e instanceof ManusError) {
    const rid = e.requestId ? `, request ${e.requestId}` : '';
    return `${e.code}${rid}: ${e.message}`;
  }
  return String((e as any)?.message ?? e);
}

async function writeAudit(
  d: CueDelegationDeps,
  action: string,
  taskId: string,
  after: Record<string, unknown>,
): Promise<void> {
  try {
    await d.auditLog({
      module: 'cue-delegation',
      action,
      entityType: 'cue_task',
      entityId: taskId,
      after,
      source: 'telegram',
    });
  } catch (e: any) {
    // Ein fehlgeschlagener Audit-Schreibvorgang darf die Delegation nicht
    // abbrechen — er wird aber sichtbar protokolliert.
    d.logger.error(`[cue] audit_log-Eintrag fehlgeschlagen (${action}): ${e?.message}`);
  }
}

interface PollVerdict {
  outcome: CueOutcome | null;
  answers: string[];
  errorText: string | null;
  waitingText: string | null;
}

/**
 * Neue Ereignisse einer Abfrage auswerten.
 * `events` kommt in der Reihenfolge der API (order=desc, neueste zuerst) und
 * wird hier chronologisch verarbeitet.
 */
export function evaluateEvents(events: ManusTaskEvent[], known: Set<string>): PollVerdict {
  const verdict: PollVerdict = { outcome: null, answers: [], errorText: null, waitingText: null };
  const chronological = events.filter((e) => e?.id && !known.has(e.id)).reverse();

  for (const ev of chronological) {
    known.add(ev.id);

    if (ev.type === 'assistant_message') {
      const content = (ev.assistant_message?.content ?? '').trim();
      if (content) verdict.answers.push(content);
      continue;
    }

    if (ev.type === 'error_message') {
      const content = (ev.error_message?.content ?? '').trim();
      verdict.errorText = content || ev.error_message?.error_type || 'unbekannter Fehler';
      verdict.outcome = 'error';
      continue;
    }

    if (ev.type === 'status_update') {
      const st = ev.status_update?.agent_status;
      if (st === 'stopped') {
        verdict.outcome = 'ok';
      } else if (st === 'error') {
        verdict.outcome = 'error';
        verdict.errorText = verdict.errorText
          ?? ev.status_update?.description
          ?? ev.status_update?.brief
          ?? 'Agent meldet Fehlerzustand';
      } else if (st === 'waiting') {
        verdict.outcome = 'waiting';
        verdict.waitingText =
          ev.status_update?.status_detail?.waiting_description
          ?? ev.status_update?.brief
          ?? 'Der Agent wartet auf eine Antwort.';
      }
      continue;
    }
  }

  return verdict;
}

/** Abfrageschleife bis Abschluss, Fehler, Rueckfrage oder Zeitablauf. */
async function collectResult(
  d: CueDelegationDeps,
  client: ManusClient,
  taskId: string,
  known: Set<string>,
  active: ActiveDelegation,
): Promise<void> {
  const wait = d.sleepImpl ?? sleep;
  const now = d.now ?? Date.now;
  const interval = d.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = active.startedAtMs + (d.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);

  const answers: string[] = [];
  let outcome: CueOutcome = 'timeout';
  let errorText: string | null = null;
  let waitingText: string | null = null;
  let consecutiveFailures = 0;

  try {
    while (now() < deadline) {
      await wait(interval);

      let page;
      try {
        page = await client.listMessages(taskId, { limit: 50, order: 'desc' });
        consecutiveFailures = 0;
      } catch (e: any) {
        // Einzelne Abfragefehler sind kein Abbruchgrund; erst eine Serie ist einer.
        consecutiveFailures++;
        d.logger.warn(`[cue] Abfrage fehlgeschlagen (${consecutiveFailures}): ${describeError(e)}`);
        if (consecutiveFailures >= 3) {
          outcome = 'error';
          errorText = describeError(e);
          break;
        }
        continue;
      }

      const verdict = evaluateEvents(page.messages, known);
      answers.push(...verdict.answers);
      if (verdict.outcome) {
        outcome = verdict.outcome;
        errorText = verdict.errorText;
        waitingText = verdict.waitingText;
        break;
      }
    }

    const ref = shortTaskRef(taskId);
    const durationMs = now() - active.startedAtMs;
    let message: string;

    if (outcome === 'ok') {
      const body = answers.join('\n\n').trim();
      message = body
        ? `Cue-Ergebnis (Task ${ref}):\n\n${cut(body, MAX_RESULT_CHARS)}`
        : `Cue hat den Auftrag beendet (Task ${ref}), aber keinen Antworttext geliefert.`;
    } else if (outcome === 'waiting') {
      const frage = [waitingText, ...answers].filter(Boolean).join('\n\n').trim();
      message =
        `Cue fragt zurueck (Task ${ref}):\n\n${cut(frage, MAX_RESULT_CHARS)}\n\n` +
        'Phase 1 antwortet nicht automatisch — der Auftrag ist damit beendet.';
    } else if (outcome === 'error') {
      message = `Cue-Fehler (Task ${ref}): ${errorText ?? 'unbekannter Fehler'}`;
    } else {
      const zwischenstand = answers.join('\n\n').trim();
      message =
        `Cue-Timeout (Task ${ref}): nach ${Math.round(durationMs / 60_000)} min keine Abschlussmeldung.` +
        (zwischenstand ? `\n\nLetzter Zwischenstand:\n\n${cut(zwischenstand, MAX_RESULT_CHARS)}` : '');
    }

    d.logger.info(`[cue] Delegation beendet: ${outcome} (Task ${ref}, ${durationMs} ms)`);
    await writeAudit(d, 'cue.delegation.finished', taskId, {
      status: outcome,
      duration_ms: durationMs,
      answer_chars: answers.join('\n\n').length,
      label: errorText ?? waitingText ?? null,
    });

    const sent = await d.notifyOperativ(message);
    if (!sent) d.logger.error(`[cue] Ergebnis konnte nicht zugestellt werden (Task ${ref})`);
  } finally {
    globals().__ea_cueActive = null;
  }
}

/**
 * cue-delegation/delegation — Ablaufsteuerung einer einzelnen Cue-Delegation.
 *
 * Phase 1 (Machbarkeitstest, Owner-Auftrag 08.10.2026): der Owner tippt
 * `/cue <text>`, genau dieser Text geht an den Main-Task des konfigurierten
 * Manus-Agenten, die Antwort kommt als Telegram-Nachricht zurueck. Nichts
 * anderes wird gesendet — keine Kontexte, kein Verlauf, keine internen Daten.
 *
 * Neue Ereignisse werden ueber ihre Event-ID erkannt, nicht ueber Zeitstempel:
 * vor dem Senden wird einmal der aktuelle Stand gelesen und die bekannten IDs
 * gemerkt. Damit ist das Verfahren unabhaengig von einer Uhr-Abweichung
 * zwischen VPS und Manus.
 *
 * ── Abschluss-Erkennung (gehaertet am 08.10.2026) ────────────────────────────
 *
 * `agent_status: 'stopped'` allein bedeutet **nicht** fertig. Belegt im
 * Live-Betrieb (Delegation 09:13, Report report-cue-completion-fix-20261008.md):
 *
 *   09:13:33  status_update     running
 *   09:13:35  assistant_message Eroeffnungssatz (144 Zeichen)
 *   09:13:42  tool_used         Recherche angestossen
 *   09:13:51  status_update     stopped      ← hier schloss der alte Poller ab
 *   09:21:20  status_update     running      ← 7,5 Minuten spaeter
 *   09:21:40  assistant_message echtes Ergebnis (1508 Zeichen)
 *   09:21:43  status_update     stopped
 *
 * Die Doku beschreibt genau das: „Independent of `status`: the main agent can be
 * stopped while background work continues" und als Abschlusskriterium
 * `status === 'stopped'` **und** `has_running_background_jobs === false`
 * (components.schemas.Task in openapi_v2.json, task-lifecycle).
 *
 * Deshalb gilt ein `stopped` nur als **Kandidat**:
 *   - `has_running_background_jobs === true`  → Kandidat verworfen, weiterpollen
 *   - `=== false` → Abschluss nach einem kurzen Bestaetigungsfenster (30 s)
 *   - fehlt das Feld → laut Doku nicht wie `false` lesen: langes Fenster (3 min)
 *   - kehrt der Agent auf `running` zurueck → Kandidat verworfen
 * In jedem Fall endet es spaetestens am 15-Minuten-Deckel, und dann mit einer
 * Meldung. Stille ist nie ein Ergebnis.
 *
 * Nicht verwendet, weil im Live-Befund nicht verfuegbar (beide verifiziert):
 *   - `delivery_kind` der assistant_messages: in allen 82 Ereignissen des
 *     Main-Tasks `undefined` — als Signal unbrauchbar.
 *   - `task.list?scope=agent_subtask&agent_id=…`: antwortet fuer den
 *     konfigurierten Agenten mit HTTP 404 `not_found: agent not found`.
 *
 * Genau eine Delegation darf gleichzeitig laufen (einfacher Mutex auf
 * globalThis, multi-load-sicher wie der uebrige Shared State in index.ts).
 * Der Zustand lebt nur im Prozess: ein Gateway-Restart beendet einen laufenden
 * Auftrag ohne Ergebnis. Fuer einen Machbarkeitstest bewusst akzeptiert.
 */
import { createManusClient, ManusError } from './manus-client.js';
import type { ManusAgentStatus, ManusClient, ManusTaskEvent } from './manus-client.js';
import { cueStatus, cueStatusText, loadCueConfig } from './config.js';
import type { CueConfig } from './config.js';
import { sleep } from '../../shared/utils/index.js';

/** Standard-Abfragetakt. 15 s liegt weit unter dem Leselimit von 100/min. */
const DEFAULT_POLL_INTERVAL_MS = 15_000;
/** Harte Obergrenze je Auftrag. */
const DEFAULT_MAX_RUNTIME_MS = 15 * 60_000;
/** Bestaetigungsfenster, wenn Manus ausdruecklich keine Hintergrundarbeit meldet. */
const DEFAULT_CONFIRM_WINDOW_MS = 30_000;
/** Bestaetigungsfenster, wenn das Feld fehlt — laut Doku nicht wie `false` lesen. */
const DEFAULT_UNKNOWN_CONFIRM_WINDOW_MS = 3 * 60_000;
/** Telegram erlaubt 4096 Zeichen; Rest ist Platz fuer die Kopfzeile. */
const MAX_RESULT_CHARS = 3_500;
/** Obergrenze fuer den im audit_log festgehaltenen Prompt-Text. */
const MAX_AUDIT_PROMPT_CHARS = 2_000;
/** Ersatzname, solange der Agentenname noch nicht aufgeloest ist. */
const FALLBACK_AGENT_NAME = 'Cue';

/**
 * Anzeigename fuer Owner-Nachrichten: immer mit vorangestelltem "Agent"
 * (Owner-Vorgabe 08.10.2026). Im audit_log steht weiterhin der rohe Name.
 */
export function agentLabel(name: string | null | undefined): string {
  return `Agent ${(name ?? '').trim() || FALLBACK_AGENT_NAME}`;
}

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
  /** Nur fuer Tests: Client-Fabrik, Wartezeit, Uhr und Takte ersetzen. */
  createClient?: (cfg: CueConfig) => ManusClient;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  maxRuntimeMs?: number;
  confirmWindowMs?: number;
  unknownConfirmWindowMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface ActiveDelegation {
  startedAtMs: number;
  startedAtIso: string;
  taskId: string | null;
  agentName: string | null;
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

interface AgentIdentity {
  taskId: string;
  name: string;
}

interface CueGlobals {
  __ea_cueActive?: ActiveDelegation | null;
  __ea_cueAgentByIdentity?: Record<string, AgentIdentity>;
}

function globals(): CueGlobals {
  const g = globalThis as unknown as CueGlobals;
  g.__ea_cueActive ??= null;
  g.__ea_cueAgentByIdentity ??= {};
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
  g.__ea_cueAgentByIdentity = {};
}

/**
 * Name des konfigurierten Agenten, sofern im Prozess bereits aufgeloest.
 * Fuer Statusmeldungen, die keine Delegation starten sollen.
 */
export function cachedAgentName(agentId: string): string | undefined {
  return globals().__ea_cueAgentByIdentity?.[agentId]?.name;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────

/** Kurzform der Task-ID — nur noch fuer Logzeilen und das audit_log. */
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
  agentName?: string;
}

/**
 * Eine Delegation starten. Kehrt zurueck, sobald der Text uebergeben ist —
 * das Einsammeln der Antwort laeuft danach im Hintergrund weiter.
 */
export async function startCueDelegation(text: string): Promise<CueStartResult> {
  const d = requireDeps();
  // Ohne injiziertes env gilt der Dateivorrang aus config.ts (kein Restart noetig).
  const cfg = loadCueConfig(d.env);
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
        `Es laeuft bereits ein Auftrag bei ${agentLabel(running.agentName)} (seit ${running.startedAtIso}). `
        + 'Phase 1 erlaubt genau einen gleichzeitig — bitte Ergebnis abwarten.',
    };
  }

  const nowMs = (d.now ?? Date.now)();
  const active: ActiveDelegation = {
    startedAtMs: nowMs,
    startedAtIso: new Date(nowMs).toISOString(),
    taskId: null,
    agentName: null,
  };
  g.__ea_cueActive = active;

  try {
    const client = (d.createClient ?? defaultClientFactory)(cfg);

    // 1. Main-Task und Name des Agenten bestimmen (nach erstem Erfolg gemerkt).
    let identity = g.__ea_cueAgentByIdentity![cfg.agentId];
    if (!identity) {
      const agent = await client.getAgent(cfg.agentId);
      identity = { taskId: agent.task_id, name: (agent.nickname ?? '').trim() || FALLBACK_AGENT_NAME };
      g.__ea_cueAgentByIdentity![cfg.agentId] = identity;
    }
    active.taskId = identity.taskId;
    active.agentName = identity.name;

    // 2. Anker: alles, was jetzt schon im Strang steht, ist nicht unsere Antwort.
    const anchor = await client.listMessages(identity.taskId, { limit: 50, order: 'desc' });
    const known = new Set(anchor.messages.map((m) => m.id));

    // 3. Ausschliesslich den getippten Text uebergeben.
    await client.sendMessage(identity.taskId, text);

    d.logger.info(
      `[cue] Delegation gestartet (${identity.name}, Task ${shortTaskRef(identity.taskId)}, ${text.length} Zeichen)`,
    );
    void writeAudit(d, 'cue.delegation.sent', identity.taskId, {
      // `notes` ist im Audit-Whitelist-Filter freigegeben, damit der Prompt des
      // Owners lesbar erhalten bleibt (src/shared/audit/index.ts).
      notes: cut(text, MAX_AUDIT_PROMPT_CHARS),
      prompt_chars: text.length,
      label: identity.name,
    });

    // 4. Antwort im Hintergrund einsammeln. Fehler landen in Telegram, nie im Aufrufer.
    void collectResult(d, client, identity, known, active).catch((e: any) => {
      d.logger.error(`[cue] Hintergrundlauf abgebrochen: ${e?.message}`);
      globals().__ea_cueActive = null;
    });

    return {
      ok: true,
      kind: 'started',
      taskId: identity.taskId,
      agentName: identity.name,
      message: `An ${agentLabel(identity.name)} uebergeben — Ergebnis folgt als eigene Nachricht.`,
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
    return { ok: false, kind: 'error', message: `Uebergabe an Cue fehlgeschlagen: ${msg}` };
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

/**
 * Einen Audit-Eintrag des Moduls schreiben — auch aus /cue_setup heraus.
 * Ist das Modul noch nicht verdrahtet, bleibt es ohne Eintrag statt zu werfen:
 * ein fehlender Audit-Schreibweg darf keinen Owner-Befehl abbrechen.
 */
export async function writeCueAuditEntry(
  action: string,
  entityId: string,
  after: Record<string, unknown>,
): Promise<void> {
  if (!deps) return;
  await writeAudit(deps, action, entityId, after);
}

export interface PollVerdict {
  /**
   * Sofort-Ausgang: `error` und `waiting` beenden die Delegation unmittelbar.
   * `ok` heisst nur „ein stopped war dabei" — ob das der Abschluss ist,
   * entscheidet erst die Pruefung in `collectResult`.
   */
  outcome: CueOutcome | null;
  answers: string[];
  errorText: string | null;
  waitingText: string | null;
  /** Letztes status_update dieses Stapels in chronologischer Reihenfolge. */
  lastStatus: ManusAgentStatus | null;
  /** Wie viele bisher unbekannte Ereignisse verarbeitet wurden. */
  newEventCount: number;
}

/**
 * Neue Ereignisse einer Abfrage auswerten.
 * `events` kommt in der Reihenfolge der API (order=desc, neueste zuerst) und
 * wird hier chronologisch verarbeitet.
 */
export function evaluateEvents(events: ManusTaskEvent[], known: Set<string>): PollVerdict {
  const verdict: PollVerdict = {
    outcome: null, answers: [], errorText: null, waitingText: null,
    lastStatus: null, newEventCount: 0,
  };
  const chronological = events.filter((e) => e?.id && !known.has(e.id)).reverse();

  for (const ev of chronological) {
    known.add(ev.id);
    verdict.newEventCount++;

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
      if (st) verdict.lastStatus = st;
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
  identity: AgentIdentity,
  known: Set<string>,
  active: ActiveDelegation,
): Promise<void> {
  const taskId = identity.taskId;
  const name = agentLabel(identity.name);
  const wait = d.sleepImpl ?? sleep;
  const now = d.now ?? Date.now;
  const interval = d.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const confirmWindow = d.confirmWindowMs ?? DEFAULT_CONFIRM_WINDOW_MS;
  const unknownWindow = d.unknownConfirmWindowMs ?? DEFAULT_UNKNOWN_CONFIRM_WINDOW_MS;
  const deadline = active.startedAtMs + (d.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);

  const answers: string[] = [];
  let outcome: CueOutcome = 'timeout';
  let errorText: string | null = null;
  let waitingText: string | null = null;
  let consecutiveFailures = 0;
  /** Zeitpunkt des ersten unbestaetigten `stopped`, oder null. */
  let candidateSinceMs: number | null = null;
  /** Nur fuer Report und Audit: wie oft ein `stopped` verworfen wurde. */
  let verworfeneAbschluesse = 0;

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

      // Fehler und Rueckfrage beenden sofort — daran aendert die Haertung nichts.
      if (verdict.outcome === 'error' || verdict.outcome === 'waiting') {
        outcome = verdict.outcome;
        errorText = verdict.errorText;
        waitingText = verdict.waitingText;
        break;
      }

      // Kandidat pflegen: ein `stopped` eroeffnet ihn, jede andere neue
      // Aktivitaet verwirft ihn wieder.
      if (verdict.lastStatus === 'stopped') {
        candidateSinceMs ??= now();
      } else if (verdict.lastStatus === 'running' || verdict.newEventCount > 0) {
        if (candidateSinceMs !== null) verworfeneAbschluesse++;
        candidateSinceMs = null;
      }

      if (candidateSinceMs === null) continue;

      // Dokumentiertes Abschlusskriterium: stopped UND keine Hintergrundarbeit.
      let backgroundJobs: boolean | null = null;
      try {
        backgroundJobs = (await client.getTask(taskId)).hasRunningBackgroundJobs;
      } catch (e: any) {
        // Unbekannt ist nicht „fertig" — es gilt das lange Fenster.
        d.logger.warn(`[cue] task.detail nicht lesbar: ${describeError(e)}`);
        backgroundJobs = null;
      }

      if (backgroundJobs === true) {
        verworfeneAbschluesse++;
        candidateSinceMs = null;
        d.logger.info(`[cue] stopped verworfen — Hintergrundarbeit laeuft (Task ${shortTaskRef(taskId)})`);
        continue;
      }

      const fenster = backgroundJobs === false ? confirmWindow : unknownWindow;
      if (now() - candidateSinceMs >= fenster) {
        outcome = 'ok';
        break;
      }
    }

    const durationMs = now() - active.startedAtMs;
    let message: string;

    if (outcome === 'ok') {
      const body = answers.join('\n\n').trim();
      message = body
        ? `Ergebnis von ${name}:\n\n${cut(body, MAX_RESULT_CHARS)}`
        : `${name} hat den Auftrag beendet, aber keinen Antworttext geliefert.`;
    } else if (outcome === 'waiting') {
      const frage = [waitingText, ...answers].filter(Boolean).join('\n\n').trim();
      message =
        `${name} fragt zurueck:\n\n${cut(frage, MAX_RESULT_CHARS)}\n\n`
        + 'Phase 1 antwortet nicht automatisch — der Auftrag ist damit beendet.';
    } else if (outcome === 'error') {
      message = `${name} meldet einen Fehler: ${errorText ?? 'unbekannter Fehler'}`;
    } else {
      const zwischenstand = answers.join('\n\n').trim();
      message =
        `Zeitueberschreitung bei ${name}: nach ${Math.round(durationMs / 60_000)} min keine Abschlussmeldung.`
        + (zwischenstand ? `\n\nLetzter Zwischenstand:\n\n${cut(zwischenstand, MAX_RESULT_CHARS)}` : '');
    }

    d.logger.info(
      `[cue] Delegation beendet: ${outcome} (${name}, Task ${shortTaskRef(taskId)}, ${durationMs} ms,`
      + ` ${verworfeneAbschluesse} verworfene Abschluesse)`,
    );
    await writeAudit(d, 'cue.delegation.finished', taskId, {
      status: outcome,
      duration_ms: durationMs,
      answer_chars: answers.join('\n\n').length,
      label: errorText ?? waitingText ?? identity.name,
      discarded_stops: verworfeneAbschluesse,
    });

    const sent = await d.notifyOperativ(message);
    if (!sent) d.logger.error(`[cue] Ergebnis konnte nicht zugestellt werden (Task ${shortTaskRef(taskId)})`);
  } finally {
    globals().__ea_cueActive = null;
  }
}

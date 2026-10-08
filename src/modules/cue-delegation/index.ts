/**
 * cue-delegation — Delegation eines Owner-Textes an einen Manus-Cue-Agenten.
 *
 * Phase 1 (Machbarkeitstest): /cue <text> → Manus API v2 → Cue-Agent → Antwort
 * als Telegram-Nachricht. Vollstaendig abschaltbar ueber
 * CUE_DELEGATION_ENABLED; ohne Konfiguration still inaktiv.
 *
 * Grenzen von Phase 1 (bewusst):
 *   - gesendet wird ausschliesslich der getippte Owner-Text, nichts angereichert
 *   - kein Zugriff auf fachliche Stores, DB-Tabellen oder Dateien
 *     (einzige Ausnahme: der vorgeschriebene audit_log-Eintrag je Delegation)
 *   - genau ein Auftrag gleichzeitig, harte Laufzeitgrenze 15 Minuten
 *   - kein Webhook, keine zusaetzliche Infrastruktur
 *
 * Doku: docs/INFRA.md, Abschnitt "Manus-Cue-Delegation (Phase 1)".
 *
 * Diese Datei ist die oeffentliche Modul-Schnittstelle — ESLint
 * (openclaw/no-deep-module-import) erlaubt Importe nur hierueber.
 */
export { initCueCommands, registerCueCommands, buildCueStatusText } from './commands.js';
export { initCueDelegation, startCueDelegation, activeCueDelegation, resetCueState } from './delegation.js';
export type { CueCommandDeps } from './commands.js';
export type { CueDelegationDeps, CueOutcome, CueStartResult } from './delegation.js';
export { loadCueConfig, cueStatus, cueStatusText } from './config.js';
export type { CueConfig, CueStatus } from './config.js';
export { createManusClient, ManusError, MANUS_BASE_URL } from './manus-client.js';
export type { ManusClient, ManusAgent, ManusTaskEvent } from './manus-client.js';

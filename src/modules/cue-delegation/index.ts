/**
 * cue-delegation — Delegation eines Owner-Textes an einen Manus-Cue-Agenten.
 *
 * Phase 1 (Machbarkeitstest): /cue <text> → Manus API v2 → Cue-Agent → Antwort
 * als Telegram-Nachricht. Einrichtung in einer Nachricht: /cue_setup <api-key>.
 * Vollstaendig abschaltbar ueber CUE_DELEGATION_ENABLED; ohne Konfiguration
 * still inaktiv.
 *
 * Grenzen von Phase 1 (bewusst):
 *   - gesendet wird ausschliesslich der getippte Owner-Text, nichts angereichert
 *   - kein Zugriff auf fachliche Stores, DB-Tabellen oder Dateien
 *     (Ausnahmen: der vorgeschriebene audit_log-Eintrag je Delegation und die
 *     drei eigenen Schluessel in ~/.config/openclaw/env)
 *   - genau ein Auftrag gleichzeitig, harte Laufzeitgrenze 15 Minuten
 *   - kein Webhook, keine zusaetzliche Infrastruktur
 *
 * Doku: docs/INFRA.md, Abschnitt "Manus-Cue-Delegation (Phase 1)".
 *
 * Diese Datei ist die oeffentliche Modul-Schnittstelle — ESLint
 * (openclaw/no-deep-module-import) erlaubt Importe nur hierueber.
 */
export {
  initCueCommands, registerCueCommands, buildCueStatusText,
  noteInboundMessageId, lastInboundMessageId, resetInboundStore,
  CUE_SETUP_TEST_PROMPT,
} from './commands.js';
export {
  initCueDelegation, startCueDelegation, activeCueDelegation, resetCueState,
  writeCueAuditEntry, evaluateEvents, describeError, shortTaskRef,
} from './delegation.js';
export type { CueCommandDeps } from './commands.js';
export type { CueDelegationDeps, CueOutcome, CueStartResult } from './delegation.js';
export {
  loadCueConfig, cueStatus, cueStatusText, cueEnvPath, parseEnvFile,
  readCueEnvFile, resetCueEnvCache, applyCueEnvToProcess,
} from './config.js';
export type { CueConfig, CueStatus } from './config.js';
export { CUE_ENV_KEYS, rewriteCueEnv, writeCueEnv, backupStamp } from './env-writer.js';
export type { CueEnvKey, WriteCueEnvResult } from './env-writer.js';
export {
  runCueSetup, validateApiKey, resolveHansAgent, formatAgentList, shortAgentRef,
  CUE_AGENT_NICKNAME,
} from './setup.js';
export type { CueSetupResult, CueSetupStatus, CueSetupDeps } from './setup.js';
export { createManusClient, ManusError, MANUS_BASE_URL } from './manus-client.js';
export type { ManusClient, ManusAgent, ManusTaskEvent } from './manus-client.js';

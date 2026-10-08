/**
 * cue-delegation/config — Konfiguration aus ~/.config/openclaw/env.
 *
 * Konvention des Projekts: KEY=VALUE ohne export-Prefix, vom systemd-Unit
 * openclaw-gateway.service als EnvironmentFile geladen. Aenderungen wirken erst
 * nach `systemctl --user restart openclaw-gateway.service`.
 *
 *   CUE_DELEGATION_ENABLED=true|false   Hauptschalter (Default: false)
 *   MANUS_API_KEY=...                   Manus API-Key (x-manus-api-key)
 *   MANUS_CUE_AGENT_ID=...              agent_id des Cue-Agenten "Hans"
 *
 * Solange Key oder agent_id fehlen bzw. auf einem Platzhalter stehen, ist das
 * Modul nicht einsatzbereit und /cue meldet "deaktiviert" — ohne einen einzigen
 * externen Aufruf.
 */

/** Werte, die als "noch nicht eingetragen" gelten. */
const PLACEHOLDERS = new Set(['', 'changeme', 'todo', 'xxx', 'placeholder']);

export type CueReadyReason = 'ok' | 'disabled' | 'no_key' | 'no_agent';

export interface CueConfig {
  enabled: boolean;
  apiKey: string;
  agentId: string;
}

export interface CueStatus {
  ready: boolean;
  reason: CueReadyReason;
  /** Namen der fehlenden env-Schluessel — nie Werte. */
  missing: string[];
}

function clean(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  return PLACEHOLDERS.has(v.toLowerCase()) ? '' : v;
}

export function loadCueConfig(env: NodeJS.ProcessEnv = process.env): CueConfig {
  return {
    enabled: (env.CUE_DELEGATION_ENABLED ?? 'false').trim().toLowerCase() === 'true',
    apiKey: clean(env.MANUS_API_KEY),
    agentId: clean(env.MANUS_CUE_AGENT_ID),
  };
}

export function cueStatus(cfg: CueConfig): CueStatus {
  if (!cfg.enabled) return { ready: false, reason: 'disabled', missing: ['CUE_DELEGATION_ENABLED'] };
  if (!cfg.apiKey) return { ready: false, reason: 'no_key', missing: ['MANUS_API_KEY'] };
  if (!cfg.agentId) return { ready: false, reason: 'no_agent', missing: ['MANUS_CUE_AGENT_ID'] };
  return { ready: true, reason: 'ok', missing: [] };
}

/**
 * Owner-lesbare Begruendung, warum die Delegation nicht laeuft.
 * Nennt ausschliesslich Schluesselnamen, niemals Werte (C5).
 */
export function cueStatusText(status: CueStatus): string {
  switch (status.reason) {
    case 'disabled':
      return 'Cue-Delegation ist deaktiviert (CUE_DELEGATION_ENABLED=false in ~/.config/openclaw/env).';
    case 'no_key':
      return 'Cue-Delegation ist deaktiviert: MANUS_API_KEY fehlt in ~/.config/openclaw/env.';
    case 'no_agent':
      return 'Cue-Delegation ist deaktiviert: MANUS_CUE_AGENT_ID fehlt in ~/.config/openclaw/env.';
    default:
      return 'Cue-Delegation ist aktiv.';
  }
}

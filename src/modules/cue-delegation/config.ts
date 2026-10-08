/**
 * cue-delegation/config — Konfiguration aus ~/.config/openclaw/env.
 *
 * Konvention des Projekts: KEY=VALUE ohne export-Prefix, vom systemd-Unit
 * openclaw-gateway.service als EnvironmentFile geladen.
 *
 *   CUE_DELEGATION_ENABLED=true|false   Hauptschalter (Default: false)
 *   MANUS_API_KEY=...                   Manus API-Key (x-manus-api-key)
 *   MANUS_CUE_AGENT_ID=...              agent_id des Cue-Agenten "Hans"
 *
 * Solange Key oder agent_id fehlen bzw. auf einem Platzhalter stehen, ist das
 * Modul nicht einsatzbereit und /cue meldet "deaktiviert" — ohne einen einzigen
 * externen Aufruf.
 *
 * Gelesen wird zur Laufzeit die **Datei**, nicht nur `process.env` vom
 * Prozessstart. Grund: /cue_setup schreibt die drei Schlüssel im Betrieb, und
 * ohne Dateivorrang würde der beim Start geladene Platzhalter weitergelten —
 * ein Gateway-Restart wäre nötig. `readEnvKey()` aus src/shared/utils taugt
 * dafür nicht, weil es `process.env` den Vorrang gibt.
 * `process.env` bleibt Rückfall für Schlüssel, die die Datei nicht führt.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Werte, die als "noch nicht eingetragen" gelten. */
const PLACEHOLDERS = new Set(['', 'changeme', 'todo', 'xxx', 'placeholder']);

/** Wie lange ein Dateilesevorgang gilt, bevor erneut gelesen wird. */
const ENV_CACHE_TTL_MS = 2_000;

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

/** Pfad der Secret-Datei; Heimatverzeichnis ueberschreibbar fuer Tests. */
export function cueEnvPath(home?: string): string {
  return path.join(home ?? process.env.HOME ?? '/root', '.config/openclaw/env');
}

/**
 * Eine env-Datei in Schluessel/Wert zerlegen.
 * Kommentare und Zeilen ohne `=` werden uebersprungen; ein optionales
 * `export `-Prefix und umschliessende Anfuehrungszeichen werden entfernt.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const werte: Record<string, string> = {};
  for (const rohzeile of content.split('\n')) {
    const zeile = rohzeile.trim();
    if (!zeile || zeile.startsWith('#')) continue;
    const eq = zeile.indexOf('=');
    if (eq <= 0) continue;
    const key = zeile.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = zeile.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    werte[key] = val;
  }
  return werte;
}

interface EnvCache {
  werte: Record<string, string>;
  gelesenMs: number;
}

/** Nur fuer den Standardpfad gecacht; ein expliziter Pfad liest immer frisch. */
let envCache: EnvCache | null = null;

/** Cache verwerfen — nach einem Schreibvorgang und in Tests. */
export function resetCueEnvCache(): void {
  envCache = null;
}

/** Die env-Datei lesen. Ist sie nicht lesbar, gilt sie als leer. */
export function readCueEnvFile(opts: { envPath?: string; now?: () => number } = {}): Record<string, string> {
  const jetzt = (opts.now ?? Date.now)();
  const standardpfad = !opts.envPath;
  if (standardpfad && envCache && jetzt - envCache.gelesenMs < ENV_CACHE_TTL_MS) {
    return envCache.werte;
  }

  let werte: Record<string, string> = {};
  try {
    werte = parseEnvFile(fs.readFileSync(opts.envPath ?? cueEnvPath(), 'utf-8'));
  } catch {
    // Datei fehlt oder ist nicht lesbar — dann gilt allein process.env.
    werte = {};
  }

  if (standardpfad) envCache = { werte, gelesenMs: jetzt };
  return werte;
}

function clean(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  return PLACEHOLDERS.has(v.toLowerCase()) ? '' : v;
}

/**
 * Konfiguration bestimmen.
 *
 * Wird `env` uebergeben, gilt ausschliesslich dieses Objekt (Tests). Sonst:
 * Dateiwert vor `process.env`.
 */
export function loadCueConfig(env?: NodeJS.ProcessEnv): CueConfig {
  const lies: (key: string) => string | undefined = env
    ? (key) => env[key]
    : (() => {
        const datei = readCueEnvFile();
        return (key: string) => (datei[key] !== undefined ? datei[key] : process.env[key]);
      })();

  return {
    enabled: (lies('CUE_DELEGATION_ENABLED') ?? 'false').trim().toLowerCase() === 'true',
    apiKey: clean(lies('MANUS_API_KEY')),
    agentId: clean(lies('MANUS_CUE_AGENT_ID')),
  };
}

/**
 * Geschriebene Werte zusaetzlich im laufenden Prozess setzen und den Cache
 * verwerfen. Damit wirkt /cue_setup sofort, auch wenn der Dateilesevorgang
 * noch im Cache-Fenster liegt.
 */
export function applyCueEnvToProcess(updates: Record<string, string>): void {
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
  resetCueEnvCache();
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
      return 'Cue-Delegation ist deaktiviert (CUE_DELEGATION_ENABLED=false in ~/.config/openclaw/env). '
        + 'Einrichten mit /cue_setup <api-key>.';
    case 'no_key':
      return 'Cue-Delegation ist deaktiviert: MANUS_API_KEY fehlt. Einrichten mit /cue_setup <api-key>.';
    case 'no_agent':
      return 'Cue-Delegation ist deaktiviert: MANUS_CUE_AGENT_ID fehlt. '
        + 'Einrichten mit /cue_setup <api-key> oder /cue_setup <api-key> <agent_id>.';
    default:
      return 'Cue-Delegation ist aktiv.';
  }
}

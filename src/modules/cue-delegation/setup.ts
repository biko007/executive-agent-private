/**
 * cue-delegation/setup — Einrichtung in einem Zug.
 *
 * Owner-Direktive (08.10.2026): der Aufwand soll **eine** Telegram-Nachricht
 * sein. Kein env-Editieren, keine ID-Suche, kein Restart. Deshalb macht
 * `runCueSetup` alles hintereinander:
 *
 *   1. Key grob pruefen  (ungueltig → es wird nichts geschrieben)
 *   2. MANUS_API_KEY + CUE_DELEGATION_ENABLED=true schreiben
 *   3. Agenten-ID bestimmen: entweder vom Owner mitgegeben oder ueber
 *      agent.list anhand des Nicknames "Hans"
 *   4. MANUS_CUE_AGENT_ID schreiben
 *
 * Der Key wird ausschliesslich in die Secret-Datei geschrieben. Er erscheint in
 * keinem Rueckgabewert, keiner Meldung und keinem Fehlertext — Fehlertexte der
 * Gegenseite laufen ueber `describeError`, das die Key-Redaktion des Clients
 * nutzt.
 */
import { createManusClient } from './manus-client.js';
import type { ManusAgent, ManusClient } from './manus-client.js';
import { applyCueEnvToProcess } from './config.js';
import { writeCueEnv } from './env-writer.js';
import { describeError } from './delegation.js';

/** Nickname, unter dem der Cue-Agent gesucht wird. */
export const CUE_AGENT_NICKNAME = 'hans';

/** Kuerzeste plausible Laenge eines API-Keys. */
const MIN_KEY_LENGTH = 16;

const KEY_PLACEHOLDERS = new Set(['changeme', 'todo', 'xxx', 'placeholder', 'your-api-key', '<api-key>']);

export type CueSetupStatus = 'ok' | 'ambiguous' | 'error';

export interface CueSetupResult {
  status: CueSetupStatus;
  /** Owner-lesbare Meldung. Enthaelt nie Key-Material. */
  message: string;
  agentId?: string;
  agentName?: string;
  /** Bei `ambiguous`: die Auswahl, aus der der Owner waehlen kann. */
  agents?: ManusAgent[];
  /** Wurde die env-Datei angefasst? Fuer Audit und Report. */
  envWritten: boolean;
  backupPath?: string | null;
}

export interface CueSetupDeps {
  /** Nur fuer Tests: Client-Fabrik ersetzen. */
  createClient?: (apiKey: string) => ManusClient;
  /** Nur fuer Tests: auf eine Temp-Datei schreiben statt auf die echte env. */
  envPath?: string;
  now?: () => Date;
  /** Nur fuer Tests: process.env nicht anfassen. */
  applyToProcess?: (updates: Record<string, string>) => void;
}

export type KeyCheck = { ok: true; key: string } | { ok: false; reason: string };

/**
 * Grobe Pruefung des API-Keys. Absicht ist nicht, das Manus-Format
 * nachzubilden, sondern Tippfehler und versehentlich mitgeschickte Platzhalter
 * abzufangen, **bevor** etwas in die Secret-Datei geschrieben wird.
 */
export function validateApiKey(raw: string): KeyCheck {
  const key = (raw ?? '').trim();
  if (!key) return { ok: false, reason: 'Kein API-Key angegeben.' };
  if (/\s/.test(key)) return { ok: false, reason: 'Der API-Key darf keine Leerzeichen enthalten.' };
  if (KEY_PLACEHOLDERS.has(key.toLowerCase())) return { ok: false, reason: 'Das ist ein Platzhalter, kein API-Key.' };
  if (key.length < MIN_KEY_LENGTH) {
    return { ok: false, reason: `Der API-Key ist zu kurz (mindestens ${MIN_KEY_LENGTH} Zeichen).` };
  }
  // Druckbares ASCII ohne Steuerzeichen — alles andere kann die env-Datei zerlegen.
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, reason: 'Der API-Key enthaelt unerlaubte Zeichen.' };
  return { ok: true, key };
}

export type HansMatch =
  | { kind: 'unique'; agent: ManusAgent }
  | { kind: 'ambiguous'; candidates: ManusAgent[] };

/**
 * Den Cue-Agenten in der Agentenliste finden.
 *
 * Erst exakt auf den Nickname "hans" (getrimmt, ohne Gross-/Kleinschreibung).
 * Gibt es keinen exakten Treffer, zaehlt ein **einziger** Agent, dessen Name
 * "hans" enthaelt, ebenfalls als eindeutig — das faengt Namen wie
 * "Cue Hans" ab und erspart dem Owner einen zweiten Schritt. Bleibt es bei
 * null oder mehreren Kandidaten, entscheidet der Owner.
 */
export function resolveHansAgent(agents: ManusAgent[]): HansMatch {
  const mitNamen = agents.filter((a) => a && typeof a.id === 'string' && a.id);

  const exakt = mitNamen.filter((a) => (a.nickname ?? '').trim().toLowerCase() === CUE_AGENT_NICKNAME);
  if (exakt.length === 1) return { kind: 'unique', agent: exakt[0] };
  if (exakt.length > 1) return { kind: 'ambiguous', candidates: exakt };

  const enthalten = mitNamen.filter((a) => (a.nickname ?? '').trim().toLowerCase().includes(CUE_AGENT_NICKNAME));
  if (enthalten.length === 1) return { kind: 'unique', agent: enthalten[0] };

  return { kind: 'ambiguous', candidates: mitNamen };
}

/** Agentenliste owner-lesbar formatieren: `id — Name`. */
export function formatAgentList(agents: ManusAgent[]): string {
  if (!agents.length) return 'Die Manus-Antwort enthielt keine Agenten.';
  return ['Verfuegbare Agenten (agent_id — Name):', ...agents.map((a) => `  ${a.id} — ${a.nickname ?? '(ohne Namen)'}`)].join('\n');
}

/** Kurzform einer Agenten-ID fuer owner-sichtbare Meldungen. */
export function shortAgentRef(agentId: string): string {
  return agentId.length > 12 ? `${agentId.slice(0, 8)}…${agentId.slice(-4)}` : agentId;
}

export async function runCueSetup(
  input: { apiKey: string; agentId?: string },
  deps: CueSetupDeps = {},
): Promise<CueSetupResult> {
  const pruefung = validateApiKey(input.apiKey);
  if (!pruefung.ok) {
    return { status: 'error', message: pruefung.reason, envWritten: false };
  }
  const key = pruefung.key;

  const schreibOpts = { envPath: deps.envPath, now: deps.now?.() };
  const anwenden = deps.applyToProcess ?? applyCueEnvToProcess;

  // Schritt a: Key und Hauptschalter sichern. Erst hier wird geschrieben.
  let backupPath: string | null = null;
  try {
    const res = writeCueEnv(
      { MANUS_API_KEY: key, CUE_DELEGATION_ENABLED: 'true' },
      schreibOpts,
    );
    backupPath = res.backupPath;
    anwenden({ MANUS_API_KEY: key, CUE_DELEGATION_ENABLED: 'true' });
  } catch (e: any) {
    return {
      status: 'error',
      message: `env-Datei nicht schreibbar: ${e?.message}`,
      envWritten: false,
    };
  }

  // Schritt b: Agenten bestimmen — mit dem neuen Key, nicht dem gespeicherten.
  const client = (deps.createClient ?? ((k: string) => createManusClient({ apiKey: k })))(key);

  if (input.agentId) {
    try {
      const agent = await client.getAgent(input.agentId);
      return finish(agent, { skipBackup: true });
    } catch (e: any) {
      return {
        status: 'error',
        message: `agent_id nicht verwendbar: ${describeError(e)}`,
        envWritten: true,
        backupPath,
      };
    }
  }

  let agenten: ManusAgent[];
  try {
    agenten = await client.listAgents();
  } catch (e: any) {
    return {
      status: 'error',
      message: `Agentenliste nicht abrufbar: ${describeError(e)}`,
      envWritten: true,
      backupPath,
    };
  }

  const treffer = resolveHansAgent(agenten);
  if (treffer.kind === 'unique') {
    return finish(treffer.agent, { skipBackup: true });
  }

  return {
    status: 'ambiguous',
    message:
      `Key gespeichert, aber der Agent "Hans" liess sich nicht eindeutig bestimmen.\n\n${formatAgentList(treffer.candidates)}\n\n`
      + 'Zweiter Versuch mit der ID: /cue_setup <api-key> <agent_id>',
    agents: treffer.candidates,
    envWritten: true,
    backupPath,
  };

  /** agent_id sichern und Erfolg melden. */
  function finish(agent: ManusAgent, opts: { skipBackup: boolean }): CueSetupResult {
    try {
      writeCueEnv({ MANUS_CUE_AGENT_ID: agent.id }, { ...schreibOpts, skipBackup: opts.skipBackup });
      anwenden({ MANUS_CUE_AGENT_ID: agent.id });
    } catch (e: any) {
      return {
        status: 'error',
        message: `agent_id nicht schreibbar: ${e?.message}`,
        envWritten: true,
        backupPath,
      };
    }
    return {
      status: 'ok',
      message: `Eingerichtet: Agent ${agent.nickname ?? '(ohne Namen)'} (${shortAgentRef(agent.id)}).`,
      agentId: agent.id,
      agentName: agent.nickname ?? '(ohne Namen)',
      envWritten: true,
      backupPath,
    };
  }
}

/**
 * cue-delegation/commands — Telegram-Commands /cue und /cue_setup.
 *
 * Commands:
 *   /cue <text>                        Text an den Cue-Agenten delegieren
 *   /cue_setup <api-key>               Einrichtung in einem Zug
 *   /cue_setup <api-key> <agent_id>    Zweitform, wenn "Hans" nicht eindeutig war
 *
 * Owner-only ueber den Binding-Guard (assertBoundOwner wird aus index.ts
 * injiziert — derselbe Weg wie /do und /arm). Ohne gueltige Bindung passiert
 * nichts ausser der Abweisung.
 *
 * Diese Datei muss `src/modules/<name>/commands.ts` heissen, damit
 * `npm run verify:commands` die Handler findet (scripts/verify-commands.ts).
 */
import { createManusClient } from './manus-client.js';
import { cueStatus, cueStatusText, loadCueConfig } from './config.js';
import {
  activeCueDelegation, cachedAgentName, describeError, startCueDelegation, writeCueAuditEntry,
} from './delegation.js';
import { formatAgentList, runCueSetup } from './setup.js';

/** Fester Text des Machbarkeits-Testauftrags nach erfolgreicher Einrichtung. */
export const CUE_SETUP_TEST_PROMPT = 'Nenne drei Primärquellen zur Geschichte des Mercedes 560 SL';

export interface CueCommandDeps {
  /** Binding-Guard aus index.ts: `ok` nur fuer den gebundenen Owner. */
  assertOwner: (ctx: any) => Promise<{ ok: boolean; chatId: string }>;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /**
   * Telegram deleteMessage (best effort). Wird aus index.ts injiziert, damit
   * der Bot-Token das Modul nie erreicht.
   */
  deleteTelegramMessage?: (chatId: string, messageId: string) => Promise<boolean>;
}

let deps: CueCommandDeps;

export function initCueCommands(d: CueCommandDeps): void {
  deps = d;
}

const USAGE_CUE = 'Nutzung: /cue <text> — der Text geht unveraendert an den Cue-Agenten.';

/**
 * Die Argumente vom Befehlswort befreien.
 *
 * Normalerweise liefert der Host in `ctx.args` schon den reinen Text. Im
 * Live-Betrieb vom 08.10.2026 (Delegation 09:13) kam dort aber der komplette
 * Nachrichtentext einschliesslich `/cue ` an — belegt im Manus-Verlauf: der
 * gesendete Text war 347 Zeichen lang und begann mit `/cue `. Woran das im
 * Host liegt, ist offen (Report report-cue-completion-fix-20261008.md).
 * Diese Normalisierung macht den Aufruf unabhaengig davon: ein fuehrendes
 * `/cue` oder `/cue_setup` wird entfernt, alles andere bleibt unberuehrt.
 */
export function stripCommandPrefix(raw: string): string {
  return raw.replace(/^\s*\/(?:cue_setup|cue-setup|cue)(?=\s|$)\s*/i, '').trim();
}

const USAGE_SETUP = 'Nutzung: /cue_setup <api-key>   oder   /cue_setup <api-key> <agent_id>';

// ── Nachrichten-IDs eingehender Nachrichten ────────────────────────────────
//
// Der Command-Kontext von OpenClaw 2026.9.1 fuehrt keine Nachrichten-ID
// (PluginCommandContext). Das Hook-Ereignis message_received fuehrt sie und
// laeuft vorher. index.ts meldet sie hier an — gespeichert werden nur Chat-ID,
// Nachrichten-ID und Zeitpunkt, **kein Inhalt**.

const INBOUND_TTL_MS = 2 * 60_000;
const INBOUND_MAX = 20;

interface InboundGlobals {
  __ea_cueLastInbound?: Map<string, { messageId: string; ts: number }>;
}

function inboundStore(): Map<string, { messageId: string; ts: number }> {
  const g = globalThis as unknown as InboundGlobals;
  g.__ea_cueLastInbound ??= new Map();
  return g.__ea_cueLastInbound;
}

/** Letzte eingehende Nachrichten-ID eines Chats merken (nur Metadaten). */
export function noteInboundMessageId(chatId: string, messageId: string, now = Date.now()): void {
  if (!chatId || !messageId) return;
  const store = inboundStore();
  store.set(chatId, { messageId, ts: now });
  for (const [k, v] of store) {
    if (now - v.ts > INBOUND_TTL_MS) store.delete(k);
  }
  while (store.size > INBOUND_MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Gemerkte Nachrichten-ID, sofern noch frisch. */
export function lastInboundMessageId(chatId: string, now = Date.now()): string | undefined {
  const eintrag = inboundStore().get(chatId);
  if (!eintrag) return undefined;
  if (now - eintrag.ts > INBOUND_TTL_MS) return undefined;
  return eintrag.messageId;
}

/** Nur fuer Tests. */
export function resetInboundStore(): void {
  inboundStore().clear();
}

/**
 * Statusauskunft fuer `/cue` ohne Argument.
 *
 * Fehlt nur die agent_id, aber der Key ist eingetragen, werden die verfuegbaren
 * Agenten gelistet (nur lesender Aufruf). Es werden nur Schluesselnamen
 * genannt, niemals Werte (C5).
 */
export async function buildCueStatusText(): Promise<string> {
  const cfg = loadCueConfig();
  const status = cueStatus(cfg);
  const laufend = activeCueDelegation();
  const zeilen: string[] = [cueStatusText(status)];

  if (status.reason === 'no_agent') {
    try {
      zeilen.push(formatAgentList(await createManusClient({ apiKey: cfg.apiKey }).listAgents()));
    } catch (e: any) {
      zeilen.push(`Agentenliste nicht abrufbar: ${describeError(e)}`);
    }
  }

  if (laufend) {
    zeilen.push(`Laufender Auftrag bei ${laufend.agentName ?? 'Cue'} seit ${laufend.startedAtIso}.`);
  } else if (status.ready) {
    const name = cachedAgentName(cfg.agentId);
    zeilen.push(name ? `Kein Auftrag aktiv (Agent ${name}).` : 'Kein Auftrag aktiv.');
  }

  zeilen.push(USAGE_CUE);
  return zeilen.join('\n\n');
}

/**
 * Die Owner-Nachricht mit dem Key aus dem Chat entfernen.
 * Best effort: fehlt die Nachrichten-ID oder scheitert der Aufruf, bekommt der
 * Owner einen Hinweis statt eines Fehlers.
 */
async function removeKeyMessage(chatId: string): Promise<boolean> {
  const messageId = lastInboundMessageId(chatId);
  if (!messageId || !deps.deleteTelegramMessage) return false;
  try {
    return await deps.deleteTelegramMessage(chatId, messageId);
  } catch (e: any) {
    deps.logger.warn(`[cue-setup] deleteMessage fehlgeschlagen: ${e?.message}`);
    return false;
  }
}

export function registerCueCommands(api: any): void {
  // /cue <text> — Text an den Cue-Agenten delegieren (Phase 1, experimentell)
  api.registerCommand({
    name: 'cue',
    description: 'Text an den Cue-Agenten delegieren. /cue <text>',
    acceptsArgs: true,
    handler: async (ctx: any) => {
      const guard = await deps.assertOwner(ctx);
      if (!guard.ok) {
        return { text: 'Dieser Befehl ist nur fuer den Owner verfuegbar.' };
      }

      const text = stripCommandPrefix(String(ctx?.args || ''));
      if (!text) {
        try {
          return { text: await buildCueStatusText() };
        } catch (e: any) {
          deps.logger.error(`[cue] Status nicht ermittelbar: ${e?.message}`);
          return { text: `cue Fehler: ${e?.message}` };
        }
      }

      try {
        const result = await startCueDelegation(text);
        if (!result.ok) deps.logger.info(`[cue] /cue abgewiesen (${result.kind})`);
        return { text: result.message };
      } catch (e: any) {
        deps.logger.error(`[cue] Fehler: ${e?.message}`);
        return { text: `cue Fehler: ${e?.message}` };
      }
    },
  });

  // /cue_setup <api-key> [<agent_id>] — Einrichtung in einem Zug.
  //
  // Reihenfolge mit Bedacht: zuerst einrichten, dann **sofort** die
  // Owner-Nachricht mit dem Key loeschen, erst danach antworten. So steht der
  // Key so kurz wie moeglich im Chat.
  api.registerCommand({
    name: 'cue_setup',
    description: 'Cue-Delegation einrichten. /cue_setup <api-key> [<agent_id>]',
    acceptsArgs: true,
    handler: async (ctx: any) => {
      const guard = await deps.assertOwner(ctx);
      if (!guard.ok) {
        return { text: 'Dieser Befehl ist nur fuer den Owner verfuegbar.' };
      }

      const teile = stripCommandPrefix(String(ctx?.args || '')).split(/\s+/).filter(Boolean);
      if (teile.length === 0) {
        return { text: USAGE_SETUP };
      }
      if (teile.length > 2) {
        return { text: `Zu viele Angaben.\n${USAGE_SETUP}` };
      }

      const [apiKey, agentId] = teile;

      let result;
      try {
        result = await runCueSetup({ apiKey, agentId });
      } catch (e: any) {
        // describeError raeumt Key-Material aus Fehlertexten der Gegenseite.
        const msg = describeError(e);
        deps.logger.error(`[cue-setup] fehlgeschlagen: ${msg}`);
        await removeKeyMessage(guard.chatId);
        return { text: `Einrichtung fehlgeschlagen: ${msg}` };
      }

      const geloescht = await removeKeyMessage(guard.chatId);

      await writeCueAuditEntry('cue.setup', result.agentId ?? 'unresolved', {
        status: result.status,
        label: result.agentName ?? null,
        env_written: result.envWritten,
        key_message_deleted: geloescht,
      });

      const hinweis = geloescht
        ? ''
        : '\n\nHinweis: die Nachricht mit dem Key konnte nicht automatisch geloescht werden — '
          + 'bitte manuell entfernen.';

      if (result.status !== 'ok') {
        deps.logger.info(`[cue-setup] Ergebnis: ${result.status}`);
        return { text: `${result.message}${hinweis}` };
      }

      // Machbarkeitsnachweis gleich mitlaufen lassen.
      const test = await startCueDelegation(CUE_SETUP_TEST_PROMPT);
      deps.logger.info(`[cue-setup] eingerichtet, Testauftrag ${test.ok ? 'gestartet' : `nicht gestartet (${test.kind})`}`);

      const testZeile = test.ok
        ? 'Testauftrag laeuft — Ergebnis folgt als eigene Nachricht.'
        : `Testauftrag nicht gestartet: ${test.message}`;

      return { text: `${result.message} ${testZeile}${hinweis}` };
    },
  });
}

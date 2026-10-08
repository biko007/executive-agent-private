/**
 * cue-delegation/commands — Telegram-Command /cue.
 *
 * Commands: /cue <text>
 *
 * Owner-only ueber den Binding-Guard (assertBoundOwner wird aus index.ts
 * injiziert — derselbe Weg wie /do und /arm). Ohne gueltige Bindung passiert
 * nichts ausser der Abweisung.
 *
 * Diese Datei muss `src/modules/<name>/commands.ts` heissen, damit
 * `npm run verify:commands` den Handler findet (scripts/verify-commands.ts).
 */
import { createManusClient } from './manus-client.js';
import { cueStatus, cueStatusText, loadCueConfig } from './config.js';
import { activeCueDelegation, describeError, shortTaskRef, startCueDelegation } from './delegation.js';

export interface CueCommandDeps {
  /** Binding-Guard aus index.ts: true nur fuer den gebundenen Owner. */
  assertOwner: (ctx: any) => Promise<boolean>;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

let deps: CueCommandDeps;

export function initCueCommands(d: CueCommandDeps): void {
  deps = d;
}

const USAGE = 'Nutzung: /cue <text> — der Text geht unveraendert an den Cue-Agenten.';

/**
 * Statusauskunft fuer `/cue` ohne Argument.
 *
 * Fehlt nur die agent_id, aber der Key ist eingetragen, werden die verfuegbaren
 * Agenten gelistet (nur lesender Aufruf) — damit der Owner die ID ohne Umweg
 * ueber die Weboberflaeche findet. Es werden nur Schluesselnamen genannt,
 * niemals Werte (C5).
 */
export async function buildCueStatusText(): Promise<string> {
  const cfg = loadCueConfig();
  const status = cueStatus(cfg);
  const laufend = activeCueDelegation();
  const zeilen: string[] = [cueStatusText(status)];

  if (status.reason === 'no_agent') {
    try {
      const agenten = await createManusClient({ apiKey: cfg.apiKey }).listAgents();
      zeilen.push(
        agenten.length
          ? ['Verfuegbare Agenten (agent_id — Name):', ...agenten.map((a) => `  ${a.id} — ${a.nickname ?? '(ohne Namen)'}`)].join('\n')
          : 'Die Manus-Antwort enthielt keine Agenten.',
      );
    } catch (e: any) {
      zeilen.push(`Agentenliste nicht abrufbar: ${describeError(e)}`);
    }
  }

  if (laufend) {
    zeilen.push(
      `Laufender Auftrag seit ${laufend.startedAtIso}` +
        (laufend.taskId ? ` (Task ${shortTaskRef(laufend.taskId)})` : ''),
    );
  } else if (status.ready) {
    zeilen.push('Kein Auftrag aktiv.');
  }

  zeilen.push(USAGE);
  return zeilen.join('\n\n');
}

export function registerCueCommands(api: any): void {
  // /cue <text> — Text an den Cue-Agenten delegieren (Phase 1, experimentell)
  api.registerCommand({
    name: 'cue',
    description: 'Text an den Cue-Agenten delegieren. /cue <text>',
    acceptsArgs: true,
    handler: async (ctx: any) => {
      const erlaubt = await deps.assertOwner(ctx);
      if (!erlaubt) {
        return { text: 'Dieser Befehl ist nur fuer den Owner verfuegbar.' };
      }

      const text = String(ctx?.args || '').trim();
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
}

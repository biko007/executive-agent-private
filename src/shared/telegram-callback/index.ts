/**
 * Telegram Callback Event Parser — Framework v2026.2 Migration Helper
 *
 * Framework v2026.2.14 changed callback delivery:
 *   Old: event.raw.callback_query  (full Telegram callback object)
 *   New: event.content             (synthetic text = callback_data string)
 *
 * Seit einer spaeteren Framework-Fassung liefert der Kanal den Klick nicht mehr
 * als blanke `callback_data`, sondern als Satz: `callback_data: <prefix>_<payload>`
 * (belegt in `conversation_log` und im Gateway-Protokoll: "Inbound message … 28 chars"
 * fuer `callback_data: bweekly_start`). Der command-guard erkannte diese Form
 * bereits und unterdrueckte den KI-Agenten; dieser Parser erkannte sie nicht und
 * gab `null` zurueck — jeder Knopf war damit folgenlos. `unwrapCallbackContent`
 * schaelt die Huelle ab und behandelt beide Formen gleich.
 *
 * Usage (before):
 *   const cbq = event?.raw?.callback_query;
 *   if (!cbq) return;
 *   const data = String(cbq.data || '');
 *   if (data.startsWith('icraft_')) { ... }
 *
 * Usage (after):
 *   const cb = parseCallbackEvent(event, 'icraft');
 *   if (!cb) return;
 *   // cb.payload = 'jb-1805-1xkk::ja', cb.args = ['jb-1805-1xkk', 'ja']
 *
 * Note: answerCallbackQuery is no longer needed — the framework
 * answers immediately with an empty response before dispatching.
 */

export interface CallbackEvent {
  /** Matched prefix (e.g. 'icraft', 'iscan', 'booking') */
  prefix: string;
  /** Raw payload after prefix_ (e.g. 'jb-1805-1xkk::ja') */
  payload: string;
  /** Payload split by '::' (e.g. ['jb-1805-1xkk', 'ja']) */
  args: string[];
  /** Sender ID from event.metadata.senderId (empty string if missing) */
  senderId: string;
  /** Chat ID from explicit chat metadata only; empty when the gateway omits it. */
  chatId: string;
  /** Knopfinhalt ohne Transporthuelle (z. B. 'bweekly_start') */
  content: string;
}

/**
 * Schaelt die Transporthuelle vom Knopfinhalt ab.
 *
 * Erkannte Formen (in dieser Reihenfolge):
 *   1. `bweekly_start`                                   → unveraendert
 *   2. `callback_data: bweekly_start`                    → `bweekly_start`
 *   3. `[Telegram jb 12:00] callback_data: bweekly_start`→ `bweekly_start`
 *   4. `[Telegram jb 12:00] bweekly_start`               → `bweekly_start`
 *
 * Rueckgabe ist immer getrimmt. Enthaelt der Rest noch Leerzeichen (ein echter
 * Chatsatz), bleibt er unberuehrt — `parseCallbackEvent` verwirft ihn dann ueber
 * die Praefixpruefung.
 */
export function unwrapCallbackContent(content: string): string {
  let rest = content.trim();

  // Fuehrende Hüllenklammer des Frameworks: "[Telegram <name> <zeit>] …"
  const bracket = rest.match(/^\[[^\]]*\]\s*/);
  if (bracket) rest = rest.slice(bracket[0].length).trim();

  // Schlüsselwortform: "callback_data: <daten>"
  const keyed = rest.match(/^callback_data\s*:\s*/i);
  if (keyed) rest = rest.slice(keyed[0].length).trim();

  return rest;
}

export function parseCallbackEvent(
  event: { content?: string; metadata?: Record<string, unknown> },
  prefix: string,
): CallbackEvent | null {
  const raw = event?.content;
  if (typeof raw !== 'string') return null;
  const content = unwrapCallbackContent(raw);

  const marker = `${prefix}_`;
  if (!content.startsWith(marker)) return null;

  const payload = content.slice(marker.length);
  const args = payload.split('::');
  const senderId = String(event.metadata?.senderId ?? '');
  const chatId = String(
    event.metadata?.chatId ??
    event.metadata?.threadId ??
    event.metadata?.conversationId ??
    event.metadata?.channelId ??
    '',
  ).replace(/^telegram:/, '').trim();

  return { prefix, payload, args, senderId, chatId, content };
}

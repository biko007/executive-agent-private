/**
 * Telegram Callback Event Parser — Framework v2026.2 Migration Helper
 *
 * Framework v2026.2.14 changed callback delivery:
 *   Old: event.raw.callback_query  (full Telegram callback object)
 *   New: event.content             (synthetic text = callback_data string)
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
  /** Original event.content (full callback_data string) */
  content: string;
}

export function parseCallbackEvent(
  event: { content?: string; metadata?: Record<string, unknown> },
  prefix: string,
): CallbackEvent | null {
  const content = event?.content;
  if (typeof content !== 'string') return null;

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

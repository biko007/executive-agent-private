/**
 * memory/store — Conversation turn persistence (Message-Sink)
 *
 * Fire-and-forget writer for conversation_log table.
 * Caller is responsible for try/catch — this module throws on DB errors.
 */
import { query } from '../../shared/db/index.js';

export interface ConversationTurn {
  senderId: string;
  userText: string;
  agentText: string | null;
  sessionKey: string | null;
  channel?: string;
  metadata?: Record<string, unknown> | null;
}

export async function insertConversationTurn(turn: ConversationTurn): Promise<void> {
  await query(
    `INSERT INTO conversation_log
       (sender_id, user_text, agent_text, session_key, channel, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      turn.senderId,
      turn.userText,
      turn.agentText,
      turn.sessionKey,
      turn.channel ?? 'telegram',
      turn.metadata ? JSON.stringify(turn.metadata) : null,
    ],
  );
}

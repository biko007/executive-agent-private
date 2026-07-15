import crypto from 'node:crypto';
import { getClient, query } from '../../shared/db/index.js';

export type TelegramBindingRole = 'operativ' | 'dev';
export type TelegramBindingStatus = 'pending_verification' | 'active' | 'disabled';

export interface TelegramBinding {
  bindingId: string;
  workspaceKey: string;
  botKey: string;
  roleTag: TelegramBindingRole;
  telegramChatId: string | null;
  telegramUserId: string | null;
  chatType: string | null;
  status: TelegramBindingStatus;
  nonceExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PendingBinding {
  bindingId: string;
  nonce: string;
  roleTag: TelegramBindingRole;
  expiresAt: Date;
}

export class TelegramBindingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'TelegramBindingError';
  }
}

function normalizeTelegramId(value: unknown): string {
  return String(value ?? '').replace(/^telegram:/, '').trim();
}

export function extractTelegramIdentity(ctxOrEvent: any): { chatId: string; userId: string; chatType: string } {
  const metadata = ctxOrEvent?.metadata ?? {};
  const chat = ctxOrEvent?.chat ?? metadata.chat ?? {};
  const chatId = normalizeTelegramId(
    ctxOrEvent?.chatId ??
    chat?.id ??
    metadata.chatId ??
    metadata.threadId ??
    ctxOrEvent?.threadId ??
    ctxOrEvent?.conversationId ??
    ctxOrEvent?.channelId ??
    metadata.senderId ??
    ctxOrEvent?.senderId,
  );
  const userId = normalizeTelegramId(
    ctxOrEvent?.senderId ??
    ctxOrEvent?.from?.id ??
    metadata.senderId ??
    metadata.fromId ??
    ctxOrEvent?.channelId,
  );
  const rawChatType = String(ctxOrEvent?.chatType ?? chat?.type ?? metadata.chatType ?? 'private');
  const chatType = rawChatType === 'group' || rawChatType === 'supergroup' ? rawChatType : 'private';
  return { chatId, userId, chatType };
}

function mapRow(row: Record<string, unknown>): TelegramBinding {
  return {
    bindingId: String(row.binding_id),
    workspaceKey: String(row.workspace_key),
    botKey: String(row.bot_key),
    roleTag: row.role_tag as TelegramBindingRole,
    telegramChatId: row.telegram_chat_id ? String(row.telegram_chat_id) : null,
    telegramUserId: row.telegram_user_id ? String(row.telegram_user_id) : null,
    chatType: row.chat_type ? String(row.chat_type) : null,
    status: row.status as TelegramBindingStatus,
    nonceExpiresAt: row.nonce_expires_at ? new Date(String(row.nonce_expires_at)) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function hashNonce(nonce: string): string {
  return crypto.createHash('sha256').update(nonce).digest('hex');
}

function makeBindingId(): string {
  return `tgb-${crypto.randomBytes(6).toString('base64url').toLowerCase()}`;
}

function makeNonce(): string {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

export async function createPendingTelegramBinding(roleTag: TelegramBindingRole): Promise<PendingBinding> {
  const bindingId = makeBindingId();
  const nonce = makeNonce();
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await query(
    `INSERT INTO workspace_telegram_bindings
       (binding_id, workspace_key, bot_key, role_tag, verification_nonce_hash, nonce_expires_at, status)
     VALUES ($1, 'bikosoc', 'default', $2, $3, $4, 'pending_verification')`,
    [bindingId, roleTag, hashNonce(nonce), expiresAt],
  );
  return { bindingId, nonce, roleTag, expiresAt };
}

export async function activateTelegramBinding(params: {
  nonce: string;
  chatId: string;
  userId: string;
  chatType: string;
}): Promise<TelegramBinding> {
  const nonceHash = hashNonce(params.nonce);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE workspace_telegram_bindings
          SET status = 'active',
              telegram_chat_id = $2,
              telegram_user_id = $3,
              chat_type = $4,
              verification_nonce_hash = NULL,
              nonce_expires_at = NULL
        WHERE bot_key = 'default'
          AND verification_nonce_hash = $1
          AND status = 'pending_verification'
          AND nonce_expires_at > NOW()
        RETURNING *`,
      [nonceHash, params.chatId, params.userId, params.chatType],
    );
    if (rows.length === 0) {
      throw new TelegramBindingError('Nonce mismatch or expired', 'NONCE_MISMATCH');
    }
    await client.query(
      `INSERT INTO audit_log
         (actor, module, action, entity_type, entity_id, after_jsonb, source)
       VALUES ($1, 'telegram-binding', 'binding.activated', 'workspace_telegram_binding', $2, $3::jsonb, 'telegram')`,
      [
        `telegram:${params.userId}`,
        rows[0].binding_id,
        JSON.stringify({ role_tag: rows[0].role_tag, chat_type: params.chatType }),
      ],
    );
    await client.query('COMMIT');
    return mapRow(rows[0] as Record<string, unknown>);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.code === '23505') {
      throw new TelegramBindingError('Telegram chat already bound', 'BINDING_CONFLICT');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function getActiveTelegramBinding(chatId: string): Promise<TelegramBinding | null> {
  if (!chatId) return null;
  const { rows } = await query(
    `SELECT * FROM workspace_telegram_bindings
      WHERE bot_key = 'default' AND telegram_chat_id = $1 AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [chatId],
  );
  return rows[0] ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function isBoundTelegramOwner(chatId: string, userId: string): Promise<boolean> {
  const binding = await getActiveTelegramBinding(chatId);
  return Boolean(binding?.telegramUserId && binding.telegramUserId === userId);
}

export async function listActiveTelegramBindings(roleTag?: TelegramBindingRole): Promise<TelegramBinding[]> {
  const params: unknown[] = [];
  let roleSql = '';
  if (roleTag) {
    params.push(roleTag);
    roleSql = ` AND role_tag = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT * FROM workspace_telegram_bindings
      WHERE bot_key = 'default' AND status = 'active'${roleSql}
      ORDER BY role_tag, updated_at DESC`,
    params,
  );
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function listActiveTelegramOwnerUserIds(): Promise<string[]> {
  const { rows } = await query<{ telegram_user_id: string }>(
    `SELECT DISTINCT telegram_user_id
       FROM workspace_telegram_bindings
      WHERE bot_key = 'default'
        AND status = 'active'
        AND telegram_user_id IS NOT NULL
      ORDER BY telegram_user_id`,
  );
  return rows.map((row) => row.telegram_user_id);
}

-- Migration 043: Telegram binding targets for owner guard and delivery roles.
-- Boot-Time-DDL: idempotent, automatically applied by gateway startup.

CREATE TABLE IF NOT EXISTS workspace_telegram_bindings (
  binding_id               TEXT PRIMARY KEY,
  workspace_key            TEXT NOT NULL DEFAULT 'bikosoc',
  bot_key                  TEXT NOT NULL DEFAULT 'default',
  role_tag                 TEXT NOT NULL CHECK (role_tag IN ('operativ', 'dev')),
  telegram_chat_id         TEXT,
  telegram_user_id         TEXT,
  chat_type                TEXT,
  verification_nonce_hash  TEXT,
  nonce_expires_at         TIMESTAMPTZ,
  status                   TEXT NOT NULL DEFAULT 'pending_verification'
                           CHECK (status IN ('pending_verification', 'active', 'disabled')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_tg_binding_active_fields CHECK (
    status != 'active' OR (
      telegram_chat_id IS NOT NULL AND
      telegram_user_id IS NOT NULL AND
      chat_type IS NOT NULL
    )
  ),
  CONSTRAINT chk_tg_binding_pending_fields CHECK (
    status != 'pending_verification' OR (
      verification_nonce_hash IS NOT NULL AND
      nonce_expires_at IS NOT NULL
    )
  ),
  CONSTRAINT chk_tg_binding_chat_id_format CHECK (
    telegram_chat_id IS NULL OR telegram_chat_id ~ '^-?[0-9]+$'
  ),
  CONSTRAINT chk_tg_binding_user_id_format CHECK (
    telegram_user_id IS NULL OR telegram_user_id ~ '^[0-9]+$'
  ),
  CONSTRAINT chk_tg_binding_chat_type CHECK (
    chat_type IS NULL OR chat_type IN ('private', 'group', 'supergroup')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_binding_bot_chat_active
  ON workspace_telegram_bindings (bot_key, telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_tg_binding_role_active
  ON workspace_telegram_bindings (bot_key, role_tag, status);

CREATE INDEX IF NOT EXISTS idx_tg_binding_nonce_pending
  ON workspace_telegram_bindings (bot_key, verification_nonce_hash)
  WHERE status = 'pending_verification';

CREATE OR REPLACE FUNCTION set_workspace_telegram_bindings_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_workspace_telegram_bindings_updated_at ON workspace_telegram_bindings;
CREATE TRIGGER trg_workspace_telegram_bindings_updated_at
  BEFORE UPDATE ON workspace_telegram_bindings
  FOR EACH ROW EXECUTE FUNCTION set_workspace_telegram_bindings_updated_at();

INSERT INTO schema_version (module, version)
VALUES ('telegram-binding', 43)
ON CONFLICT DO NOTHING;

-- V027__banking_tables.sql — Sprint 7b Banking Foundation
-- 4 new tables: banking_institutions, banking_accounts, banking_transactions, banking_sessions
-- set_updated_at() trigger on all 4 tables (function exists from V023)

-- ════════════════════════════════════════════════════════════════════════════
-- 0. Guard: ensure set_updated_at() exists (idempotent)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Banking Institutions
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS banking_institutions (
  id              BIGSERIAL PRIMARY KEY,
  blz             VARCHAR(8) NOT NULL UNIQUE,
  name            VARCHAR(200) NOT NULL,
  bic             VARCHAR(20),
  fints_url       TEXT NOT NULL,
  country         CHAR(2) NOT NULL DEFAULT 'DE',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Banking Accounts
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS banking_accounts (
  id              BIGSERIAL PRIMARY KEY,
  institution_id  BIGINT NOT NULL REFERENCES banking_institutions(id) ON DELETE RESTRICT,
  iban            VARCHAR(34) NOT NULL UNIQUE,
  account_number  VARCHAR(20),
  account_type    VARCHAR(50),
  display_name    VARCHAR(100) NOT NULL,
  owner_name      VARCHAR(200),
  currency        CHAR(3) NOT NULL DEFAULT 'EUR',
  current_balance NUMERIC(12,2),
  last_sync_at    TIMESTAMPTZ,
  status          TEXT NOT NULL CHECK (status IN ('active', 'archived')) DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_banking_accounts_institution_status
  ON banking_accounts(institution_id, status);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Banking Transactions
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS banking_transactions (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            BIGINT NOT NULL REFERENCES banking_accounts(id) ON DELETE CASCADE,
  bank_transaction_id   VARCHAR(100) NOT NULL,
  booking_date          DATE NOT NULL,
  value_date            DATE,
  amount                NUMERIC(12,2) NOT NULL,
  currency              CHAR(3) NOT NULL,
  counterparty_name     VARCHAR(200),
  counterparty_iban     VARCHAR(34),
  reference             TEXT,
  transaction_code      VARCHAR(20),
  raw_payload           JSONB NOT NULL,
  imported_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, bank_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_banking_transactions_account_date
  ON banking_transactions(account_id, booking_date DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Banking Sessions
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS banking_sessions (
  id                        BIGSERIAL PRIMARY KEY,
  institution_id            BIGINT NOT NULL REFERENCES banking_institutions(id) ON DELETE RESTRICT,
  user_id_encrypted         TEXT NOT NULL,
  pin_encrypted             TEXT NOT NULL,
  key_version               SMALLINT NOT NULL DEFAULT 1,
  tan_medium_name           VARCHAR(100),
  product_id                VARCHAR(50) NOT NULL,
  session_state_encrypted   BYTEA,
  session_format            VARCHAR(50),
  fints_lib_version         VARCHAR(20),
  session_expires_at        TIMESTAMPTZ,
  last_success_at           TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_banking_sessions_institution
  ON banking_sessions(institution_id);

-- ════════════════════════════════════════════════════════════════════════════
-- TRIGGERS: set_updated_at() for all 4 tables
-- ════════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_banking_institutions_updated_at ON banking_institutions;
CREATE TRIGGER trg_banking_institutions_updated_at
  BEFORE UPDATE ON banking_institutions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_banking_accounts_updated_at ON banking_accounts;
CREATE TRIGGER trg_banking_accounts_updated_at
  BEFORE UPDATE ON banking_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_banking_transactions_updated_at ON banking_transactions;
CREATE TRIGGER trg_banking_transactions_updated_at
  BEFORE UPDATE ON banking_transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_banking_sessions_updated_at ON banking_sessions;
CREATE TRIGGER trg_banking_sessions_updated_at
  BEFORE UPDATE ON banking_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Record migration ────────────────────────────────────────────────────────
INSERT INTO schema_version (module, version) VALUES ('banking', 27)
  ON CONFLICT (module, version) DO NOTHING;

/**
 * banking/types — Domain types for the Banking module.
 * Sprint 7b Etappe c: DB row types for 4 banking tables (V027).
 */

// ── Domain types ──────────────────────────────────────────────────────────────

export interface Institution {
  id: number;
  blz: string;
  name: string;
  bic: string | null;
  fintsUrl: string;
  country: string;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: number;
  institutionId: number;
  iban: string;
  accountNumber: string | null;
  accountType: string | null;
  displayName: string;
  ownerName: string | null;
  currency: string;
  currentBalance: number | null;
  lastSyncAt: string | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface Transaction {
  id: number;
  accountId: number;
  bankTransactionId: string;
  bookingDate: string;
  valueDate: string | null;
  amount: number;
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  reference: string | null;
  transactionCode: string | null;
  rawPayload: Record<string, unknown>;
  importedAt: string;
}

/**
 * Session domain type — metadata only.
 * Intentionally EXCLUDES cleartext/encrypted credential fields.
 * NOTE: pendingChallengeMessage and pendingChallengeState are NOT exposed
 * in the domain type — access via store functions only.
 */
export interface Session {
  id: number;
  institutionId: number;
  keyVersion: number;
  tanMediumName: string | null;
  productId: string;
  sessionFormat: string | null;
  fintsLibVersion: string | null;
  sessionExpiresAt: string | null;
  lastSuccessAt: string | null;
  pendingChallengeType: string | null;
  pendingChallengeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Decrypted session — returned ONLY by getDecryptedSession().
 * Contains cleartext credentials for sidecar use.
 */
export interface DecryptedSession {
  userId: string;
  pin: string;
  state: string | null;
}

/**
 * Encrypted payload envelope — all fields base64-encoded.
 */
export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

// ── DB Row types (internal to store, exported for test access) ────────────────

export interface InstitutionRow {
  id: number;
  blz: string;
  name: string;
  bic: string | null;
  fints_url: string;
  country: string;
  created_at: Date;
  updated_at: Date;
}

export interface AccountRow {
  id: number;
  institution_id: number;
  iban: string;
  account_number: string | null;
  account_type: string | null;
  display_name: string;
  owner_name: string | null;
  currency: string;
  current_balance: string | null; // NUMERIC(12,2) arrives as string from pg
  last_sync_at: Date | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionRow {
  id: number;
  account_id: number;
  bank_transaction_id: string;
  booking_date: Date;
  value_date: Date | null;
  amount: string; // NUMERIC(12,2) arrives as string from pg
  currency: string;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  reference: string | null;
  transaction_code: string | null;
  raw_payload: Record<string, unknown>;
  imported_at: Date;
}

export interface SessionRow {
  id: number;
  institution_id: number;
  user_id_encrypted: string;
  pin_encrypted: string;
  key_version: number;
  tan_medium_name: string | null;
  product_id: string;
  session_state_encrypted: Buffer | null;
  session_format: string | null;
  fints_lib_version: string | null;
  session_expires_at: Date | null;
  last_success_at: Date | null;
  pending_challenge_type: string | null;
  pending_challenge_message: string | null;
  pending_challenge_state: Buffer | null;
  pending_challenge_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Reusable session — returned by findReusableSession().
 * Contains decrypted client_data_b64 for sidecar session reuse.
 */
export interface ReusableSession {
  sessionId: number;
  clientDataB64: string;
  lastSuccessAt: string;
  sessionExpiresAt: string;
}

/**
 * Pending TAN challenge — returned by getPendingChallenge().
 * Contains encrypted sidecar dialog state (BYTEA from DB).
 */
export interface PendingChallenge {
  sessionId: number;
  type: string;
  message: string;
  /** Encrypted sidecar dialog state — BYTEA from DB */
  stateEncrypted: Buffer;
  challengeAt: string;
}

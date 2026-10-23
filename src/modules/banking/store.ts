/**
 * banking/store — Postgres-backed persistence for Banking module.
 * Sprint 7b Etappe c: CRUD for 4 banking tables with encryption.
 */
import crypto from 'node:crypto';
import { query as dbQuery, getClient } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';
import { getCorrelationId, getRequestId } from '../../shared/correlation/index.js';
import { getSetting } from '../../shared/settings/index.js';
import { encrypt, decrypt } from './encryption.js';
import type {
  Institution, InstitutionRow,
  Account, AccountRow,
  Transaction, TransactionRow,
  Session, SessionRow,
  DecryptedSession,
  EncryptedPayload,
  PendingChallenge,
  ReusableSession,
  SessionReuseContext,
} from './types.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

function ts(d: Date | string | null | undefined): string {
  if (!d) return new Date().toISOString();
  return new Date(d).toISOString();
}

function dateStr(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

/** Coerce BIGSERIAL string from pg driver to number. */
function num(v: number | string): number {
  return typeof v === 'string' ? parseInt(v, 10) : v;
}

function mapInstitution(row: InstitutionRow): Institution {
  return {
    id: num(row.id),
    blz: row.blz,
    name: row.name,
    bic: row.bic,
    fintsUrl: row.fints_url,
    country: row.country,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  };
}

function mapAccount(row: AccountRow): Account {
  return {
    id: num(row.id),
    institutionId: num(row.institution_id),
    iban: row.iban,
    accountNumber: row.account_number,
    accountType: row.account_type,
    displayName: row.display_name,
    ownerName: row.owner_name,
    currency: row.currency,
    currentBalance: row.current_balance ? parseFloat(row.current_balance) : null,
    lastSyncAt: row.last_sync_at ? ts(row.last_sync_at) : null,
    status: row.status as 'active' | 'archived',
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  };
}

function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: num(row.id),
    accountId: num(row.account_id),
    bankTransactionId: row.bank_transaction_id,
    bookingDate: dateStr(row.booking_date) || '',
    valueDate: dateStr(row.value_date),
    amount: parseFloat(row.amount),
    currency: row.currency,
    counterpartyName: row.counterparty_name,
    counterpartyIban: row.counterparty_iban,
    reference: row.reference,
    transactionCode: row.transaction_code,
    rawPayload: row.raw_payload,
    importedAt: ts(row.imported_at),
    source: row.source ?? 'fints',
  };
}

function mapSession(row: SessionRow): Session {
  return {
    id: num(row.id),
    institutionId: num(row.institution_id),
    keyVersion: row.key_version,
    tanMediumName: row.tan_medium_name,
    productId: row.product_id,
    sessionFormat: row.session_format,
    fintsLibVersion: row.fints_lib_version,
    sessionExpiresAt: row.session_expires_at ? ts(row.session_expires_at) : null,
    lastSuccessAt: row.last_success_at ? ts(row.last_success_at) : null,
    pendingChallengeType: row.pending_challenge_type ?? null,
    pendingChallengeAt: row.pending_challenge_at ? ts(row.pending_challenge_at) : null,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  };
}

// ── Institution CRUD ──────────────────────────────────────────────────────────

/**
 * Upsert an institution by BLZ. ON CONFLICT (blz) DO UPDATE.
 */
export async function upsertInstitution(
  blz: string,
  name: string,
  bic: string | null,
  fintsUrl: string,
  actor?: string,
): Promise<Institution> {
  const { rows } = await dbQuery<InstitutionRow>(
    `INSERT INTO banking_institutions (blz, name, bic, fints_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (blz) DO UPDATE SET
       name = EXCLUDED.name,
       -- vorhandene BIC behalten, wenn keine neue mitkommt (20.10.2026: das
       -- Formular sendet keine, die Volksbank-BIC wäre sonst verloren)
       bic = COALESCE(EXCLUDED.bic, banking_institutions.bic),
       fints_url = EXCLUDED.fints_url
     RETURNING *`,
    [blz, name, bic, fintsUrl],
  );

  await audit.log({
    module: 'banking', action: 'institution.upsert',
    entityType: 'banking_institution', entityId: blz,
    after: rows[0] as unknown as Record<string, unknown>,
  });

  return mapInstitution(rows[0]);
}

/**
 * List all institutions.
 */
export async function listInstitutions(): Promise<Institution[]> {
  const { rows } = await dbQuery<InstitutionRow>(
    'SELECT * FROM banking_institutions ORDER BY name',
  );
  return rows.map(mapInstitution);
}

// ── Session CRUD ──────────────────────────────────────────────────────────────

/**
 * Create a banking session with encrypted credentials.
 * Pattern: INSERT with placeholder → RETURNING id → encrypt with real sessionId → UPDATE.
 * All in a single transaction.
 */
export async function createSession(
  institutionId: number,
  userId: string,
  pin: string,
  productId: string,
  tanMedium?: string,
  actor?: string,
): Promise<Session> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // 1. INSERT with placeholder encrypted fields
    const { rows } = await client.query<SessionRow>(
      `INSERT INTO banking_sessions
         (institution_id, user_id_encrypted, pin_encrypted, product_id, tan_medium_name)
       VALUES ($1, '__placeholder__', '__placeholder__', $2, $3)
       RETURNING *`,
      [institutionId, productId, tanMedium || null],
    );
    const sessionId = String(rows[0].id);

    // 2. Encrypt with real session ID as AAD
    const encUserId = encrypt(userId, sessionId, 'user_id');
    const encPin = encrypt(pin, sessionId, 'pin');

    // 3. UPDATE with real encrypted values
    await client.query(
      `UPDATE banking_sessions
       SET user_id_encrypted = $1, pin_encrypted = $2
       WHERE id = $3`,
      [JSON.stringify(encUserId), JSON.stringify(encPin), rows[0].id],
    );

    await client.query('COMMIT');

    // Re-fetch after commit to get updated row
    const { rows: final } = await dbQuery<SessionRow>(
      'SELECT * FROM banking_sessions WHERE id = $1',
      [rows[0].id],
    );

    await audit.log({
      module: 'banking', action: 'session.create',
      entityType: 'banking_session', entityId: sessionId,
      after: { id: final[0].id, institution_id: final[0].institution_id, product_id: final[0].product_id },
    });

    return mapSession(final[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Update session state (encrypted FinTS dialog state).
 */
export async function updateSessionState(
  sessionId: number,
  state: string,
  format: string,
  libVersion: string,
  expiresAt?: string,
): Promise<void> {
  const sid = String(sessionId);
  const encState = encrypt(state, sid, 'state');
  const stateBuffer = Buffer.from(JSON.stringify(encState));

  await dbQuery(
    `UPDATE banking_sessions SET
       session_state_encrypted = $1,
       session_format = $2,
       fints_lib_version = $3,
       session_expires_at = $4,
       last_success_at = now()
     WHERE id = $5`,
    [stateBuffer, format, libVersion, expiresAt || null, sessionId],
  );
}

/**
 * Get a decrypted session — the ONLY cleartext path.
 * Parses JSON from TEXT/BYTEA columns and calls decrypt().
 */
export async function getDecryptedSession(sessionId: number): Promise<DecryptedSession | null> {
  const { rows } = await dbQuery<SessionRow>(
    'SELECT * FROM banking_sessions WHERE id = $1',
    [sessionId],
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  const sid = String(row.id);

  const encUserId: EncryptedPayload = JSON.parse(row.user_id_encrypted);
  const encPin: EncryptedPayload = JSON.parse(row.pin_encrypted);

  const userId = decrypt(encUserId, sid, 'user_id');
  const pin = decrypt(encPin, sid, 'pin');

  let state: string | null = null;
  if (row.session_state_encrypted) {
    const encState: EncryptedPayload = JSON.parse(row.session_state_encrypted.toString('utf-8'));
    state = decrypt(encState, sid, 'state');
  }

  return { userId, pin, state };
}

// ── Account CRUD ──────────────────────────────────────────────────────────────

/**
 * List accounts with optional filters.
 */
export async function listAccounts(
  filter?: { status?: string; institution_id?: number },
): Promise<Account[]> {
  let sql = 'SELECT * FROM banking_accounts WHERE 1=1';
  const params: unknown[] = [];

  if (filter?.status) {
    params.push(filter.status);
    sql += ` AND status = $${params.length}`;
  }
  if (filter?.institution_id) {
    params.push(filter.institution_id);
    sql += ` AND institution_id = $${params.length}`;
  }

  sql += ' ORDER BY display_name';
  const { rows } = await dbQuery<AccountRow>(sql, params);
  return rows.map(mapAccount);
}

/**
 * Upsert an account by IBAN. ON CONFLICT (iban) DO UPDATE.
 */
export async function upsertAccount(
  institutionId: number,
  iban: string,
  displayName: string,
  opts?: {
    accountNumber?: string;
    accountType?: string;
    ownerName?: string;
    currency?: string;
    currentBalance?: number;
    lastSyncAt?: string;
  },
  actor?: string,
): Promise<Account> {
  const { rows } = await dbQuery<AccountRow>(
    `INSERT INTO banking_accounts
       (institution_id, iban, account_number, account_type, display_name,
        owner_name, currency, current_balance, last_sync_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (iban) DO UPDATE SET
       display_name = COALESCE(banking_accounts.display_name, EXCLUDED.display_name),
       account_number = COALESCE(EXCLUDED.account_number, banking_accounts.account_number),
       account_type = COALESCE(EXCLUDED.account_type, banking_accounts.account_type),
       owner_name = COALESCE(EXCLUDED.owner_name, banking_accounts.owner_name),
       currency = COALESCE(EXCLUDED.currency, banking_accounts.currency),
       updated_at = NOW()
       -- intentionally NOT updated on re-connect: status, current_balance, last_sync_at (Sprint 2.10-B r4)
     RETURNING *`,
    [
      institutionId, iban,
      opts?.accountNumber || null, opts?.accountType || null,
      displayName, opts?.ownerName || null,
      opts?.currency || 'EUR',
      opts?.currentBalance ?? null, opts?.lastSyncAt || null,
    ],
  );

  await audit.log({
    module: 'banking', action: 'account.upsert',
    entityType: 'banking_account', entityId: iban,
    after: rows[0] as unknown as Record<string, unknown>,
  });

  return mapAccount(rows[0]);
}

/**
 * Benennt ein Konto um — Anzeigename und Inhaber.
 *
 * Eigene Funktion statt `upsertAccount`, weil dort `display_name` bewusst per
 * COALESCE erhalten bleibt: Ein erneutes Verbinden mit der Bank darf einen vom
 * Owner gesetzten Namen nicht wieder durch die IBAN ersetzen. Genau deshalb
 * braucht das Umbenennen einen getrennten, protokollierten Weg.
 *
 * IBAN, Status und Salden bleiben unberührt.
 */
export async function renameAccount(
  accountId: number,
  felder: { displayName?: string; ownerName?: string },
  actor?: string,
): Promise<Account | null> {
  const { rows: vorher } = await dbQuery<AccountRow>(
    'SELECT * FROM banking_accounts WHERE id = $1', [accountId],
  );
  if (vorher.length === 0) return null;

  const { rows } = await dbQuery<AccountRow>(
    `UPDATE banking_accounts
        SET display_name = COALESCE($2, display_name),
            owner_name   = COALESCE($3, owner_name),
            updated_at   = NOW()
      WHERE id = $1
      RETURNING *`,
    [accountId, felder.displayName ?? null, felder.ownerName ?? null],
  );

  await audit.log({
    actor,
    module: 'banking', action: 'account.rename',
    entityType: 'banking_account', entityId: String(accountId),
    before: { display_name: vorher[0].display_name, owner_name: vorher[0].owner_name },
    after: { display_name: rows[0].display_name, owner_name: rows[0].owner_name },
  });

  return mapAccount(rows[0]);
}

/**
 * Archive an account (soft delete).
 */
export async function archiveAccount(accountId: number, actor?: string): Promise<Account | null> {
  const { rows: before } = await dbQuery<AccountRow>(
    'SELECT * FROM banking_accounts WHERE id = $1',
    [accountId],
  );
  if (before.length === 0) return null;

  const { rows: after } = await dbQuery<AccountRow>(
    `UPDATE banking_accounts SET status = 'archived' WHERE id = $1 RETURNING *`,
    [accountId],
  );

  await audit.log({
    module: 'banking', action: 'account.archive',
    entityType: 'banking_account', entityId: String(accountId),
    before: before[0] as unknown as Record<string, unknown>,
    after: after[0] as unknown as Record<string, unknown>,
  });

  return mapAccount(after[0]);
}

/**
 * Delete an account (CASCADE deletes transactions).
 */
export async function deleteAccount(accountId: number, actor?: string): Promise<boolean> {
  const { rows: before } = await dbQuery<AccountRow>(
    'SELECT * FROM banking_accounts WHERE id = $1',
    [accountId],
  );
  if (before.length === 0) return false;

  await dbQuery('DELETE FROM banking_accounts WHERE id = $1', [accountId]);

  await audit.log({
    module: 'banking', action: 'account.delete',
    entityType: 'banking_account', entityId: String(accountId),
    before: before[0] as unknown as Record<string, unknown>,
  });

  return true;
}

// ── Bulk-Archive (Sprint 2.10-B) ─────────────────────────────────────────────

/**
 * Check if all account IDs belong to the same institution.
 * Returns the institution_id if uniform, null if mixed or empty.
 */
export async function getUniformInstitutionId(accountIds: number[]): Promise<number | null> {
  if (accountIds.length === 0) return null;
  const { rows } = await dbQuery<{ institution_id: string }>(
    'SELECT DISTINCT institution_id FROM banking_accounts WHERE id = ANY($1)',
    [accountIds],
  );
  if (rows.length !== 1) return null;
  return num(rows[0].institution_id);
}

/**
 * Bulk-archive accounts within a caller-owned transaction.
 * - Locks rows via SELECT ... FOR UPDATE (sorted IDs = deadlock prevention)
 * - Updates active → archived, skips already_archived and not_found
 * - Writes one audit_log row per archived account (inside TX)
 */
export async function bulkArchiveAccounts(
  client: import('pg').PoolClient,
  accountIds: number[],
  institutionId: number,
  actor: string,
): Promise<{ archived: { id: number; iban: string }[]; skipped: { id: number; iban: string | null; reason: string }[] }> {
  const sorted = [...accountIds].sort((a, b) => a - b);

  // Lock rows in sorted order to prevent deadlocks
  const { rows: locked } = await client.query<AccountRow>(
    `SELECT * FROM banking_accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
    [sorted],
  );

  const lockedMap = new Map(locked.map(r => [num(r.id), r]));

  // Update only active accounts — institution_id guard as defense-in-depth
  const activeIds = locked.filter(r => r.status === 'active').map(r => r.id);
  let updatedRows: AccountRow[] = [];
  if (activeIds.length > 0) {
    const { rows } = await client.query<AccountRow>(
      `UPDATE banking_accounts SET status = 'archived', updated_at = NOW()
       WHERE id = ANY($1) AND status = 'active' AND institution_id = $2 RETURNING *`,
      [activeIds, institutionId],
    );
    updatedRows = rows;
  }

  const updatedMap = new Map(updatedRows.map(r => [num(r.id), r]));

  const archived: { id: number; iban: string }[] = [];
  const skipped: { id: number; iban: string | null; reason: string }[] = [];

  for (const id of sorted) {
    const row = lockedMap.get(id);
    if (!row) {
      skipped.push({ id, iban: null, reason: 'not_found' });
      continue;
    }
    const updated = updatedMap.get(id);
    if (updated) {
      archived.push({ id: num(updated.id), iban: updated.iban });
      // Audit log per archived account — inside TX, with correlation context
      await client.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, before_jsonb, after_jsonb, correlation_id, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [actor, 'banking', 'account.bulk-archive', 'banking_account', String(id),
         JSON.stringify(row), JSON.stringify(updated),
         getCorrelationId(), getRequestId()],
      );
    } else {
      skipped.push({ id: num(row.id), iban: row.iban, reason: 'already_archived' });
    }
  }

  return { archived, skipped };
}

// ── Transaction CRUD ──────────────────────────────────────────────────────────

/**
 * Insert a transaction with dedup on (account_id, bank_transaction_id).
 * Returns null if duplicate (ON CONFLICT DO NOTHING).
 */
export async function insertTransaction(
  accountId: number,
  txData: {
    bank_transaction_id: string;
    booking_date: string;
    value_date?: string;
    amount: number;
    currency: string;
    counterparty_name?: string;
    counterparty_iban?: string;
    reference?: string;
    transaction_code?: string;
    raw_payload: Record<string, unknown>;
    /** Herkunft. Vorgabe 'fints' — die Synchronisierung setzt sie nicht. */
    source?: string;
  },
): Promise<Transaction | null> {
  const { rows } = await dbQuery<TransactionRow>(
    `INSERT INTO banking_transactions
       (account_id, bank_transaction_id, booking_date, value_date,
        amount, currency, counterparty_name, counterparty_iban,
        reference, transaction_code, raw_payload, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (account_id, bank_transaction_id) DO NOTHING
     RETURNING *`,
    [
      accountId, txData.bank_transaction_id,
      txData.booking_date, txData.value_date || null,
      txData.amount, txData.currency,
      txData.counterparty_name || null, txData.counterparty_iban || null,
      txData.reference || null, txData.transaction_code || null,
      JSON.stringify(txData.raw_payload), txData.source || 'fints',
    ],
  );

  if (rows.length === 0) return null; // dedup — already exists
  return mapTransaction(rows[0]);
}

/**
 * Ergebnis der Übernahme eines Umsatzes aus dem FinTS-Abgleich.
 *  - `neu`:             eingefügt
 *  - `umgeschluesselt`: vorhandene Buchung mit altem Schlüssel erkannt und auf
 *                       den neuen umgestellt (Übergang 20.10.2026)
 *  - `vorhanden`:       schon mit neuem Schlüssel gespeichert
 *  - `offen`:           nur im ersten Durchgang — noch nichts entschieden
 */
export type UebernahmeErgebnis = 'neu' | 'umgeschluesselt' | 'vorhanden' | 'offen';

export interface SyncUmsatz {
  bank_transaction_id: string;
  legacy_transaction_id?: string;
  booking_date: string;
  value_date?: string;
  amount: number;
  currency: string;
  counterparty_name?: string;
  counterparty_iban?: string;
  reference?: string;
  transaction_code?: string;
  raw_payload: Record<string, unknown>;
}

export interface UebernahmeBefund {
  ergebnis: UebernahmeErgebnis;
  id: number | null;
  /** id der PDF-Zeile, die als Dublette dieser FinTS-Zeile markiert wurde */
  pdfVerknuepft: number | null;
  /** mehrere gleichwertige PDF-Kandidaten — nicht verknüpft, zur Prüfung gemeldet */
  pdfMehrdeutig: boolean;
}

/* Texte für den Vergleich ohne Leerzeichen: Der Kontoauszug trennt Wörter an
   Zeilenenden unterschiedlich („Ihr E inkauf"). */
const OHNE_LEER = (spalte: string) => `regexp_replace(coalesce(${spalte}, ''), '\\s+', '', 'g')`;
const ohneLeer = (t: string | undefined) => String(t ?? '').replace(/\s+/g, '');

/** Umsatzdatum aus dem Zweck einer Kartenbuchung („…Umsatz vom 20.08.2026 Visa…“), sonst null. */
export function umsatzdatumAusZweck(zweck: string | null | undefined): string | null {
  const m = /Umsatz\s*vom\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(String(zweck ?? ''));
  if (!m) return null;
  // Ein unmögliches Datum („31.02.") darf die Übernahme nicht abbrechen — dann
  // gilt der Buchungstag wie bei Zeilen ohne Umsatzdatum.
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Sucht zur FinTS-Zeile `fintsId` die PDF-Zeile derselben Buchung und markiert
 * sie als Dublette. Läuft in der Transaktion des Aufrufers.
 *
 * Kandidaten: Kontoauszüge ('pdf_import', wie die Bereinigung in
 * mietforderungen.ts) und Kreditkartenabrechnungen ('kk_pdf_import', seit der
 * Zusammenführung der Kartenkonten 20.10.2026), gleicher Betrag, noch nicht
 * verknüpft. Datum: höchstens drei Tage Abstand zum Buchungstag; bei
 * Kartenabrechnungen das Umsatzdatum aus dem Zweck der Bankzeile, weil die
 * Bank Gutschriften mit bis zu drei Wochen Versatz bucht.
 *
 * Rangfolge: passende Gegenpartei, dann gleicher Zweck (Vertrags-, Rechnungs-
 * nummer — die PDF-Zeile trägt davor nur die IBAN), dann Datumsabstand, dann
 * Datum und id. ANLASS (23.10.2026): Bis dahin blieben gleichwertige
 * Kandidaten unverknüpft; fünf Allianz-Verträge zu je 30 € im Monat zählten
 * so doppelt. Jetzt wird paarweise verknüpft — jede FinTS-Zeile nimmt die
 * nächste freie PDF-Zeile. `pdfMehrdeutig` meldet, dass nur die Reihenfolge
 * entschied; die Summe stimmt dann trotzdem.
 */
async function verknuepfePdfZeile(
  client: { query: (sql: string, werte?: unknown[]) => Promise<{ rows: any[] }> },
  accountId: number,
  fintsId: number,
  tx: { amount: number; booking_date: string; counterparty_name?: string | null; reference?: string | null },
): Promise<{ pdfVerknuepft: number | null; pdfMehrdeutig: boolean }> {
  const gegenpartei = ohneLeer(tx.counterparty_name ?? undefined).toLowerCase().slice(0, 10);
  const zweck = ohneLeer(tx.reference ?? undefined).slice(0, 30);
  const kandidaten = await client.query(
    `SELECT id, passt, zweck_gleich, abstand FROM (
       SELECT id, booking_date,
              (length($5) >= 3 AND lower(left(${OHNE_LEER('counterparty_name')}, 10)) = $5) AS passt,
              (length($7) >= 10 AND strpos(${OHNE_LEER('reference')}, $7) > 0) AS zweck_gleich,
              CASE WHEN source = 'kk_pdf_import' AND $6::date IS NOT NULL THEN abs(booking_date - $6::date)
                   ELSE abs(booking_date - $4::date) END AS abstand
         FROM banking_transactions
        WHERE account_id = $1 AND source IN ('pdf_import', 'kk_pdf_import') AND duplicate_of IS NULL
          AND amount = $3 AND id <> $2) k
      WHERE abstand <= 3
      ORDER BY passt DESC, zweck_gleich DESC, abstand, booking_date, id
      LIMIT 2`,
    [accountId, fintsId, tx.amount, tx.booking_date, gegenpartei, umsatzdatumAusZweck(tx.reference), zweck],
  );
  const [erster, zweiter] = kandidaten.rows;
  if (!erster) return { pdfVerknuepft: null, pdfMehrdeutig: false };
  // Nur eine noch freie Zeile verknüpfen: Hat ein gleichzeitiger Lauf sie eben
  // genommen, bleibt diese FinTS-Zeile unverknüpft, statt jenen Partner zu überschreiben.
  const markiert = await client.query(
    'UPDATE banking_transactions SET duplicate_of = $2, updated_at = NOW() WHERE id = $1 AND duplicate_of IS NULL RETURNING id',
    [erster.id, fintsId],
  );
  if (markiert.rows.length === 0) return { pdfVerknuepft: null, pdfMehrdeutig: false };
  const pdfMehrdeutig = Boolean(zweiter) && zweiter.passt === erster.passt
    && zweiter.zweck_gleich === erster.zweck_gleich && Number(zweiter.abstand) === Number(erster.abstand);
  return { pdfVerknuepft: num(erster.id), pdfMehrdeutig };
}

/**
 * Nachträgliche Verknüpfung (Owner-Freigabe 23.10.2026): geht die FinTS-Zeilen
 * der Konten durch, auf die noch keine PDF-Zeile zeigt, ältester Buchungstag
 * zuerst, und verknüpft wie bei der Übernahme. `schreiben: false` ist ein
 * Trockenlauf — alles in einer Transaktion, die zurückgerollt wird.
 */
export async function verknuepfePdfNachtraeglich(
  accountIds: number[],
  schreiben: boolean,
): Promise<Array<{ kontoId: number; fintsId: number; pdfId: number; betrag: number; mehrdeutig: boolean }>> {
  const client = await getClient();
  let freigegeben = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT f.id, f.account_id, f.amount, f.booking_date::text AS booking_date, f.counterparty_name, f.reference
         FROM banking_transactions f
        WHERE f.account_id = ANY($1::bigint[]) AND f.source = 'fints'
          AND NOT EXISTS (SELECT 1 FROM banking_transactions p WHERE p.duplicate_of = f.id)
        ORDER BY f.booking_date, f.id`,
      [accountIds],
    );
    const ergebnis = [];
    for (const f of rows) {
      const r = await verknuepfePdfZeile(client, num(f.account_id), num(f.id), { ...f, amount: Number(f.amount) });
      if (r.pdfVerknuepft !== null) {
        ergebnis.push({ kontoId: num(f.account_id), fintsId: num(f.id), pdfId: r.pdfVerknuepft, betrag: Number(f.amount), mehrdeutig: r.pdfMehrdeutig });
      }
    }
    await client.query(schreiben ? 'COMMIT' : 'ROLLBACK');
    return ergebnis;
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {});
    // Verbindung mit Fehler verwerfen statt in den Pool zurückgeben
    client.release(e);
    freigegeben = true;
    throw e;
  } finally {
    if (!freigegeben) client.release();
  }
}

/**
 * Übernimmt einen Umsatz aus dem FinTS-Abgleich — Nachfolger von
 * `insertTransaction` für den Sync. Aufrufer verwenden `uebernimmUmsaetze`,
 * das die zwei Durchgänge steuert.
 *
 * ANLASS (20.10.2026): Der alte Schlüssel des Sidecars (Datum + Betrag +
 * Buchungsart) war nicht eindeutig; zwei gleiche Gutschriften am selben Tag
 * wurden zu einer. Der Sidecar liefert jetzt einen eindeutigen Schlüssel (`v2_…`)
 * UND den alten (`legacy_transaction_id`). In einer Transaktion gilt:
 *
 *  1. Neuer Schlüssel schon da → `vorhanden`.
 *  2. FinTS-Zeile mit ALTEM Schlüssel da → auf den neuen umschlüsseln und die
 *     Texte aus dem frischen Abruf übernehmen → `umgeschluesselt`. Im ersten
 *     Durchgang (`nurTextgleich`) nur, wenn Verwendungszweck und Gegenpartei
 *     übereinstimmen — sonst könnte die Zeile von Buchung B (an der schon
 *     Zahlungszuordnungen hängen) auf Buchung A umgestellt werden.
 *  3. Sonst einfügen → `neu`. Steht dieselbe Buchung schon aus einem
 *     PDF-Import da, wird die PDF-Zeile als Dublette markiert — Regeln in
 *     `verknuepfePdfZeile` (seit 23.10.2026 paarweise; `pdfMehrdeutig` meldet,
 *     dass nur die Reihenfolge entschied).
 */
export async function uebernimmSynchronisiertenUmsatz(
  accountId: number,
  txData: SyncUmsatz,
  modus: 'nurTextgleich' | 'voll' = 'voll',
): Promise<UebernahmeBefund> {
  const client = await getClient();
  let freigegeben = false;
  try {
    await client.query('BEGIN');

    const vorhanden = await client.query<{ id: string }>(
      'SELECT id FROM banking_transactions WHERE account_id = $1 AND bank_transaction_id = $2',
      [accountId, txData.bank_transaction_id],
    );
    if (vorhanden.rows.length > 0) {
      await client.query('COMMIT');
      return { ergebnis: 'vorhanden', id: num(vorhanden.rows[0].id), pdfVerknuepft: null, pdfMehrdeutig: false };
    }

    if (txData.legacy_transaction_id && txData.legacy_transaction_id !== txData.bank_transaction_id) {
      const textBedingung = modus === 'nurTextgleich'
        ? `AND ${OHNE_LEER('reference')} = $10 AND ${OHNE_LEER('counterparty_name')} = $11`
        : '';
      const umgestellt = await client.query<{ id: string }>(
        `UPDATE banking_transactions
            SET bank_transaction_id = $3, value_date = $4, counterparty_name = $5,
                counterparty_iban = $6, reference = $7, transaction_code = $8,
                raw_payload = $9, updated_at = NOW()
          WHERE id = (SELECT id FROM banking_transactions
                       WHERE account_id = $1 AND bank_transaction_id = $2 AND source = 'fints'
                       ${textBedingung}
                       ORDER BY id LIMIT 1)
          RETURNING id`,
        [
          accountId, txData.legacy_transaction_id, txData.bank_transaction_id,
          txData.value_date || null, txData.counterparty_name || null,
          txData.counterparty_iban || null, txData.reference || null,
          txData.transaction_code || null, JSON.stringify(txData.raw_payload),
          ...(modus === 'nurTextgleich' ? [ohneLeer(txData.reference), ohneLeer(txData.counterparty_name)] : []),
        ],
      );
      if (umgestellt.rows.length > 0) {
        await client.query('COMMIT');
        return { ergebnis: 'umgeschluesselt', id: num(umgestellt.rows[0].id), pdfVerknuepft: null, pdfMehrdeutig: false };
      }
    }

    if (modus === 'nurTextgleich') {
      await client.query('COMMIT');
      return { ergebnis: 'offen', id: null, pdfVerknuepft: null, pdfMehrdeutig: false };
    }

    const eingefuegt = await client.query<{ id: string }>(
      `INSERT INTO banking_transactions
         (account_id, bank_transaction_id, booking_date, value_date,
          amount, currency, counterparty_name, counterparty_iban,
          reference, transaction_code, raw_payload, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'fints')
       ON CONFLICT (account_id, bank_transaction_id) DO NOTHING
       RETURNING id`,
      [
        accountId, txData.bank_transaction_id, txData.booking_date, txData.value_date || null,
        txData.amount, txData.currency, txData.counterparty_name || null,
        txData.counterparty_iban || null, txData.reference || null,
        txData.transaction_code || null, JSON.stringify(txData.raw_payload),
      ],
    );
    if (eingefuegt.rows.length === 0) {
      await client.query('COMMIT');
      return { ergebnis: 'vorhanden', id: null, pdfVerknuepft: null, pdfMehrdeutig: false };
    }
    const neueId = num(eingefuegt.rows[0].id);
    const { pdfVerknuepft, pdfMehrdeutig } = await verknuepfePdfZeile(client, accountId, neueId, txData);

    await client.query('COMMIT');
    return { ergebnis: 'neu', id: neueId, pdfVerknuepft, pdfMehrdeutig };
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {});
    // Verbindung mit Fehler verwerfen statt in den Pool zurückgeben
    client.release(e);
    freigegeben = true;
    throw e;
  } finally {
    if (!freigegeben) client.release();
  }
}

/**
 * Übernimmt alle Umsätze eines Abrufs in zwei Durchgängen (siehe oben):
 * erst die textgleichen Umschlüsselungen, dann der Rest. Liefert die Befunde
 * in der Reihenfolge der Eingabe.
 */
export async function uebernimmUmsaetze(accountId: number, umsaetze: SyncUmsatz[]): Promise<UebernahmeBefund[]> {
  const befunde: UebernahmeBefund[] = [];
  for (const tx of umsaetze) befunde.push(await uebernimmSynchronisiertenUmsatz(accountId, tx, 'nurTextgleich'));
  for (let i = 0; i < umsaetze.length; i++) {
    if (befunde[i].ergebnis === 'offen') befunde[i] = await uebernimmSynchronisiertenUmsatz(accountId, umsaetze[i], 'voll');
  }
  return befunde;
}

/**
 * List transactions for an account with optional date range and limit.
 */
export async function listTransactions(
  accountId: number,
  from?: string,
  to?: string,
  limit = 500,
): Promise<Transaction[]> {
  let sql = 'SELECT * FROM banking_transactions WHERE account_id = $1';
  const params: unknown[] = [accountId];

  if (from) {
    params.push(from);
    sql += ` AND booking_date >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    sql += ` AND booking_date <= $${params.length}`;
  }

  sql += ' ORDER BY booking_date DESC, id DESC';
  params.push(Math.min(limit, 500));
  sql += ` LIMIT $${params.length}`;

  const { rows } = await dbQuery<TransactionRow>(sql, params);
  return rows.map(mapTransaction);
}

/**
 * Umsaetze fuer die Anzeige — ohne Dubletten und mit ihrer Zuordnung.
 *
 * Warum eine eigene Funktion neben `listTransactions`: Die Anzeige braucht
 * zwei Dinge, die sonst niemand braucht, und `listTransactions` wird an anderer
 * Stelle unveraendert gebraucht.
 *
 *   1. JEDE BUCHUNG GENAU EINMAL. 40 Umsaetze stehen doppelt im Bestand — aus
 *      dem Kontoauszug nachgetragen und spaeter noch einmal von FinTS geliefert.
 *      Die unterlegene Zeile traegt seit V042 einen Verweis auf die fuehrende
 *      und wird hier weggelassen. Geloescht wird nichts.
 *   2. DIE ZUORDNUNG. Zu welchem Objekt, welcher Einheit, welchem Mieter und
 *      welchem Monat gehoert der Eingang? Steht nichts da, heisst das im
 *      Dashboard „nicht zugeordnet" — und nicht etwa nichts.
 */
/**
 * Wiederkehrende Eingaenge, die zu keinem Mietvertrag gehoeren.
 *
 * Der Owner will sie in der Umsatzanzeige benannt sehen, statt sie als
 * unbekannt stehen zu lassen — die drei Garagen Marktgasse 22 etwa gehoeren
 * nicht in die Mietforderungen, solange er die Zuordnung nicht entschieden
 * hat. Die Muster stehen in `system_settings` unter `kontozuordnung-hinweise`
 * und nicht im Code: Wird eine Garage angelegt, faellt der Hinweis weg, ohne
 * dass jemand eine Datei aendert.
 */
export interface Zuordnungshinweis {
  label?: string;
  muster?: { zweck?: string[]; name?: string[] };
}

/** Satzzeichen weg, Umlaute vereinheitlicht — „Marktg.22" trifft „marktg". */
function hinweisNormal(s: string | null | undefined): string {
  return String(s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Der Hinweis, der auf diesen Umsatz passt — oder null. */
export function hinweisFuer(
  hinweise: Record<string, Zuordnungshinweis>,
  name: string | null | undefined,
  zweck: string | null | undefined,
): string | null {
  const n = hinweisNormal(name);
  const z = hinweisNormal(zweck);
  for (const h of Object.values(hinweise || {})) {
    if (!h?.label || !h.muster) continue;
    const zTreffer = !h.muster.zweck?.length
      || h.muster.zweck.some(w => z.includes(hinweisNormal(w)));
    const nTreffer = !h.muster.name?.length
      || h.muster.name.some(w => n.includes(hinweisNormal(w)));
    if (zTreffer && nTreffer) return h.label;
  }
  return null;
}

export async function listTransactionsForDisplay(
  accountId: number,
  from?: string,
  to?: string,
  limit = 500,
): Promise<(Transaction & {
  duplicateOf: number | null;
  zuordnung: { objekt: string; einheit: string; mieter: string; monat: string; betrag: number }[];
  hinweis: string | null;
})[]> {
  const params: unknown[] = [accountId];
  let sql = `SELECT t.* FROM banking_transactions t
              WHERE t.account_id = $1 AND t.duplicate_of IS NULL`;
  if (from) { params.push(from); sql += ` AND t.booking_date >= $${params.length}`; }
  if (to) { params.push(to); sql += ` AND t.booking_date <= $${params.length}`; }
  sql += ' ORDER BY t.booking_date DESC, t.id DESC';
  params.push(Math.min(limit, 500));
  sql += ` LIMIT $${params.length}`;

  const { rows } = await dbQuery<TransactionRow>(sql, params);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => num(r.id));
  const { rows: zu } = await dbQuery<any>(`
    SELECT pl.transaction_id, pl.amount::float AS betrag,
           to_char(r.period_month,'YYYY-MM') AS monat,
           p.code AS objekt, u.code AS einheit,
           coalesce(string_agg(DISTINCT coalesce(t.company_name,
             trim(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,''))), ', '), '') AS mieter
      FROM rent_payment_links pl
      JOIN rent_ledger r ON r.id = pl.rent_ledger_id
      JOIN leases l ON l.id = r.lease_id
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN lease_tenants lt ON lt.lease_id = l.id
      LEFT JOIN tenants t ON t.id = lt.tenant_id
     WHERE pl.transaction_id = ANY($1::bigint[])
     GROUP BY pl.transaction_id, pl.amount, r.period_month, p.code, u.code
     ORDER BY r.period_month`, [ids]);

  const nachId = new Map<number, any[]>();
  for (const z of zu) {
    const liste = nachId.get(num(z.transaction_id)) || [];
    liste.push({ objekt: z.objekt, einheit: z.einheit, mieter: z.mieter || '—',
      monat: z.monat, betrag: z.betrag });
    nachId.set(num(z.transaction_id), liste);
  }

  const hinweise = await getSetting<Record<string, Zuordnungshinweis>>('kontozuordnung-hinweise')
    .catch(() => undefined) || {};

  return rows.map((r) => {
    const zuordnung = nachId.get(num(r.id)) || [];
    return {
      ...mapTransaction(r),
      duplicateOf: r.duplicate_of == null ? null : num(r.duplicate_of as any),
      zuordnung,
      /* Der Hinweis ersetzt keine Zuordnung — er erscheint nur, wo keine ist. */
      hinweis: zuordnung.length ? null
        : hinweisFuer(hinweise, r.counterparty_name, r.reference),
    };
  });
}

// ── Pending Challenge CRUD (Etappe d) ─────────────────────────────────────────

/**
 * Set a pending TAN challenge on a session.
 * Encrypts sidecarState using the same AAD pattern as updateSessionState.
 */
export async function setPendingChallenge(
  sessionId: number,
  type: string,
  message: string,
  sidecarState: string,
): Promise<void> {
  const sid = String(sessionId);
  const encState = encrypt(sidecarState, sid, 'pending_challenge_state');
  const stateBuffer = Buffer.from(JSON.stringify(encState));

  await dbQuery(
    `UPDATE banking_sessions SET
       pending_challenge_type = $1,
       pending_challenge_message = $2,
       pending_challenge_state = $3,
       pending_challenge_at = now()
     WHERE id = $4`,
    [type, message, stateBuffer, sessionId],
  );

  await audit.log({
    module: 'banking', action: 'session.challenge.set',
    entityType: 'banking_session', entityId: sid,
    after: { type, hasState: true },
  });
}

/**
 * Get the pending TAN challenge for a session.
 * Returns raw encrypted BYTEA — does NOT decrypt state here.
 */
export async function getPendingChallenge(sessionId: number): Promise<PendingChallenge | null> {
  const { rows } = await dbQuery<SessionRow>(
    'SELECT * FROM banking_sessions WHERE id = $1',
    [sessionId],
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  if (!row.pending_challenge_type) return null;

  return {
    sessionId: num(row.id),
    type: row.pending_challenge_type,
    message: row.pending_challenge_message || '',
    stateEncrypted: row.pending_challenge_state!,
    challengeAt: ts(row.pending_challenge_at),
  };
}

/**
 * Clear pending challenge from a session.
 */
export async function clearPendingChallenge(sessionId: number): Promise<void> {
  await dbQuery(
    `UPDATE banking_sessions SET
       pending_challenge_type = NULL,
       pending_challenge_message = NULL,
       pending_challenge_state = NULL,
       pending_challenge_at = NULL
     WHERE id = $1`,
    [sessionId],
  );

  await audit.log({
    module: 'banking', action: 'session.challenge.clear',
    entityType: 'banking_session', entityId: String(sessionId),
    after: null,
  });
}

/**
 * Expire old pending challenges (default: 10 minutes).
 * Returns the number of expired rows.
 */
export async function expireOldPendingChallenges(maxAgeMinutes = 10): Promise<number> {
  const { rowCount } = await dbQuery(
    `UPDATE banking_sessions SET
       pending_challenge_type = NULL,
       pending_challenge_message = NULL,
       pending_challenge_state = NULL,
       pending_challenge_at = NULL
     WHERE pending_challenge_at IS NOT NULL
       AND pending_challenge_at < now() - interval '1 minute' * $1`,
    [maxAgeMinutes],
  );

  const count = rowCount ?? 0;
  if (count > 0) {
    await audit.log({
      module: 'banking', action: 'session.challenge.expired',
      entityType: 'banking_session', entityId: 'bulk',
      after: { expiredCount: count, maxAgeMinutes },
    });
  }

  return count;
}

// ── Sync Engine Support (Etappe e) ──────────────────────────────────────────

/**
 * List active sessions — excludes sessions in pending-TAN state.
 */
/**
 * Sitzungen, die fuer einen Abgleich in Frage kommen — juengste zuerst.
 *
 * Befund E1 (07.10.2026): Die Reihenfolge war `ORDER BY id`, also AELTESTE
 * zuerst. Der Sync verarbeitet pro Institut nur die erste Sitzung
 * (`processedInstitutions`). Nach einem „Bank verbinden" lagen zwei Sitzungen
 * fuer dasselbe Institut vor: die alte mit dem Sitzungsstand des letzten
 * Abgleichs und die frische aus dem FinTS-Dialog. Der Abgleich griff immer zur
 * ALTEN und liess die gueltige liegen.
 *
 * Reihenfolge jetzt: letzter erfolgreicher Verbindungsaufbau, sonst letzte
 * Aenderung, zuletzt die Kennung — dieselbe Reihenfolge, die die Anzeige
 * „Verbindungsstand" im Dashboard verwendet.
 */
export async function listActiveSessions(): Promise<Session[]> {
  const { rows } = await dbQuery<SessionRow>(
    `SELECT * FROM banking_sessions
     WHERE institution_id IS NOT NULL
       AND pending_challenge_type IS NULL
     -- Sitzungen mit erfolgreicher Verbindung zuerst, darunter die juengste.
     -- Eine gescheiterte Neuverbindung (last_success_at NULL) darf die
     -- funktionierende Sitzung desselben Instituts nicht verdraengen — der
     -- Abgleich nimmt je Institut nur die erste (KSK-Sitzung 22, 23.10.2026).
     ORDER BY (last_success_at IS NULL), COALESCE(last_success_at, updated_at) DESC NULLS LAST, id DESC`,
  );
  return rows.map(mapSession);
}

/**
 * Targeted balance + lastSyncAt update for a single account.
 */
export async function updateAccountBalance(
  accountId: number,
  balance: number,
  lastSyncAt: string,
): Promise<void> {
  await dbQuery(
    `UPDATE banking_accounts SET current_balance = $1, last_sync_at = $2 WHERE id = $3`,
    [balance, lastSyncAt, accountId],
  );
}

/**
 * Check if a session-expiry reminder has already been sent for this threshold.
 */
export async function hasReminderBeenSent(
  sessionId: number,
  thresholdDays: number,
): Promise<boolean> {
  const { rows } = await dbQuery<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM banking_sync_reminders WHERE session_id = $1 AND threshold_days = $2`,
    [sessionId, thresholdDays],
  );
  return parseInt(rows[0].cnt, 10) > 0;
}

/**
 * Mark a session-expiry reminder as sent. Idempotent (ON CONFLICT DO NOTHING).
 */
export async function markReminderSent(
  sessionId: number,
  thresholdDays: number,
): Promise<void> {
  await dbQuery(
    `INSERT INTO banking_sync_reminders (session_id, threshold_days) VALUES ($1, $2) ON CONFLICT (session_id, threshold_days) DO NOTHING`,
    [sessionId, thresholdDays],
  );
}

/**
 * Clear all reminders for a session (e.g. after re-auth resets expiry).
 */
export async function clearReminders(sessionId: number): Promise<void> {
  await dbQuery(
    `DELETE FROM banking_sync_reminders WHERE session_id = $1`,
    [sessionId],
  );
}

// ── Session Reuse (Etappe 2.10a) ────────────────────────────────────────────

/**
 * Find a reusable session for an institution + user.
 *
 * Because user_id is stored encrypted (no plaintext column), we query by
 * institution_id + validity criteria, then decrypt and compare user_id in
 * code with constant-time comparison.
 */
export async function findReusableSession(
  institutionId: number,
  expectedUserId: string,
): Promise<ReusableSession | null> {
  const { rows } = await dbQuery<SessionRow>(
    `SELECT id, user_id_encrypted, session_state_encrypted,
            last_success_at, session_expires_at
     FROM banking_sessions
     WHERE institution_id = $1
       AND session_format = 'fints5'
       AND last_success_at IS NOT NULL
       AND last_success_at > NOW() - INTERVAL '30 days'
       AND session_expires_at > NOW()
       AND session_state_encrypted IS NOT NULL
     ORDER BY last_success_at DESC, id DESC
     LIMIT 5`,
    [institutionId],
  );

  let candidatesChecked = 0;

  for (const row of rows) {
    candidatesChecked++;
    const sid = String(row.id);

    // Decrypt user_id for comparison
    let decryptedUserId: string;
    try {
      decryptedUserId = decrypt(JSON.parse(row.user_id_encrypted), sid, 'user_id');
    } catch {
      await audit.log({
        module: 'banking', action: 'session.state.decrypt_failed',
        entityType: 'banking_session', entityId: sid,
        after: { field: 'user_id' },
      });
      await markSessionStateInvalid(num(row.id));
      continue;
    }

    // Constant-time comparison
    const a = Buffer.from(decryptedUserId);
    const b = Buffer.from(expectedUserId);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      continue;
    }

    // User matches — decrypt session state
    try {
      const encState: EncryptedPayload = JSON.parse(
        row.session_state_encrypted!.toString('utf-8'),
      );
      const clientDataB64 = decrypt(encState, sid, 'state');

      return {
        sessionId: num(row.id),
        clientDataB64,
        lastSuccessAt: ts(row.last_success_at),
        sessionExpiresAt: ts(row.session_expires_at),
      };
    } catch {
      await audit.log({
        module: 'banking', action: 'session.state.decrypt_failed',
        entityType: 'banking_session', entityId: sid,
        after: { field: 'state' },
      });
      await markSessionStateInvalid(num(row.id));
      continue;
    }
  }

  if (candidatesChecked > 0) {
    await audit.log({
      module: 'banking', action: 'session.user_mismatch',
      entityType: 'banking_session', entityId: String(institutionId),
      after: { institutionId, candidatesChecked },
    });
  }

  return null;
}

/**
 * Löst alle anderen Sitzungen eines Instituts ab, nachdem eine Sitzung
 * erfolgreich verbunden wurde.
 *
 * ANLASS (20.10.2026): Jedes „Bank verbinden" legte eine neue Sitzung an und
 * liess die alten aktiv stehen — für die KSK waren es drei. Abgelöst wird wie
 * bei der manuellen Stilllegung vom 22.06.2026 (Audit 721): `institution_id`
 * auf NULL; `listActiveSessions()` sieht die Sitzung dann nicht mehr. Die Zeile
 * bleibt erhalten, damit Audit und Erinnerungen nachvollziehbar bleiben.
 */
export async function loeseAndereSitzungenAb(institutionId: number, behalteSessionId: number): Promise<number[]> {
  const { rows } = await dbQuery<{ id: string }>(
    `UPDATE banking_sessions SET institution_id = NULL, updated_at = NOW()
      WHERE institution_id = $1 AND id <> $2
      RETURNING id`,
    [institutionId, behalteSessionId],
  );
  const ids = rows.map(r => num(r.id));
  if (ids.length > 0) {
    await audit.log({
      module: 'banking', action: 'session.deactivate',
      entityType: 'banking_session', entityId: ids.join(','),
      before: { session_ids: ids, institution_id: institutionId },
      after: { institution_id: null, abgeloest_durch: behalteSessionId, grund: 'neue Sitzung erfolgreich verbunden' },
    });
  }
  return ids;
}

/**
 * Mark a session's state as invalid by clearing last_success_at.
 * This removes it from the reusable-session candidate pool.
 */
export async function markSessionStateInvalid(sessionId: number): Promise<void> {
  await dbQuery(
    `UPDATE banking_sessions SET last_success_at = NULL WHERE id = $1`,
    [sessionId],
  );
  await audit.log({
    module: 'banking', action: 'session.state.marked_invalid',
    entityType: 'banking_session', entityId: String(sessionId),
    after: { lastSuccessAt: null },
  });
}

// ── Session Reuse Decision (Etappe 2.10c) ────────────────────────────────

/**
 * Compute a stable int32 lock key from userId + institutionId.
 * Used as the second argument to pg_advisory_lock(46, key).
 */
function sessionLockKey(userId: string, institutionId: number): number {
  const hash = crypto.createHash('sha256')
    .update(`${userId}:${institutionId}`)
    .digest();
  return hash.readInt32BE(0); // first 4 bytes as signed int32
}

/**
 * Decide whether to reuse an existing session or create a fresh one.
 *
 * Serialized per user+institution via pg_advisory_lock(46, key) to prevent
 * concurrent duplicate session creation. Uses a dedicated pool connection
 * for lock affinity.
 */
export async function decideReuse(
  institutionId: number,
  userId: string,
  pin: string,
  productId: string,
  tanMedium?: string,
  actor?: string,
): Promise<SessionReuseContext> {
  const lockKey = sessionLockKey(userId, institutionId);
  const lockClient = await getClient();

  await lockClient.query('SELECT pg_advisory_lock(46, $1::integer)', [lockKey]);

  try {
    const candidate = await findReusableSession(institutionId, userId);

    if (candidate) {
      await audit.log({
        module: 'banking', action: 'session.reuse_attempted',
        entityType: 'banking_session', entityId: String(candidate.sessionId),
        after: { lastSuccessAt: candidate.lastSuccessAt },
      });
      return {
        reuseMode: 'reuse',
        sessionId: candidate.sessionId,
        clientDataB64: candidate.clientDataB64,
      };
    }

    const session = await createSession(institutionId, userId, pin, productId, tanMedium, actor);
    return {
      reuseMode: 'fresh',
      sessionId: session.id,
      clientDataB64: null,
    };
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock(46, $1::integer)', [lockKey]).catch(() => {});
    lockClient.release();
  }
}

// ── Sync Runs (E0 scaffold) ────────────────────────────────────────────────

export async function insertSyncRun(params: {
  institutionId: number;
  runPhase: 'scheduled' | 'event_resync' | 'manual';
  triggerSource?: string;
  triggerId?: string;
}): Promise<number> {
  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO banking_sync_runs (institution_id, run_phase, trigger_source, trigger_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [params.institutionId, params.runPhase, params.triggerSource ?? null, params.triggerId ?? null],
  );
  return num(rows[0].id);
}

export async function updateSyncRun(runId: number, params: {
  status: string;
  scaRequired?: boolean;
  alertDelivered?: boolean;
  accountsSynced?: number;
  transactionsNew?: number;
  errorMessage?: string;
}): Promise<void> {
  await dbQuery(
    `UPDATE banking_sync_runs
     SET status = $2,
         sca_required = COALESCE($3, sca_required),
         alert_delivered = COALESCE($4, alert_delivered),
         accounts_synced = COALESCE($5, accounts_synced),
         transactions_new = COALESCE($6, transactions_new),
         error_message = COALESCE($7, error_message),
         finished_at = now()
     WHERE id = $1`,
    [
      runId,
      params.status,
      params.scaRequired ?? null,
      params.alertDelivered ?? null,
      params.accountsSynced ?? null,
      params.transactionsNew ?? null,
      params.errorMessage ?? null,
    ],
  );
}

// ── Circuit Breaker (E0 scaffold) ──────────────────────────────────────────

export async function getInstitutionSyncPauseStatus(institutionId: number): Promise<{
  syncPausedStatus: string | null;
  syncPausedSince: string | null;
}> {
  const { rows } = await dbQuery<{ sync_paused_status: string | null; sync_paused_since: string | null }>(
    'SELECT sync_paused_status, sync_paused_since FROM banking_institutions WHERE id = $1',
    [institutionId],
  );
  if (rows.length === 0) return { syncPausedStatus: null, syncPausedSince: null };
  return {
    syncPausedStatus: rows[0].sync_paused_status,
    syncPausedSince: rows[0].sync_paused_since ? new Date(rows[0].sync_paused_since).toISOString() : null,
  };
}

export async function setInstitutionSyncPaused(
  institutionId: number,
  status: 'AUTO_PAUSED_PENDING_TAN' | null,
): Promise<void> {
  await dbQuery(
    `UPDATE banking_institutions
     SET sync_paused_status = $2::varchar,
         sync_paused_since = CASE WHEN $2::varchar IS NULL THEN NULL ELSE now() END
     WHERE id = $1`,
    [institutionId, status],
  );
}

export async function countRecentScaEvents(
  institutionId: number,
  windowDays: number,
): Promise<number> {
  const { rows } = await dbQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM banking_sync_runs
     WHERE institution_id = $1 AND sca_required = true
       AND started_at > now() - ($2 || ' days')::interval`,
    [institutionId, windowDays],
  );
  return parseInt(rows[0].count, 10);
}

// ── E2 Query Functions ───────────────────────────────────────────────────────


/** Row type for banking_sync_runs. */
export interface SyncRunRow {
  id: number;
  institution_id: number;
  sync_date: string;
  run_phase: string;
  status: string;
  trigger_source: string | null;
  trigger_id: string | null;
  sca_required: boolean | null;
  alert_delivered: boolean | null;
  accounts_synced: number | null;
  transactions_new: number | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

/** Look up a sync run by its DB id. */
export async function getSyncRunById(id: number): Promise<SyncRunRow | null> {
  const { rows } = await dbQuery<any>(
    'SELECT * FROM banking_sync_runs WHERE id = $1',
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: num(r.id),
    institution_id: num(r.institution_id),
    sync_date: r.sync_date,
    run_phase: r.run_phase,
    status: r.status,
    trigger_source: r.trigger_source,
    trigger_id: r.trigger_id,
    sca_required: r.sca_required,
    alert_delivered: r.alert_delivered,
    accounts_synced: r.accounts_synced != null ? Number(r.accounts_synced) : null,
    transactions_new: r.transactions_new != null ? Number(r.transactions_new) : null,
    error_message: r.error_message,
    started_at: r.started_at,
    finished_at: r.finished_at,
    created_at: r.created_at,
  };
}

/** Lookback-Cursor: MAX(booking_date) for an account. Returns ISO date or null. */
export async function getLastBookingDate(accountId: number): Promise<string | null> {
  const { rows } = await dbQuery<{ max_date: string | null }>(
    `SELECT MAX(booking_date)::date::text AS max_date FROM banking_transactions WHERE account_id = $1`,
    [accountId],
  );
  return rows[0]?.max_date ?? null;
}


/**
 * banking/tan-bridge — Coordinates Telegram <-> Sidecar TAN flow.
 * Sprint 7b Etappe d/f: No direct Telegram API calls — uses injected sendTelegram.
 *
 * Hard rules:
 *   - TAN code values NEVER persisted or logged — in-memory only
 *   - Audit always with after: null (sensitive)
 *
 * Etappe f: Passes credentials + state blobs (client_data, tan_data) to sidecar.
 * All FinTS state is serialized, stored encrypted in Postgres, and passed back.
 */
import * as audit from '../../shared/audit/index.js';
import { query as dbQuery } from '../../shared/db/index.js';
import { decrypt } from './encryption.js';
import {
  getDecryptedSession,
  setPendingChallenge,
  getPendingChallenge,
  clearPendingChallenge,
  expireOldPendingChallenges,
  upsertAccount,
  updateSessionState,
  loeseAndereSitzungenAb,
} from './store.js';
import * as sidecar from './sidecar-client.js';
import { tanVerfahrenFuerSidecar, neueKontoBezeichnung } from './banken.js';
import { SidecarError } from './sidecar-client.js';

import type { InstitutionRow, EncryptedPayload } from './types.js';
import { rufeUmsaetzeNachVerbindenAb, abrufMeldung, maskiereFehlertext } from './abruf-nach-verbinden.js';

/**
 * Fehlertext für das Formular. Der Sidecar antwortet bei Fachfehlern mit
 * HTTP 4xx und {error, detail}; sidecarFetch wirft dann eine SidecarError mit
 * dem rohen JSON. Gezeigt wird der Klartext aus `detail` (20.10.2026).
 */
export function fehlertextFuerFormular(e: any): string {
  if (e instanceof SidecarError && e.responseBody) {
    try {
      const inhalt = JSON.parse(e.responseBody);
      if (inhalt?.detail) return String(inhalt.detail);
      if (inhalt?.error) return String(inhalt.error);
    } catch { /* kein JSON — unten weiter */ }
  }
  return String(e?.message || e);
}

// ── Dependencies injected from index.ts ────────────────────────────────────

export interface TanBridgeDeps {
  sendTelegram: (chatId: string, text: string) => Promise<boolean>;
  telegramChatId: () => string | undefined;
}

let _deps: TanBridgeDeps | null = null;

export function initTanBridge(deps: TanBridgeDeps): void {
  _deps = deps;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Fire-and-forget: Fehler landen im Log und in Telegram, nie beim Formular. */
function starteAbrufNachVerbinden(sessionId: number, institutionId: number, institutName: string): void {
  // Der ganze Rumpf steht im try: ein Fehler hier darf nie als unbehandelte
  // Ablehnung den Gateway-Prozess erreichen.
  setImmediate(async () => {
    try {
      let text: string;
      try {
        text = abrufMeldung(institutName, await rufeUmsaetzeNachVerbindenAb(sessionId, institutionId));
      } catch (e: any) {
        const grund = maskiereFehlertext(fehlertextFuerFormular(e));
        console.error('[banking] Abruf nach Verbinden fehlgeschlagen:', grund);
        text = `⚠️ ${institutName}: Umsatzabruf nach dem Verbinden fehlgeschlagen — ${grund}`;
      }
      const chatId = _deps?.telegramChatId();
      if (chatId) await _deps!.sendTelegram(chatId, text);
    } catch (e: any) {
      console.error('[banking] Meldung zum Abruf nach Verbinden fehlgeschlagen:', String(e?.message || e).slice(0, 200));
    }
  });
}

async function getInstitutionById(id: number): Promise<InstitutionRow | null> {
  const { rows } = await dbQuery<InstitutionRow>(
    'SELECT * FROM banking_institutions WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

// ── Connect flow ───────────────────────────────────────────────────────────

/**
 * Initiate a banking connection via sidecar.
 * If sidecar returns needs_tan, stores pending challenge and notifies via Telegram.
 */
export async function initiateConnect(
  sessionId: number,
  clientDataB64?: string | null,
): Promise<{ status: string; challengeType?: string; message?: string; accountCount?: number; error?: string }> {
  const decrypted = await getDecryptedSession(sessionId);
  if (!decrypted) {
    return { status: 'error', error: 'Session not found' };
  }

  // Look up institution for BLZ and FinTS URL
  const { rows: sessionRows } = await dbQuery<{ institution_id: number; product_id: string; tan_medium_name: string | null }>(
    'SELECT institution_id, product_id, tan_medium_name FROM banking_sessions WHERE id = $1',
    [sessionId],
  );
  if (sessionRows.length === 0) {
    return { status: 'error', error: 'Session not found' };
  }

  const institution = await getInstitutionById(sessionRows[0].institution_id);
  if (!institution) {
    return { status: 'error', error: 'Institution not found' };
  }

  await audit.log({
    module: 'banking', action: 'connect.initiate',
    entityType: 'banking_session', entityId: String(sessionId),
    after: null,
  });

  try {
    const response = await sidecar.connect({
      session_id: sessionId,
      blz: institution.blz,
      user_id: decrypted.userId,
      pin: decrypted.pin,
      fints_url: institution.fints_url,
      // 'env-default' is a DB sentinel → map to undefined so sidecar's env fallback triggers
      product_id: sessionRows[0].product_id === 'env-default' ? undefined : sessionRows[0].product_id,
      client_data_b64: clientDataB64 ?? undefined,
      // nur bei SecureGo plus gesetzt; S-pushTAN bleibt bei der Automatik
      tan_verfahren: tanVerfahrenFuerSidecar(sessionRows[0].tan_medium_name),
    });

    // Sidecar returned needs_tan
    if (response?.needs_tan) {
      const challengeType = response.tan_type || 'unknown';
      const challengeMessage = response.tan_message || 'TAN erforderlich';
      const dialogState = JSON.stringify({
        client_data: response.client_data || null,
        tan_data: response.tan_data || null,
        tan_decoupled: response.tan_decoupled || false,
      });

      await setPendingChallenge(sessionId, challengeType, challengeMessage, dialogState);

      // Notify via Telegram
      if (_deps) {
        const chatId = _deps.telegramChatId();
        if (chatId) {
          const tanText = challengeType === 'pushTAN'
            ? `\u{1F510} ${challengeMessage}\n\nBitte in der Banking-App best\u00E4tigen, dann /tan ok senden.`
            : `\u{1F510} ${challengeMessage}\n\nBitte TAN eingeben: /tan <code>`;
          await _deps.sendTelegram(chatId, tanText);
        }
      }

      return { status: 'tan_required', challengeType, message: challengeMessage };
    }

    // Sidecar returned success with accounts — store client_data (BPD/UPD cache)
    if (response?.client_data) {
      const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
      await updateSessionState(sessionId, response.client_data, 'fints5', '5.0.0', expiresAt);
    }

    if (response?.accounts && Array.isArray(response.accounts)) {
      const institut = await getInstitutionById(sessionRows[0].institution_id);
      let accountCount = 0;
      for (const acct of response.accounts) {
        const account = await upsertAccount(
          sessionRows[0].institution_id,
          acct.iban,
          neueKontoBezeichnung(institut?.blz, institut?.name, acct.iban, acct.display_name),
          {
            accountNumber: acct.account_number,
            accountType: acct.account_type,
            ownerName: acct.owner_name,
            currency: acct.currency,
            currentBalance: acct.balance != null ? Number(acct.balance) : undefined,
          },
        );
        if (account.status === 'archived') {
          await audit.log({
            module: 'banking',
            action: 'account.archive_preserved',
            entityType: 'banking_account',
            entityId: String(account.id),
            after: { iban: account.iban, status: 'archived', reason: 'reconnect_upsert_skipped_status' },
          });
        }
        accountCount++;
      }
      // Dialog offen gehalten → Salden und Umsätze darin abrufen, NACH der
      // Antwort an das Formular (20.10.2026, abruf-nach-verbinden.ts).
      if ((response as any)?.dialog_offen) {
        starteAbrufNachVerbinden(sessionId, Number(sessionRows[0].institution_id), institution.name);
      }
      // Erfolgreich verbunden: ältere Sitzungen desselben Instituts ablösen,
      // damit nur diese eine abgleicht (20.10.2026, drei parallele KSK-Sitzungen).
      // Scheitert das, ist die Verbindung trotzdem gelungen — nur protokollieren.
      try {
        await loeseAndereSitzungenAb(Number(sessionRows[0].institution_id), sessionId);
      } catch (e: any) {
        console.error('[banking] Ablösen älterer Sitzungen fehlgeschlagen:', e.message);
        await audit.log({
          module: 'banking', action: 'session.deactivate_failed',
          entityType: 'banking_session', entityId: String(sessionId),
          after: { institution_id: sessionRows[0].institution_id, fehler: String(e.message).slice(0, 200) },
        }).catch(() => {});
      }
      return { status: 'connected', accountCount };
    }

    // Sidecar returned error
    if (response?.error) {
      // Klartext (detail) bevorzugen: Das Formular zeigt ihn dem Owner an.
      return { status: 'error', error: (response as any).detail || response.error };
    }

    return { status: 'connected', accountCount: 0 };
  } catch (e: any) {
    return { status: 'error', error: fehlertextFuerFormular(e) };
  }
}

// ── Complete TAN flow ──────────────────────────────────────────────────────

/**
 * Complete a pending TAN challenge.
 * TAN value is NEVER persisted or logged — in-memory only.
 *
 * Etappe f: Re-fetches credentials + state blobs, passes to expanded sidecar call.
 */
export async function completeTan(
  sessionId: number,
  tan: string,
): Promise<{ status: string; challengeType?: string; message?: string; accountCount?: number; error?: string }> {
  const challenge = await getPendingChallenge(sessionId);
  if (!challenge) {
    return { status: 'error', error: 'No pending challenge' };
  }

  // Decrypt the challenge state → extract client_data + tan_data
  const encPayload: EncryptedPayload = JSON.parse(challenge.stateEncrypted.toString('utf-8'));
  const stateJson = decrypt(encPayload, String(sessionId), 'pending_challenge_state');
  const challengeState = JSON.parse(stateJson);
  const clientData: string | null = challengeState.client_data || null;
  const tanData: string | null = challengeState.tan_data || null;

  if (!clientData || !tanData) {
    return { status: 'error', error: 'Incomplete challenge state (missing client_data or tan_data)' };
  }

  // Re-fetch credentials
  const decrypted = await getDecryptedSession(sessionId);
  if (!decrypted) {
    return { status: 'error', error: 'Session not found' };
  }

  const { rows: sessionRows } = await dbQuery<{ institution_id: number; product_id: string }>(
    'SELECT institution_id, product_id FROM banking_sessions WHERE id = $1',
    [sessionId],
  );
  if (sessionRows.length === 0) {
    return { status: 'error', error: 'Session not found' };
  }

  const institution = await getInstitutionById(sessionRows[0].institution_id);
  if (!institution) {
    return { status: 'error', error: 'Institution not found' };
  }

  // Clear challenge before sidecar call (TAN is one-time)
  await clearPendingChallenge(sessionId);

  await audit.log({
    module: 'banking', action: 'connect.complete_tan',
    entityType: 'banking_session', entityId: String(sessionId),
    after: null,
  });

  try {
    const response = await sidecar.completeTan({
      session_id: sessionId,
      blz: institution.blz,
      fints_url: institution.fints_url,
      user_id: decrypted.userId,
      pin: decrypted.pin,
      // 'env-default' is a DB sentinel → map to undefined so sidecar's env fallback triggers
      product_id: sessionRows[0].product_id === 'env-default' ? undefined : sessionRows[0].product_id,
      client_data: clientData,
      tan_data: tanData,
      tan, // TAN value — never persisted, never logged
    }) as any;

    // Another TAN challenge (decoupled retry)
    if (response?.needs_tan) {
      const challengeType = response.tan_type || 'unknown';
      const challengeMessage = response.tan_message || 'TAN erforderlich';
      const newDialogState = JSON.stringify({
        client_data: response.client_data || clientData,
        tan_data: response.tan_data || tanData,
        tan_decoupled: response.tan_decoupled || false,
      });

      await setPendingChallenge(sessionId, challengeType, challengeMessage, newDialogState);

      return { status: 'tan_required', challengeType, message: challengeMessage };
    }

    // Success — store updated client_data
    if (response?.client_data) {
      const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
      await updateSessionState(sessionId, response.client_data, 'fints5', '5.0.0', expiresAt);
    }

    // Upsert accounts
    if (response?.accounts && Array.isArray(response.accounts)) {
      const institutionId = sessionRows[0].institution_id;
      const institut = await getInstitutionById(institutionId);

      let accountCount = 0;
      for (const acct of response.accounts) {
        const account = await upsertAccount(
          institutionId,
          acct.iban,
          neueKontoBezeichnung(institut?.blz, institut?.name, acct.iban, acct.display_name),
          {
            accountNumber: acct.account_number,
            accountType: acct.account_type,
            ownerName: acct.owner_name,
            currency: acct.currency,
            currentBalance: acct.balance != null ? Number(acct.balance) : undefined,
          },
        );
        if (account.status === 'archived') {
          await audit.log({
            module: 'banking',
            action: 'account.archive_preserved',
            entityType: 'banking_account',
            entityId: String(account.id),
            after: { iban: account.iban, status: 'archived', reason: 'reconnect_upsert_skipped_status' },
          });
        }
        accountCount++;
      }
      // Dialog offen gehalten → Salden und Umsätze darin abrufen, NACH der
      // Antwort an das Formular (20.10.2026, abruf-nach-verbinden.ts).
      if ((response as any)?.dialog_offen) {
        starteAbrufNachVerbinden(sessionId, Number(sessionRows[0].institution_id), institution.name);
      }
      // Erfolgreich verbunden: ältere Sitzungen desselben Instituts ablösen,
      // damit nur diese eine abgleicht (20.10.2026, drei parallele KSK-Sitzungen).
      // Scheitert das, ist die Verbindung trotzdem gelungen — nur protokollieren.
      try {
        await loeseAndereSitzungenAb(Number(sessionRows[0].institution_id), sessionId);
      } catch (e: any) {
        console.error('[banking] Ablösen älterer Sitzungen fehlgeschlagen:', e.message);
        await audit.log({
          module: 'banking', action: 'session.deactivate_failed',
          entityType: 'banking_session', entityId: String(sessionId),
          after: { institution_id: sessionRows[0].institution_id, fehler: String(e.message).slice(0, 200) },
        }).catch(() => {});
      }
      return { status: 'connected', accountCount };
    }

    // Error from sidecar
    if (response?.error) {
      // Klartext (detail) bevorzugen: Das Formular zeigt ihn dem Owner an.
      return { status: 'error', error: (response as any).detail || response.error };
    }

    return { status: 'connected', accountCount: 0 };
  } catch (e: any) {
    return { status: 'error', error: fehlertextFuerFormular(e) };
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────

/**
 * Expire old pending challenges (10 minute timeout).
 */
export async function cleanupExpiredChallenges(): Promise<void> {
  const expired = await expireOldPendingChallenges(10);
  if (expired > 0) {
    console.log(`[banking] Expired ${expired} stale TAN challenge(s)`);
  }
}

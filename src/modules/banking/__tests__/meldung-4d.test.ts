/**
 * Vorschlag 4d (Owner-Freigabe 07.11.2026): IMPORT_FAILED mit Grund und Weg,
 * keine volle IBAN in Telegram (C5), „Bank verbinden" als Lauf protokolliert.
 * Eigene Test-Datenbank (C1), Sidecar nachgestellt, kein Bankkontakt.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';
import { kontoKurz, fehlerGrund, abgleichFehlerText, abgleichNurUeberVerbinden, BANK_VERBINDEN_LINK } from '../meldung.js';
import { SidecarError } from '../sidecar-client.js';

process.env.BANKING_ENCRYPTION_KEY = 'a'.repeat(64);

let cleanup: () => Promise<void>;
beforeAll(async () => { cleanup = (await setupTestDb()).cleanup; });
afterAll(async () => { if (cleanup) await cleanup(); });

const VOLLE_IBAN = /[A-Z]{2}\d{2}\d{12,}/;
const fehler9340 = () => new SidecarError(
  'Sidecar returned 401: {"error":"pin_error","detail":"Bank lehnt die Anmeldung ab (9340) – bitte Kennung und PIN prüfen"}',
  401, '{"error":"pin_error","detail":"Bank lehnt die Anmeldung ab (9340) – bitte Kennung und PIN prüfen"}');

describe('Meldungsbausteine', () => {
  test('Kontokennung nur mit Endziffern', () => {
    expect(kontoKurz('DE12 6439 0130 0000 0000 28')).toBe('…0028');
    expect(kontoKurz(null)).toBe('…????');
  });
  test('Bankcode mit Klartext aus dem Sidecar-Fehler', () => {
    expect(fehlerGrund(fehler9340())).toEqual({ codes: ['9340'], text: '9340 Auftrag abgelehnt' });
    expect(fehlerGrund(new Error('Bank meldet 9050 Die Nachricht enthält Fehler')).text).toBe('9050 Nachricht enthält Fehler');
    // ohne Code: Detail, Kontonummern maskiert
    expect(fehlerGrund(new SidecarError('x', 400, '{"detail":"Account DE89370400440532013000 not found"}')).text).toBe('Account [IBAN] not found');
  });
  test('Volksbank: Hinweis auf „Bank verbinden", KSK ohne', () => {
    expect(abgleichNurUeberVerbinden('64390130')).toBe(true);
    expect(abgleichNurUeberVerbinden('64350070')).toBe(false);
    const vb = abgleichFehlerText({ institut: 'Volksbank', blz: '64390130', gruende: ['9340 Auftrag abgelehnt', '9340 Auftrag abgelehnt'], fehlgeschlagen: 9, konten: 9 });
    expect(vb).toBe('Volksbank: 9340 Auftrag abgelehnt (9 von 9 Konten) – die Bank verlangt für jeden neuen Abruf eine App-Freigabe; Umsätze über „Bank verbinden“ im Dashboard abrufen');
    expect(abgleichFehlerText({ institut: 'KSK', blz: '64350070', gruende: ['x'], fehlgeschlagen: 1, konten: 7 })).toBe('KSK: x (1 von 7 Konten)');
  });
});

describe('Montagslauf mit 9340 (Trockenlauf der Meldung)', () => {
  test('Telegram ohne volle IBAN, mit Grund und Link; error_message gefüllt', async () => {
    const { upsertInstitution, createSession, upsertAccount } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const inst = await upsertInstitution('64390130', 'Volksbank Test', null, 'https://example.com/fints');
    const sess = await createSession(inst.id, 'U_vb', 'P_vb', 'prod-vb');
    await query(`UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), sess.id]);
    const iban = 'DE00643901300000000028';
    await upsertAccount(inst.id, iban, 'Giro');
    await query(`UPDATE banking_sessions SET pending_challenge_type = 'test_disabled' WHERE id <> $1 AND pending_challenge_type IS NULL`, [sess.id]);

    const gesendet: string[] = [];
    const { runWeeklySyncWithReport, initSyncEngine } = await import('../sync-engine.js');
    initSyncEngine({
      sendTelegram: async (_c: string, t: string) => { gesendet.push(t); return true; }, telegramChatId: () => 'test',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => { throw fehler9340(); },
    } as any);
    const r = await runWeeklySyncWithReport({ runPhase: 'scheduled' });
    await query(`UPDATE banking_sessions SET pending_challenge_type = NULL WHERE pending_challenge_type = 'test_disabled'`);

    expect(r.status).toBe('IMPORT_FAILED');
    const bericht = gesendet.join('\n');
    expect(bericht).toContain('Sync-Fehler Konto …0028: 9340 Auftrag abgelehnt');
    expect(bericht).toContain(BANK_VERBINDEN_LINK);
    expect(VOLLE_IBAN.test(bericht)).toBe(false);
    expect(bericht).not.toContain('{"error"');
    expect(r.errorMessage).toContain('9340 Auftrag abgelehnt (1 von 1 Konten)');
    expect(r.errorMessage).toContain('„Bank verbinden“');
    expect(r.telegram).toContain('Grund: Volksbank Test: 9340 Auftrag abgelehnt');
    expect(r.telegram).toContain(`→ Bank verbinden: ${BANK_VERBINDEN_LINK}`);
    expect(VOLLE_IBAN.test(r.telegram)).toBe(false);
    const { rows } = await query(`SELECT error_message FROM banking_sync_runs WHERE institution_id = $1 ORDER BY id DESC LIMIT 1`, [inst.id]);
    expect(String(rows[0].error_message)).toContain('9340');
  });
});

describe('„Bank verbinden" als Lauf', () => {
  test('Erfolg → SUCCESS_FULL mit Summen, Auslöser verbinden, keine SCA-Markierung', async () => {
    const { upsertInstitution } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const inst = await upsertInstitution('64390999', 'Bank verbinden Test', null, 'https://example.com/fints');
    const { protokolliereLauf } = await import('../abruf-nach-verbinden.js');
    await protokolliereLauf(inst.id, 34, [
      { konto: '…0028', status: 'ok', umsaetze: 32, neu: 5, umgeschluesselt: 0, pdfVerknuepft: 0, saldenprobe: 0 },
      { konto: '…0125', status: 'ok', umsaetze: 8, neu: 3, umgeschluesselt: 0, pdfVerknuepft: 0, saldenprobe: 0 },
      { konto: '…9999', status: 'neu', umsaetze: 0, neu: 0, umgeschluesselt: 0, pdfVerknuepft: 0, saldenprobe: null },
    ] as any);
    const { rows } = await query(`SELECT run_phase, trigger_source, trigger_id, status, accounts_synced, transactions_new, sca_required, finished_at
      FROM banking_sync_runs WHERE institution_id = $1 ORDER BY id DESC LIMIT 1`, [inst.id]);
    expect(rows[0]).toMatchObject({ run_phase: 'verbinden', trigger_source: 'verbinden', trigger_id: 'session-34', status: 'SUCCESS_FULL', sca_required: null });
    expect(Number(rows[0].accounts_synced)).toBe(2);
    expect(Number(rows[0].transactions_new)).toBe(8);
    expect(rows[0].finished_at).not.toBeNull();
  });
  test('Fehler eines Kontos → IMPORT_FAILED mit Grund (Endziffern)', async () => {
    const { upsertInstitution } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const inst = await upsertInstitution('64390998', 'Bank verbinden Test 2', null, 'https://example.com/fints');
    const { protokolliereLauf } = await import('../abruf-nach-verbinden.js');
    await protokolliereLauf(inst.id, 35, [
      { konto: '…0028', status: 'ok', umsaetze: 1, neu: 1, umgeschluesselt: 0, pdfVerknuepft: 0, saldenprobe: 0 },
      { konto: '…0010', status: 'tan_noetig', umsaetze: 0, neu: 0, umgeschluesselt: 0, pdfVerknuepft: 0, saldenprobe: null },
    ] as any);
    const { rows } = await query(`SELECT status, error_message FROM banking_sync_runs WHERE institution_id = $1 ORDER BY id DESC LIMIT 1`, [inst.id]);
    expect(rows[0].status).toBe('IMPORT_FAILED');
    expect(rows[0].error_message).toBe('Abruf nach Verbinden: …0010 tan_noetig');
  });
});

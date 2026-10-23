/**
 * Abgleich: Status und Summen je Institut (Owner-Freigabe 23.10.2026).
 *
 * Bis dahin schrieb startWeeklySync den Gesamtstatus in die Laufzeile JEDES
 * Instituts — scheiterte die Volksbank, stand auch der fehlerfreie KSK-Lauf
 * auf IMPORT_FAILED (Läufe 14–19 vom 20.10.2026). Dazu die Sitzungswahl:
 * eine gescheiterte Neuverbindung darf die funktionierende Sitzung nicht
 * verdrängen (KSK-Sitzung 22 vom 23.10.2026).
 *
 * Eigene Test-Datenbank (C1), Sidecar nachgestellt, kein Bankkontakt.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

process.env.BANKING_ENCRYPTION_KEY = 'a'.repeat(64);

let cleanup: () => Promise<void>;
beforeAll(async () => { cleanup = (await setupTestDb()).cleanup; });
afterAll(async () => { if (cleanup) await cleanup(); });

/** Institut mit verbundener Sitzung und einem aktiven Konto. */
async function institut(blz: string, iban: string, erfolg = true) {
  const { upsertInstitution, createSession, upsertAccount } = await import('../store.js');
  const { query } = await import('../../../shared/db/index.js');
  const inst = await upsertInstitution(blz, `Bank ${blz}`, null, 'https://example.com/fints');
  const sess = await createSession(inst.id, `U_${blz}`, `P_${blz}`, `prod-${blz}`);
  await query(
    `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = ${erfolg ? 'NOW()' : 'NULL'} WHERE id = $2`,
    [new Date(Date.now() + 90 * 86_400_000).toISOString(), sess.id],
  );
  const konto = await upsertAccount(inst.id, iban, `Konto ${blz}`);
  return { inst, sess, konto };
}

/** Nur die genannten Sitzungen sichtbar machen (wie in etappe-e1). */
async function nurSitzungen(ids: number[]) {
  const { query } = await import('../../../shared/db/index.js');
  await query(`UPDATE banking_sessions SET pending_challenge_type = 'test_disabled' WHERE NOT (id = ANY($1::int[])) AND pending_challenge_type IS NULL`, [ids]);
}
async function alleSitzungenZurueck() {
  const { query } = await import('../../../shared/db/index.js');
  await query(`UPDATE banking_sessions SET pending_challenge_type = NULL WHERE pending_challenge_type = 'test_disabled'`);
}

async function laufzeile(institutionId: number) {
  const { query } = await import('../../../shared/db/index.js');
  const { rows } = await query(
    `SELECT status, accounts_synced, transactions_new FROM banking_sync_runs WHERE institution_id = $1 ORDER BY id DESC LIMIT 1`,
    [institutionId]);
  return rows[0];
}

const umsatz = (n: number) => ({
  bank_transaction_id: `v2_2026-10-0${n}_-10.00_t${n}`, legacy_transaction_id: `alt${n}`,
  booking_date: `2026-10-0${n}`, value_date: `2026-10-0${n}`, amount: -10, currency: 'EUR',
  counterparty_name: 'Gegenpartei', reference: `Zweck ${n}`, transaction_code: 'N062',
});

describe('Status je Institut', () => {
  test('Volksbank scheitert, KSK läuft durch: jede Laufzeile mit eigenem Status und eigenen Summen', async () => {
    const ksk = await institut('64350001', 'DE00643500010000000001');
    const vb = await institut('64390001', 'DE00643900010000000002');
    await nurSitzungen([ksk.sess.id, vb.sess.id]);
    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');
    initSyncEngine({
      sendTelegram: async () => true, telegramChatId: () => 'test',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async (p: any) => {
        if (p.account_iban === vb.konto.iban) throw new Error('Bank meldet 9050 Die Nachricht enthält Fehler');
        return { needs_tan: false, transactions: [umsatz(1), umsatz(2)], balance: 100 } as any;
      },
    } as any);
    const r = await startWeeklySync();
    await alleSitzungenZurueck();

    expect(r.status).toBe('IMPORT_FAILED'); // Gesamtstatus bleibt wie bisher
    const zK = await laufzeile(ksk.inst.id);
    const zV = await laufzeile(vb.inst.id);
    expect(zK.status).toBe('SUCCESS_FULL');
    expect(Number(zK.accounts_synced)).toBe(1);
    expect(Number(zK.transactions_new)).toBe(2);
    expect(zV.status).toBe('IMPORT_FAILED');
    expect(Number(zV.accounts_synced)).toBe(0);
    expect(Number(zV.transactions_new)).toBe(0);
  });

  test('beide fehlerfrei: beide Laufzeilen SUCCESS_FULL', async () => {
    const a = await institut('64350002', 'DE00643500020000000003');
    const b = await institut('64390002', 'DE00643900020000000004');
    await nurSitzungen([a.sess.id, b.sess.id]);
    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');
    initSyncEngine({
      sendTelegram: async () => true, telegramChatId: () => 'test',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ needs_tan: false, transactions: [], balance: 1 }) as any,
    } as any);
    const r = await startWeeklySync();
    await alleSitzungenZurueck();
    expect(r.status).toBe('SUCCESS_FULL');
    expect((await laufzeile(a.inst.id)).status).toBe('SUCCESS_FULL');
    expect((await laufzeile(b.inst.id)).status).toBe('SUCCESS_FULL');
  });

  test('globaler TAN-Stopp: Status des übersprungenen Instituts bleibt TAN_REQUIRED', async () => {
    const a = await institut('64350003', 'DE00643500030000000005');
    const b = await institut('64390003', 'DE00643900030000000006');
    await nurSitzungen([a.sess.id, b.sess.id]);
    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');
    initSyncEngine({
      sendTelegram: async () => true, telegramChatId: () => 'test',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ needs_tan: true, tan_type: 'pushTAN', transactions: [] }) as any,
    } as any);
    const r = await startWeeklySync();
    await alleSitzungenZurueck();
    expect(r.status).toBe('TAN_REQUIRED');
    expect((await laufzeile(a.inst.id)).status).toBe('TAN_REQUIRED');
    expect((await laufzeile(b.inst.id)).status).toBe('TAN_REQUIRED');
  });
});

/** Reihenfolge festlegen: zuerst `erst` (jüngster Erfolg), dann `dann`. */
async function reihenfolge(erst: number, dann: number) {
  const { query } = await import('../../../shared/db/index.js');
  await query(`UPDATE banking_sessions SET last_success_at = NOW() WHERE id = $1`, [erst]);
  await query(`UPDATE banking_sessions SET last_success_at = NOW() - interval '1 hour' WHERE id = $1`, [dann]);
}

describe('Status je Institut — Review-Fälle', () => {
  test('erstes Institut fehlerfrei, zweites verlangt TAN: Knopf zeigt auf das TAN-Institut und wird angenommen', async () => {
    const ok = await institut('64350006', 'DE00643500060000000009');
    const tan = await institut('64390006', 'DE00643900060000000010');
    await reihenfolge(ok.sess.id, tan.sess.id);
    await nurSitzungen([ok.sess.id, tan.sess.id]);
    let knopf = '';
    const { startWeeklySync, initSyncEngine, validateResyncRequest } = await import('../sync-engine.js');
    initSyncEngine({
      sendTelegram: async () => true, telegramChatId: () => 'test',
      sendTelegramWithKeyboard: async (_c: string, _m: string, kb: any) => { knopf = kb[0][0].callback_data; return true; },
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async (p: any) => p.account_iban === tan.konto.iban
        ? { needs_tan: true, tan_type: 'pushTAN', transactions: [] } as any
        : { needs_tan: false, transactions: [umsatz(3)], balance: 5 } as any,
    } as any);
    const r = await startWeeklySync();
    await alleSitzungenZurueck();
    expect(r.status).toBe('TAN_REQUIRED');
    expect((await laufzeile(ok.inst.id)).status).toBe('SUCCESS_FULL');
    expect((await laufzeile(tan.inst.id)).status).toBe('TAN_REQUIRED');
    expect(knopf).toMatch(/^bsync_\d+$/);
    const v = await validateResyncRequest(Number(knopf.slice(6)));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.institutionId).toBe(tan.inst.id);
  });

  test('Zeitüberschreitung beim zweiten Institut: erstes SUCCESS_FULL, zweites BANK_TIMEOUT_UNKNOWN', async () => {
    const ok = await institut('64350007', 'DE00643500070000000011');
    const zu = await institut('64390007', 'DE00643900070000000012');
    await reihenfolge(ok.sess.id, zu.sess.id);
    await nurSitzungen([ok.sess.id, zu.sess.id]);
    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');
    initSyncEngine({
      sendTelegram: async () => true, telegramChatId: () => 'test',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async (p: any) => {
        if (p.account_iban === zu.konto.iban) throw new Error('fetch_timeout');
        return { needs_tan: false, transactions: [], balance: 1 } as any;
      },
    } as any);
    const r = await startWeeklySync();
    await alleSitzungenZurueck();
    expect(r.status).toBe('BANK_TIMEOUT_UNKNOWN');
    expect((await laufzeile(ok.inst.id)).status).toBe('SUCCESS_FULL');
    expect((await laufzeile(zu.inst.id)).status).toBe('BANK_TIMEOUT_UNKNOWN');
  });

  test('übersprungenes Institut nach TAN-Stopp: Status fest, Zustellung nachgetragen', async () => {
    const { query } = await import('../../../shared/db/index.js');
    const erst = await institut('64350008', 'DE00643500080000000013');
    const spaeter = await institut('64390008', 'DE00643900080000000014');
    await reihenfolge(erst.sess.id, spaeter.sess.id);
    await nurSitzungen([erst.sess.id, spaeter.sess.id]);
    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');
    initSyncEngine({
      sendTelegram: async () => true, telegramChatId: () => 'test',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ needs_tan: true, tan_type: 'pushTAN', transactions: [] }) as any,
    } as any);
    await startWeeklySync();
    await alleSitzungenZurueck();
    const { rows } = await query(`SELECT status, alert_delivered FROM banking_sync_runs WHERE institution_id = $1 ORDER BY id DESC LIMIT 1`, [spaeter.inst.id]);
    expect(rows[0].status).toBe('TAN_REQUIRED');
    expect(rows[0].alert_delivered).toBe(true);
  });
});

describe('Sitzungswahl', () => {
  test('gescheiterte jüngere Neuverbindung verdrängt die erfolgreiche Sitzung nicht', async () => {
    const { createSession, listActiveSessions } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const alt = await institut('64350004', 'DE00643500040000000007', true);
    // Neuverbindung ohne Erfolg: jünger (updated_at jetzt), aber last_success_at NULL
    const neu = await createSession(alt.inst.id, 'U_neu', 'P_neu', 'prod-neu');
    await query(`UPDATE banking_sessions SET last_success_at = NOW() - interval '3 days', updated_at = NOW() - interval '3 days' WHERE id = $1`, [alt.sess.id]);
    await query(`UPDATE banking_sessions SET last_success_at = NULL, updated_at = NOW() WHERE id = $1`, [neu.id]);
    const reihe = (await listActiveSessions()).filter(s => s.institutionId === alt.inst.id).map(s => s.id);
    expect(reihe[0]).toBe(alt.sess.id);
    expect(reihe).toContain(neu.id);
  });

  test('erfolgreiche Neuverbindung wird weiter vorgezogen (Befund E1 vom 07.10.)', async () => {
    const { createSession, listActiveSessions } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const alt = await institut('64350005', 'DE00643500050000000008', true);
    const neu = await createSession(alt.inst.id, 'U_neu2', 'P_neu2', 'prod-neu2');
    await query(`UPDATE banking_sessions SET last_success_at = NOW() - interval '3 days' WHERE id = $1`, [alt.sess.id]);
    await query(`UPDATE banking_sessions SET last_success_at = NOW() WHERE id = $1`, [neu.id]);
    const reihe = (await listActiveSessions()).filter(s => s.institutionId === alt.inst.id).map(s => s.id);
    expect(reihe[0]).toBe(neu.id);
  });
});

/**
 * banking/fixes-20261020.test.ts — drei Korrekturen vom 20.10.2026
 * (Owner-Freigabe „Freigabe 1-3", report-banking-sync-already-running-20261020):
 *
 *  1. Umsatz-Schlüssel: zwei gleiche Buchungen am selben Tag gehen nicht mehr
 *     verloren; der Bestand mit altem Schlüssel wird umgeschlüsselt, nicht
 *     verdoppelt; PDF-Zeilen derselben Buchung werden als Dublette verknüpft.
 *  2. Sitzungen: eine erfolgreich verbundene Sitzung löst die älteren ab.
 *  3. Sperre: die Abgleich-Sperre ist nicht mehr über den Pool wiedereintretbar.
 *
 * Läuft gegen eine eigene Test-Datenbank (C1).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

process.env.BANKING_ENCRYPTION_KEY = 'a'.repeat(64);

let cleanup: () => Promise<void>;

beforeAll(async () => {
  const result = await setupTestDb();
  cleanup = result.cleanup;
  const { query } = await import('../../../shared/db/index.js');
  // Produktion seit 22.06.2026 (Audit 721): abgelöste Sitzungen tragen
  // institution_id = NULL. Die Migration V027 kennt das noch nicht.
  await query('ALTER TABLE banking_sessions ALTER COLUMN institution_id DROP NOT NULL');
  // duplicate_of und updated_at kommen aus der Assets-Migration V042, die diese
  // reine Banking-Testdatenbank nicht anwendet (siehe test-db-setup.ts).
  await query('ALTER TABLE banking_transactions ADD COLUMN IF NOT EXISTS duplicate_of BIGINT REFERENCES banking_transactions(id) ON DELETE SET NULL');
  await query('ALTER TABLE banking_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()');
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

async function konto(blz: string): Promise<number> {
  const { upsertInstitution, upsertAccount } = await import('../store.js');
  const inst = await upsertInstitution(blz, `Testbank ${blz}`, null, 'https://example.com/fints');
  const acct = await upsertAccount(inst.id, `DE00${blz}0000000001`, 'Testkonto', {});
  return acct.id;
}

const gutschrift = (key: string, zweck: string, legacy = '2026-03-30_71.0_N062') => ({
  bank_transaction_id: key,
  legacy_transaction_id: legacy,
  booking_date: '2026-03-30',
  value_date: '2026-03-30',
  amount: 71,
  currency: 'EUR',
  counterparty_name: 'Mieter W1',
  reference: zweck,
  transaction_code: 'N062',
  raw_payload: { zweck },
});

describe('1 Umsatz-Schlüssel', () => {
  test('zwei gleiche Gutschriften am selben Tag werden beide gespeichert', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const id = await konto('60000001');

    const a = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_a', 'Abschlag 03/26'));
    const b = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_b', 'Abschlag 04/26'));
    expect(a.ergebnis).toBe('neu');
    expect(b.ergebnis).toBe('neu');

    const { rows } = await query('SELECT count(*)::int AS n, sum(amount)::float AS s FROM banking_transactions WHERE account_id = $1', [id]);
    expect(rows[0]).toEqual({ n: 2, s: 142 });
  });

  test('erneuter Abruf erzeugt keine Dublette', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const id = await konto('60000002');

    await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_a', 'Abschlag 03/26'));
    await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_b', 'Abschlag 04/26'));
    const a2 = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_a', 'Abschlag 03/26'));
    const b2 = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_b', 'Abschlag 04/26'));
    expect(a2.ergebnis).toBe('vorhanden');
    expect(b2.ergebnis).toBe('vorhanden');

    const { rows } = await query('SELECT count(*)::int AS n FROM banking_transactions WHERE account_id = $1', [id]);
    expect(rows[0].n).toBe(2);
  });

  test('Bestand mit altem Schlüssel: die textgleiche Buchung behält ihre Zeile, der Zwilling kommt neu', async () => {
    const { insertTransaction, uebernimmUmsaetze } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const id = await konto('60000003');

    // So steht es seit dem Abgleich vom 20.10.2026 in der Datenbank: EINE Zeile
    // mit dem alten Schlüssel, Text der zweiten Gutschrift.
    const alt = await insertTransaction(id, {
      bank_transaction_id: '2026-03-30_71.0_N062', booking_date: '2026-03-30', amount: 71,
      currency: 'EUR', counterparty_name: 'Mieter W1', reference: 'Abschlag 04/26', raw_payload: {},
    });

    // Abruf liefert A zuerst — trotzdem darf A die Zeile von B nicht übernehmen
    const befunde = await uebernimmUmsaetze(id, [gutschrift('v2_a', 'Abschlag 03/26'), gutschrift('v2_b', 'Abschlag 04/26')]);
    expect(befunde.map(b => b.ergebnis)).toEqual(['neu', 'umgeschluesselt']);

    const { rows } = await query(
      'SELECT id::int AS id, bank_transaction_id AS k, reference AS z FROM banking_transactions WHERE account_id = $1 ORDER BY bank_transaction_id', [id]);
    expect(rows.map((r: any) => [r.k, r.z])).toEqual([['v2_a', 'Abschlag 03/26'], ['v2_b', 'Abschlag 04/26']]);
    // Die alte Zeile (an der Zuordnungen hängen könnten) ist jetzt B, nicht A
    expect(rows.find((r: any) => r.k === 'v2_b').id).toBe(alt!.id);
  });

  test('ohne textgleiche Zeile wird im zweiten Durchgang trotzdem umgeschlüsselt, nicht verdoppelt', async () => {
    const { insertTransaction, uebernimmUmsaetze } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const id = await konto('60000006');
    await insertTransaction(id, {
      bank_transaction_id: '2026-03-30_71.0_N062', booking_date: '2026-03-30', amount: 71,
      currency: 'EUR', reference: 'Text, den die Bank inzwischen anders liefert', raw_payload: {},
    });
    const befunde = await uebernimmUmsaetze(id, [gutschrift('v2_a', 'Abschlag 03/26')]);
    expect(befunde[0].ergebnis).toBe('umgeschluesselt');
    const { rows } = await query('SELECT count(*)::int AS n FROM banking_transactions WHERE account_id = $1', [id]);
    expect(rows[0].n).toBe(1);
  });

  test('völlig gleiche Zwillinge (_2): nach dem Umschlüsseln ergibt ein erneuter Abruf genau zwei Zeilen', async () => {
    const { insertTransaction, uebernimmUmsaetze } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const id = await konto('60000007');
    await insertTransaction(id, {
      bank_transaction_id: '2026-03-30_71.0_N062', booking_date: '2026-03-30', amount: 71,
      currency: 'EUR', counterparty_name: 'Mieter W1', reference: 'Abschlag', raw_payload: {},
    });
    const abruf = [gutschrift('v2_x', 'Abschlag'), gutschrift('v2_x_2', 'Abschlag')];
    await uebernimmUmsaetze(id, abruf);
    await uebernimmUmsaetze(id, abruf);
    const { rows } = await query('SELECT count(*)::int AS n FROM banking_transactions WHERE account_id = $1', [id]);
    expect(rows[0].n).toBe(2);
  });

  test('PDF-Zeile mit altem Schlüssel wird nie umgeschlüsselt', async () => {
    const { insertTransaction, uebernimmUmsaetze } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const id = await konto('60000008');
    await insertTransaction(id, {
      bank_transaction_id: '2026-03-30_71.0_N062', booking_date: '2026-03-30', amount: 71,
      currency: 'EUR', reference: 'Abschlag 03/26', raw_payload: {}, source: 'pdf_import',
    });
    await uebernimmUmsaetze(id, [gutschrift('v2_a', 'Abschlag 03/26')]);
    const { rows } = await query(
      "SELECT bank_transaction_id AS k, source FROM banking_transactions WHERE account_id = $1 ORDER BY source", [id]);
    expect(rows).toEqual([{ k: 'v2_a', source: 'fints' }, { k: '2026-03-30_71.0_N062', source: 'pdf_import' }]);
  });

  test('Fehler mitten in der Übernahme: Rückabwicklung, Verbindung geht nicht verloren', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const id = await konto('60000009');
    // ungültiges Datum → INSERT scheitert
    await expect(uebernimmSynchronisiertenUmsatz(id, { ...gutschrift('v2_kaputt', 'x'), booking_date: 'kein-datum' }))
      .rejects.toThrow();
    // zwölf weitere Aufrufe: bliebe je Fehler eine Verbindung hängen, wäre der Pool (10) erschöpft
    for (let i = 0; i < 12; i++) {
      await expect(uebernimmSynchronisiertenUmsatz(id, { ...gutschrift(`v2_k${i}`, 'x'), booking_date: 'kein-datum' })).rejects.toThrow();
    }
    const r = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_ok', 'ok'));
    expect(r.ergebnis).toBe('neu');
    const { rows } = await query("SELECT count(*)::int AS n FROM banking_transactions WHERE account_id = $1", [id]);
    expect(rows[0].n).toBe(1);
  });

  test('PDF-Zeile derselben Buchung wird als Dublette der FinTS-Zeile markiert', async () => {
    const { insertTransaction, uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const id = await konto('60000004');

    await insertTransaction(id, {
      bank_transaction_id: 'pdf_1', booking_date: '2026-03-31', amount: 71, currency: 'EUR',
      reference: 'aus PDF', raw_payload: {}, source: 'pdf_import',
    });
    const r = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_a', 'Abschlag 03/26'));
    expect(r.ergebnis).toBe('neu');
    expect(r.pdfVerknuepft).not.toBeNull();

    const { rows } = await query(
      'SELECT count(*) FILTER (WHERE duplicate_of IS NULL)::int AS zaehlt FROM banking_transactions WHERE account_id = $1', [id]);
    expect(rows[0].zaehlt).toBe(1);   // die Summe zählt die Buchung nur einmal

    // Zweite gleiche FinTS-Buchung findet keine freie PDF-Zeile mehr
    const r2 = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_b', 'Abschlag 04/26'));
    expect(r2.pdfVerknuepft).toBeNull();
  });

  // Seit 23.10.2026 paarweise (Owner-Freigabe „Freigabe 1-3"): gleichwertige
  // Kandidaten werden der Reihe nach verknüpft statt gar nicht — sonst zählt
  // jede Buchung einer solchen Gruppe doppelt.
  test('zwei gleichwertige PDF-Kandidaten: paarweise verknüpfen und melden', async () => {
    const { insertTransaction, uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('60000013');
    const pdf = [];
    for (const k of ['pdf_1', 'pdf_2']) {
      pdf.push(await insertTransaction(id, {
        bank_transaction_id: k, booking_date: '2026-03-30', amount: 71, currency: 'EUR',
        counterparty_name: 'Jemand anderes', raw_payload: {}, source: 'pdf_import',
      }));
    }
    const r = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_a', 'Abschlag 03/26'));
    expect(r.pdfVerknuepft).toBe(pdf[0]!.id);
    expect(r.pdfMehrdeutig).toBe(true);
    const r2 = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_b', 'Abschlag 03/26'));
    expect(r2.pdfVerknuepft).toBe(pdf[1]!.id);
    expect(r2.pdfMehrdeutig).toBe(false);
  });

  test('passende Gegenpartei wird vor näherem Datum bevorzugt', async () => {
    const { insertTransaction, uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('60000014');
    await insertTransaction(id, {
      bank_transaction_id: 'pdf_fremd', booking_date: '2026-03-30', amount: 71, currency: 'EUR',
      counterparty_name: 'Jemand anderes', raw_payload: {}, source: 'pdf_import',
    });
    const passend = await insertTransaction(id, {
      bank_transaction_id: 'pdf_passend', booking_date: '2026-03-31', amount: 71, currency: 'EUR',
      counterparty_name: 'Mieter  W1', raw_payload: {}, source: 'pdf_import',
    });
    const r = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_a', 'Abschlag 03/26'));
    expect(r.pdfVerknuepft).toBe(passend!.id);
  });

  test('PDF-Zeile mit anderem Betrag bleibt unberührt', async () => {
    const { insertTransaction, uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('60000005');
    await insertTransaction(id, {
      bank_transaction_id: 'pdf_1', booking_date: '2026-03-30', amount: 72, currency: 'EUR',
      raw_payload: {}, source: 'pdf_import',
    });
    const r = await uebernimmSynchronisiertenUmsatz(id, gutschrift('v2_a', 'Abschlag 03/26'));
    expect(r.pdfVerknuepft).toBeNull();
  });
});

describe('2 Sitzungen', () => {
  test('erfolgreich verbundene Sitzung löst die älteren desselben Instituts ab', async () => {
    const { upsertInstitution, createSession, loeseAndereSitzungenAb, listActiveSessions } = await import('../store.js');
    const inst = await upsertInstitution('60000010', 'Sitzungsbank', null, 'https://example.com/fints');
    const andere = await upsertInstitution('60000011', 'Andere Bank', null, 'https://example.com/fints');
    const s18 = await createSession(inst.id, 'U', 'P', 'prod');
    const s19 = await createSession(inst.id, 'U', 'P', 'prod');
    const s20 = await createSession(inst.id, 'U', 'P', 'prod');
    const fremd = await createSession(andere.id, 'U', 'P', 'prod');

    const abgeloest = await loeseAndereSitzungenAb(inst.id, s20.id);
    expect(abgeloest.sort()).toEqual([s18.id, s19.id].sort());

    const aktiv = (await listActiveSessions()).map(s => s.id);
    expect(aktiv).toContain(s20.id);
    expect(aktiv).toContain(fremd.id);       // anderes Institut bleibt unberührt
    expect(aktiv).not.toContain(s18.id);
    expect(aktiv).not.toContain(s19.id);
  });

  test('ohne ältere Sitzung ändert sich nichts', async () => {
    const { upsertInstitution, createSession, loeseAndereSitzungenAb } = await import('../store.js');
    const inst = await upsertInstitution('60000012', 'Einzelbank', null, 'https://example.com/fints');
    const s = await createSession(inst.id, 'U', 'P', 'prod');
    expect(await loeseAndereSitzungenAb(inst.id, s.id)).toEqual([]);
  });
});

describe('3 Sperre', () => {
  test('zweiter Versuch erhält die Sperre nicht, solange der erste sie hält', async () => {
    const { nimmAbgleichSperre, gibAbgleichSperreFrei } = await import('../sync-engine.js');
    const erste = await nimmAbgleichSperre();
    expect(erste).not.toBeNull();
    try {
      // Früher konnte dieser Aufruf dieselbe Poolverbindung bekommen und die
      // (wiedereintretbare) Sperre „erhalten".
      const zweite = await nimmAbgleichSperre();
      expect(zweite).toBeNull();
    } finally {
      await gibAbgleichSperreFrei(erste!);
    }
  });

  test('nach der Freigabe ist die Sperre sofort wieder frei', async () => {
    const { nimmAbgleichSperre, gibAbgleichSperreFrei } = await import('../sync-engine.js');
    const erste = await nimmAbgleichSperre();
    await gibAbgleichSperreFrei(erste!);
    const zweite = await nimmAbgleichSperre();
    expect(zweite).not.toBeNull();
    await gibAbgleichSperreFrei(zweite!);
  });

  test('viele gleichzeitige Versuche: genau einer erhält die Sperre', async () => {
    const { nimmAbgleichSperre, gibAbgleichSperreFrei } = await import('../sync-engine.js');
    const versuche = await Promise.all(Array.from({ length: 5 }, () => nimmAbgleichSperre()));
    const erhalten = versuche.filter(Boolean);
    expect(erhalten).toHaveLength(1);
    await gibAbgleichSperreFrei(erhalten[0]!);
  });
});

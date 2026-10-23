/**
 * banking/pdf-verknuepfung-paarweise.test.ts — PDF↔FinTS-Verknüpfung für
 * Gruppen gleicher Beträge (Owner-Freigabe 23.10.2026 „Freigabe 1-3",
 * report-banking-status-ibans-reconnect-hauswart-20261023).
 *
 * Anlass: Auf dem Giro …0028 zählten 15 Allianz-Lastschriften zu je 30 € und
 * zwei Leasingraten zu je 4.383,58 € doppelt, weil gleichwertige PDF-Kandidaten
 * unverknüpft blieben; auf dem Kartenkonto …0125 eine Gutschrift, die die Bank
 * 16 Tage nach dem Umsatz buchte. Die Negativtests sichern, dass dabei keine
 * falsche Zeile verknüpft wird.
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
  // wie fixes-20261020.test.ts: Spalten aus V042, die diese Test-DB nicht anwendet
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

async function pdfZeile(kontoId: number, key: string, datum: string, betrag: number, zweck: string,
  source: 'pdf_import' | 'kk_pdf_import' = 'pdf_import', gegenpartei = 'Allianz Lebensversiche'): Promise<number> {
  const { insertTransaction } = await import('../store.js');
  const t = await insertTransaction(kontoId, {
    bank_transaction_id: key, booking_date: datum, amount: betrag, currency: 'EUR',
    counterparty_name: gegenpartei, reference: zweck, raw_payload: {}, source,
  });
  return t!.id;
}

const bankZeile = (key: string, datum: string, betrag: number, zweck: string, gegenpartei = 'Allianz Lebensversiche') => ({
  bank_transaction_id: key, booking_date: datum, value_date: datum, amount: betrag, currency: 'EUR',
  counterparty_name: gegenpartei, reference: zweck, transaction_code: 'N005', raw_payload: {},
});

async function verknuepftMit(pdfId: number): Promise<number | null> {
  const { query } = await import('../../../shared/db/index.js');
  const { rows } = await query('SELECT duplicate_of FROM banking_transactions WHERE id = $1', [pdfId]);
  return rows[0].duplicate_of === null ? null : Number(rows[0].duplicate_of);
}

const VERTRAEGE = ['AL-1001', 'AL-1002', 'AL-1003', 'AL-1004', 'AL-1005'];
const allianzZweck = (vertrag: string, monat: string) =>
  `Vertrag ${vertrag} 01.${monat}.26 - 28.${monat}.26 PrivRent Perspektive EREF: X`;

describe('Gruppen gleicher Beträge', () => {
  test('5 × 30 € je Monat über drei Monate: jede Bankzeile nimmt die PDF-Zeile ihres Vertrags und Monats', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('61000001');
    const monate = [['08', '2026-08-03'], ['09', '2026-09-01'], ['10', '2026-10-01']] as const;
    // PDF-Zeilen in umgekehrter Vertragsreihenfolge, mit IBAN davor wie im Kontoauszug
    const pdf = new Map<string, number>();
    for (const [monat, datum] of monate) {
      for (const v of [...VERTRAEGE].reverse()) {
        pdf.set(`${v}/${monat}`, await pdfZeile(id, `pdf_${v}_${monat}`, datum, -30, `DE00111122223333444455 ${allianzZweck(v, monat)}`));
      }
    }
    for (const [monat, datum] of monate) {
      for (const v of VERTRAEGE) {
        const r = await uebernimmSynchronisiertenUmsatz(id, bankZeile(`v2_${v}_${monat}`, datum, -30, allianzZweck(v, monat)));
        expect(r.ergebnis).toBe('neu');
        expect(r.pdfVerknuepft).toBe(pdf.get(`${v}/${monat}`)!);
        expect(r.pdfMehrdeutig).toBe(false);
      }
    }
    const { query } = await import('../../../shared/db/index.js');
    const { rows } = await query(
      'SELECT count(*) FILTER (WHERE duplicate_of IS NULL)::int AS zaehlt, sum(amount) FILTER (WHERE duplicate_of IS NULL)::float AS summe FROM banking_transactions WHERE account_id = $1', [id]);
    expect(rows[0]).toEqual({ zaehlt: 15, summe: -450 });
  });

  test('negativ: eine Bankzeile des Folgemonats greift nicht auf die PDF-Zeile des Vormonats', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('61000002');
    const august = await pdfZeile(id, 'pdf_aug', '2026-08-03', -30, allianzZweck('AL-1001', '08'));
    // Bank liefert nur den September; der August-PDF-Zeile fehlt ihr Partner und sie bleibt frei
    const r = await uebernimmSynchronisiertenUmsatz(id, bankZeile('v2_sep', '2026-09-01', -30, allianzZweck('AL-1001', '09')));
    expect(r.pdfVerknuepft).toBeNull();
    expect(await verknuepftMit(august)).toBeNull();
  });

  test('2 × 4.383,58 € am selben Tag: die Rechnungsnummer im Zweck entscheidet', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('61000003');
    const gp = 'Porsche Financial Serv';
    const augustRate = await pdfZeile(id, 'pdf_inv2', '2026-08-05', -4383.58, 'DE00111122223333444455 /INV/ 2600626720 31.07.2026 2026 /08 Entgelt Leasing', 'pdf_import', gp);
    const juliRate = await pdfZeile(id, 'pdf_inv1', '2026-08-05', -4383.58, 'DE00111122223333444455 /INV/ 2600619218 22.07.2026 2026 /07 Entgelt Leasing', 'pdf_import', gp);
    const r1 = await uebernimmSynchronisiertenUmsatz(id, bankZeile('v2_inv1', '2026-08-05', -4383.58, '/INV/ 2600619218 22.07.2026 2026 /07 Entgelt Leasing', gp));
    const r2 = await uebernimmSynchronisiertenUmsatz(id, bankZeile('v2_inv2', '2026-08-05', -4383.58, '/INV/ 2600626720 31.07.2026 2026 /08 Entgelt Leasing', gp));
    expect(r1.pdfVerknuepft).toBe(juliRate);
    expect(r2.pdfVerknuepft).toBe(augustRate);
    expect(r1.pdfMehrdeutig || r2.pdfMehrdeutig).toBe(false);
  });

  test('fehlt die PDF-Zeile von Vertrag B, nimmt B die von A — die Summe stimmt trotzdem', async () => {
    // Festgehaltenes Verhalten: Ohne Textbeleg entscheidet die Reihenfolge. B
    // verdeckt die PDF-Zeile von A, A selbst bleibt unverknüpft und zählt;
    // gezählt werden also genau die zwei Bankbuchungen.
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const id = await konto('61000010');
    const pdfA = await pdfZeile(id, 'pdf_A', '2026-08-03', -30, allianzZweck('AL-1001', '08'));
    const rB = await uebernimmSynchronisiertenUmsatz(id, bankZeile('v2_B', '2026-08-03', -30, allianzZweck('AL-1002', '08')));
    const rA = await uebernimmSynchronisiertenUmsatz(id, bankZeile('v2_A', '2026-08-03', -30, allianzZweck('AL-1001', '08')));
    expect(rB.pdfVerknuepft).toBe(pdfA);
    expect(rA.pdfVerknuepft).toBeNull();
    const { rows } = await query(
      'SELECT count(*) FILTER (WHERE duplicate_of IS NULL)::int AS zaehlt FROM banking_transactions WHERE account_id = $1', [id]);
    expect(rows[0].zaehlt).toBe(2);
  });

  test('negativ: dritte gleiche Bankzeile ohne PDF-Partner bleibt unverknüpft und zählt', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('61000004');
    await pdfZeile(id, 'pdf_a', '2026-08-05', -4383.58, 'Rate A');
    await pdfZeile(id, 'pdf_b', '2026-08-05', -4383.58, 'Rate B');
    await uebernimmSynchronisiertenUmsatz(id, bankZeile('v2_a', '2026-08-05', -4383.58, 'Rate A'));
    await uebernimmSynchronisiertenUmsatz(id, bankZeile('v2_b', '2026-08-05', -4383.58, 'Rate B'));
    const r3 = await uebernimmSynchronisiertenUmsatz(id, bankZeile('v2_c', '2026-08-05', -4383.58, 'Rate C'));
    expect(r3.ergebnis).toBe('neu');
    expect(r3.pdfVerknuepft).toBeNull();
  });
});

describe('Kartenkonten: Umsatzdatum aus dem Zweck', () => {
  const visa = (datum: string, betrag: number, umsatz: string, haendler = 'HOGAN IT SantElpidio') =>
    ({ ...bankZeile(`v2_${datum}_${betrag}_${umsatz}`, datum, betrag, `${haendler} EUR ${Math.abs(betrag)} Umsatz vom ${umsatz} Visa Hauptkarte`, ''), counterparty_name: undefined });

  test('Gutschrift mit 16 Tagen Versatz wird über das Umsatzdatum verknüpft', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('61000005');
    const pdf = await pdfZeile(id, 'kk_hogan', '2026-08-03', 420, 'HOGAN | IT SantElpidio', 'kk_pdf_import', 'HOGAN');
    const r = await uebernimmSynchronisiertenUmsatz(id, visa('2026-08-19', 420, '03.08.2026'));
    expect(r.pdfVerknuepft).toBe(pdf);
  });

  test('negativ: dieselbe Gutschrift ohne Umsatzdatum (Kontoauszug-PDF) wird bei 16 Tagen nicht verknüpft', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('61000006');
    const pdf = await pdfZeile(id, 'pdf_gs', '2026-08-03', 420, 'Gutschrift', 'pdf_import', 'HOGAN');
    const r = await uebernimmSynchronisiertenUmsatz(id, bankZeile('v2_gs', '2026-08-19', 420, 'Gutschrift HOGAN', 'HOGAN'));
    expect(r.pdfVerknuepft).toBeNull();
    expect(await verknuepftMit(pdf)).toBeNull();
  });

  test('negativ: zwei 17,99-€-Umsätze im Abstand von zwei Tagen — das Umsatzdatum wählt den richtigen', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('61000007');
    const epidemic = await pdfZeile(id, 'kk_ep', '2026-08-20', -17.99, 'Epidemic Sound | SE Stockholm', 'kk_pdf_import', 'Epidemic Sound');
    const apple = await pdfZeile(id, 'kk_ap', '2026-08-22', -17.99, 'APPLE.COM/BILL | IE', 'kk_pdf_import', 'APPLE.COM/BILL');
    // Bank bucht beide am 21. bzw. 24.08.; nach Buchungstag ±3 läge der Epidemic-Umsatz gleich weit von beiden
    const r1 = await uebernimmSynchronisiertenUmsatz(id, visa('2026-08-21', -17.99, '20.08.2026', 'Epidemic Sound SE Stockholm'));
    const r2 = await uebernimmSynchronisiertenUmsatz(id, visa('2026-08-24', -17.99, '22.08.2026', 'APPLE.COM/BILL IE'));
    expect(r1.pdfVerknuepft).toBe(epidemic);
    expect(r2.pdfVerknuepft).toBe(apple);
  });

  test('negativ: Umsatzdatum ohne passende Kartenzeile — keine Verknüpfung über den Buchungstag', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const id = await konto('61000008');
    // Kartenzeile liegt am Buchungstag der Bank, das Umsatzdatum aber 10 Tage früher
    const pdf = await pdfZeile(id, 'kk_x', '2026-08-19', -50, 'Händler X', 'kk_pdf_import', 'X');
    const r = await uebernimmSynchronisiertenUmsatz(id, visa('2026-08-19', -50, '09.08.2026', 'Händler Y'));
    expect(r.pdfVerknuepft).toBeNull();
    expect(await verknuepftMit(pdf)).toBeNull();
  });

  test('umsatzdatumAusZweck liest das Datum auch ohne Leerzeichen davor', async () => {
    const { umsatzdatumAusZweck } = await import('../store.js');
    expect(umsatzdatumAusZweck('AUSLANDSUMS. 0,04Umsatz vom 01.09.2026 Visa H')).toBe('2026-09-01');
    expect(umsatzdatumAusZweck('Abrechnung vom 21.08.2026 Visa Hauptkarte')).toBeNull();
    expect(umsatzdatumAusZweck(null)).toBeNull();
    // unmögliches Datum: kein Abbruch, Buchungstag gilt
    expect(umsatzdatumAusZweck('Umsatz vom 31.02.2026 Visa')).toBeNull();
  });
});

describe('Nachträgliche Verknüpfung', () => {
  test('Trockenlauf ändert nichts, Schreiblauf verknüpft paarweise, zweiter Lauf findet nichts mehr', async () => {
    const { insertTransaction, verknuepfePdfNachtraeglich } = await import('../store.js');
    const id = await konto('61000009');
    const pdf = [];
    for (const v of VERTRAEGE.slice(0, 3)) pdf.push(await pdfZeile(id, `pdf_${v}`, '2026-08-03', -30, `DE00 ${allianzZweck(v, '08')}`));
    // Bankzeilen stehen schon da (alter Code: unverknüpft geblieben)
    const bank = [];
    for (const v of VERTRAEGE.slice(0, 3)) {
      bank.push((await insertTransaction(id, {
        bank_transaction_id: `v2_${v}`, booking_date: '2026-08-03', amount: -30, currency: 'EUR',
        counterparty_name: 'Allianz Lebensversiche', reference: allianzZweck(v, '08'), raw_payload: {}, source: 'fints',
      }))!.id);
    }
    const trocken = await verknuepfePdfNachtraeglich([id], false);
    expect(trocken.length).toBe(3);
    for (const p of pdf) expect(await verknuepftMit(p)).toBeNull();

    const echt = await verknuepfePdfNachtraeglich([id], true);
    expect(echt.map(e => [e.fintsId, e.pdfId])).toEqual(bank.map((b, i) => [b, pdf[i]]));
    expect(await verknuepfePdfNachtraeglich([id], false)).toEqual([]);
  });
});

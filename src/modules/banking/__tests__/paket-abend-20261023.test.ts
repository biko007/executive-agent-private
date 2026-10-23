/**
 * banking/paket-abend-20261023.test.ts — Owner-Freigabe 23.10.2026 21:40
 * „Freigabe Paket Abend" (report-banking-paket-abend-20261023).
 *
 *  a) MT940-Tagesversatz: Die Abrufprobe mit dem vom Sidecar verschobenen
 *     Anfangssaldo ergibt für …4288 und …4305 null.
 *  b) PDF-Verknüpfung: Valuta bis fünf Tage neben dem PDF-Datum; Kartenumsatz
 *     mit falschem Umsatzjahr („Umsatz vom 07.03.2025", gebucht 06.03.2026).
 *     Negativtests: sechs Tage, anderer Betrag, plausibles Vorjahr.
 *  c) Neu von der Bank gemeldete Konten: Status 'neu', nicht abgerufen, in der
 *     Meldung genannt.
 *  d) Auszugssalden werden gespeichert.
 *
 * Läuft gegen eine eigene Test-Datenbank (C1), Sidecar nachgestellt, kein
 * Bankkontakt.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

process.env.BANKING_ENCRYPTION_KEY = 'a'.repeat(64);

let letzteAnfrage: any = null;
let antwort: any = { konten: [] };

mock.module('../sidecar-client.js', () => {
  class SidecarError extends Error {
    statusCode: number; responseBody: string;
    constructor(m: string, s: number, b: string) { super(m); this.statusCode = s; this.responseBody = b; }
  }
  return {
    SidecarError,
    abrufImDialog: async (p: any) => { letzteAnfrage = p; return antwort; },
    cancelSession: async () => {},
    connect: async () => ({}), completeTan: async () => ({}), sync: async () => ({}),
    health: async () => ({ status: 'ok' }), redactClientData: (x: any) => x,
  };
});

let cleanup: () => Promise<void>;
beforeAll(async () => { cleanup = (await setupTestDb()).cleanup; });
afterAll(async () => { if (cleanup) await cleanup(); });

async function konto(blz: string, endung = '0000000001'): Promise<{ instId: number; id: number; iban: string }> {
  const { upsertInstitution, upsertAccount } = await import('../store.js');
  const inst = await upsertInstitution(blz, `Testbank ${blz}`, null, 'https://example.com/fints');
  const acct = await upsertAccount(inst.id, `DE00${blz}${endung}`, 'Testkonto', {});
  return { instId: inst.id, id: acct.id, iban: acct.iban };
}

async function pdfZeile(kontoId: number, key: string, datum: string, betrag: number, zweck: string,
  source: 'pdf_import' | 'kk_pdf_import', gegenpartei: string): Promise<number> {
  const { insertTransaction } = await import('../store.js');
  const t = await insertTransaction(kontoId, {
    bank_transaction_id: key, booking_date: datum, amount: betrag, currency: 'EUR',
    counterparty_name: gegenpartei, reference: zweck, raw_payload: {}, source,
  });
  return t!.id;
}

// Spaltenfalle wie im Sidecar: booking_date = Valuta, value_date = Buchungstag
const bankZeile = (key: string, valuta: string, buchungstag: string, betrag: number, zweck: string) => ({
  bank_transaction_id: key, booking_date: valuta, value_date: buchungstag, amount: betrag, currency: 'EUR',
  counterparty_name: null, reference: zweck, transaction_code: 'N005', raw_payload: {},
});

async function verknuepftMit(pdfId: number): Promise<number | null> {
  const { query } = await import('../../../shared/db/index.js');
  const { rows } = await query('SELECT duplicate_of FROM banking_transactions WHERE id = $1', [pdfId]);
  return rows[0].duplicate_of === null ? null : Number(rows[0].duplicate_of);
}

describe('a) MT940-Tagesversatz in der Abrufprobe', () => {
  // Werte vom 23.10.2026: erster gelieferter Tag 02.09.2024
  const faelle = [
    { konto: '…4288', tag1: [-219.82], alt: 219.82 },
    { konto: '…4305', tag1: [4000.00, 300.00, -56.49], alt: -4243.51 },
  ];
  for (const f of faelle) {
    test(`${f.konto}: Anfangssaldo am Vortag des ersten Buchungstags → 0`, async () => {
      const { abrufprobe } = await import('../abruf-nach-verbinden.js');
      const tx = [...f.tag1.map(b => ({ value_date: '2024-09-02', booking_date: '2024-09-02', amount: b })),
        { value_date: '2024-09-03', booking_date: '2024-09-03', amount: 10 }];
      const summe = tx.reduce((s, t) => s + t.amount, 0);
      const schluss = { datum: '2024-09-03', betrag: Math.round((1000 + summe) * 100) / 100 };
      // so liefert der Sidecar seit 23.10.2026 (Vortag der ersten Buchung)
      expect(abrufprobe(tx, { datum: '2024-09-01', betrag: 1000 }, schluss)).toBe(0);
      // Gegenprobe: mit dem Saldodatum der Bank fehlt genau der erste Tag
      expect(abrufprobe(tx, { datum: '2024-09-02', betrag: 1000 }, schluss)).toBe(f.alt);
    });
  }
});

describe('b) PDF-Verknüpfung toleranter', () => {
  test('umsatzdatumFuerVergleich: falsches Umsatzjahr → Buchungsjahr; plausible Daten bleiben', async () => {
    const { umsatzdatumFuerVergleich } = await import('../store.js');
    const zweck = 'DSquared2-ESW-IRL IE Dublin EUR 3.345,00 Umsatz vom 07.03.2025 Visa Hauptkarte';
    expect(umsatzdatumFuerVergleich(zweck, '2026-03-06')).toBe('2026-03-07');
    expect(umsatzdatumFuerVergleich(zweck, new Date('2026-03-06T00:00:00Z'))).toBe('2026-03-07');
    // Jahreswechsel: Umsatz 30.12.2025, gebucht 02.01.2026 — plausibel, bleibt
    expect(umsatzdatumFuerVergleich('Umsatz vom 30.12.2025 Visa', '2026-01-02')).toBe('2025-12-30');
    // 29.02. gibt es 2025 nicht — dann bleibt das gelieferte Datum
    expect(umsatzdatumFuerVergleich('Umsatz vom 29.02.2024 Visa', '2025-03-03')).toBe('2024-02-29');
    expect(umsatzdatumFuerVergleich('ohne Umsatzdatum', '2026-03-06')).toBeNull();
  });

  test('…0028: Valuta 4 Tage neben dem PDF-Datum (−11,50 €) wird verknüpft', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const k = await konto('62000001');
    const pdf = await pdfZeile(k.id, 'pdf_waschhalle', '2025-01-07', -11.5, 'Umsatz vom 02.01.2025 MC Hauptkarte', 'pdf_import', 'DEU Tuttlingen EUR 11,50');
    const r = await uebernimmSynchronisiertenUmsatz(k.id, bankZeile('v2_waschhalle', '2025-01-03', '2025-01-07',
      -11.5, 'WASCHHALLE TUTTLINGEN DEU Tuttlingen EUR 11,50 Umsatz vom 02.01.2025 MC Hauptkarte'));
    expect(r.ergebnis).toBe('neu');
    expect(await verknuepftMit(pdf)).toBe(r.id);
  });

  test('…0125: Kartenumsätze mit falschem Umsatzjahr (−3.345 €, −246 €) werden verknüpft', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const k = await konto('62000002');
    const a = await pdfZeile(k.id, 'kk_dsq', '2026-03-07', -3345, 'DSquared2-ESW-IRL | IE Dublin', 'kk_pdf_import', 'DSquared2-ESW-IRL');
    const b = await pdfZeile(k.id, 'kk_sp', '2026-03-07', -246, 'SP HQ-GERMANY | DE SCHONDORF', 'kk_pdf_import', 'SP HQ-GERMANY');
    const ra = await uebernimmSynchronisiertenUmsatz(k.id, bankZeile('v2_dsq', '2026-03-06', '2026-03-09', -3345,
      'DSquared2-ESW-IRL IE Dublin EUR 3.345,00 Umsatz vom 07.03.2025 Visa Hauptkarte'));
    const rb = await uebernimmSynchronisiertenUmsatz(k.id, bankZeile('v2_sp', '2026-03-06', '2026-03-09', -246,
      'SP HQ-GERMANY DE SCHONDORF EUR 246,00 Umsatz vom 07.03.2025 Visa Hauptkarte'));
    expect(await verknuepftMit(a)).toBe(ra.id);
    expect(await verknuepftMit(b)).toBe(rb.id);
  });

  test('Negativ: sechs Tage Abstand, anderer Betrag — nicht verknüpft', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const k = await konto('62000003');
    const weit = await pdfZeile(k.id, 'pdf_weit', '2025-01-09', -11.5, 'Umsatz vom 02.01.2025 MC', 'pdf_import', 'X');
    const anders = await pdfZeile(k.id, 'pdf_anders', '2025-01-03', -11.6, 'Umsatz vom 02.01.2025 MC', 'pdf_import', 'X');
    await uebernimmSynchronisiertenUmsatz(k.id, bankZeile('v2_n1', '2025-01-03', '2025-01-03', -11.5, 'Umsatz vom 02.01.2025 MC'));
    expect(await verknuepftMit(weit)).toBeNull();
    expect(await verknuepftMit(anders)).toBeNull();
  });

  test('Negativ: Kartenumsatz aus dem echten Vorjahr bleibt im Vorjahr', async () => {
    const { uebernimmSynchronisiertenUmsatz } = await import('../store.js');
    const k = await konto('62000004');
    // PDF-Zeile ein Jahr später mit gleichem Betrag darf nicht greifen
    const spaeter = await pdfZeile(k.id, 'kk_spaeter', '2026-01-05', -50, 'Händler', 'kk_pdf_import', 'Händler');
    await uebernimmSynchronisiertenUmsatz(k.id, bankZeile('v2_vorjahr', '2025-01-06', '2025-01-06', -50,
      'Händler EUR 50,00 Umsatz vom 05.01.2025 Visa'));
    expect(await verknuepftMit(spaeter)).toBeNull();
  });
});

describe('c) Neu gemeldete Konten', () => {
  test('upsertAccount: neues Konto mit statusBeiNeuanlage → neu; vorhandenes behält seinen Status', async () => {
    const { upsertInstitution, upsertAccount } = await import('../store.js');
    const inst = await upsertInstitution('63000001', 'Testbank neu', null, 'https://example.com/fints');
    const alt = await upsertAccount(inst.id, 'DE00630000010000000028', 'Giro', {});
    expect(alt.status).toBe('active');
    const wieder = await upsertAccount(inst.id, 'DE00630000010000000028', 'Giro', { statusBeiNeuanlage: 'neu' });
    expect(wieder.status).toBe('active');
    const neu = await upsertAccount(inst.id, 'DE00630000010000004413', 'Testbank …4413', { statusBeiNeuanlage: 'neu' });
    expect(neu.status).toBe('neu');
  });

  test('Abruf: Konto mit Status neu wird ausgeschlossen und in der Meldung genannt', async () => {
    const { upsertInstitution, upsertAccount, createSession } = await import('../store.js');
    const { rufeUmsaetzeNachVerbindenAb, abrufMeldung } = await import('../abruf-nach-verbinden.js');
    const inst = await upsertInstitution('63000002', 'Testbank Abruf', null, 'https://example.com/fints');
    const giro = await upsertAccount(inst.id, 'DE00630000020000000028', 'Giro', {});
    const neu = await upsertAccount(inst.id, 'DE00630000020000004413', 'Testbank …4413', { statusBeiNeuanlage: 'neu' });
    const sitzung = await createSession(inst.id, 'U', 'P', 'prod');
    antwort = { konten: [
      { iban: giro.iban, status: 'ok', balance: 0, ab: '2026-07-26', transactions: [], statement_opening: null, statement_closing: null },
      // liefert die Bank das neue Konto trotzdem, bleibt es unangetastet
      { iban: neu.iban, status: 'ok', balance: -5, transactions: [{ bank_transaction_id: 'v2_d', booking_date: '2026-09-30', value_date: '2026-09-30', amount: -1 }], statement_opening: null, statement_closing: null },
    ] };
    const e = await rufeUmsaetzeNachVerbindenAb(sitzung.id, inst.id);
    expect(letzteAnfrage.ausschliessen_ibans).toEqual([neu.iban]);
    expect(e!.map(x => `${x.konto}:${x.status}`)).toEqual(['…0028:ok', '…4413:neu']);
    expect(abrufMeldung('Testbank', e)).toContain('…4413: neu – Zuordnung offen');
    const { query } = await import('../../../shared/db/index.js');
    const { rows } = await query('SELECT count(*)::int AS n FROM banking_transactions WHERE account_id = $1', [neu.id]);
    expect(rows[0].n).toBe(0);
  });
});

describe('d) Auszugssalden', () => {
  test('werden je Auszug gespeichert; derselbe Auszug ersetzt den früheren', async () => {
    const { speichereAuszuege } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const k = await konto('64000001');
    const a = { anfang_datum: '2024-09-01', anfang: 1000, schluss_datum: '2024-09-03', schluss: 790.18, umsaetze: 2, summe: -209.82, probe: 0 };
    const b = { anfang_datum: '2024-09-03', anfang: 790.18, schluss_datum: '2024-09-04', schluss: 800, umsaetze: 1, summe: 9.82, probe: 0 };
    expect(await speichereAuszuege(k.id, [a, b], 'verbinden')).toBe(2);
    expect(await speichereAuszuege(k.id, [a], 'abgleich')).toBe(1);
    const { rows } = await query('SELECT quelle, probe::float AS probe FROM banking_statement_balances WHERE account_id = $1 ORDER BY anfang_datum', [k.id]);
    expect(rows).toEqual([{ quelle: 'abgleich', probe: 0 }, { quelle: 'verbinden', probe: 0 }]);
    expect(await speichereAuszuege(k.id, undefined, 'abgleich')).toBe(0);
  });

  test('ein Speicherfehler hält den Abruf nicht auf', async () => {
    const { speichereAuszuege } = await import('../store.js');
    // Konto existiert nicht → Fremdschlüsselfehler, Ergebnis 0 statt Ausnahme
    expect(await speichereAuszuege(999999, [{ anfang_datum: '2024-09-01', anfang: 1, schluss_datum: '2024-09-02', schluss: 1, umsaetze: 0, summe: 0, probe: 0 }], 'pruefung')).toBe(0);
  });
});

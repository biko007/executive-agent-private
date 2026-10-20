/**
 * Umsatzabruf im Verbindungsdialog (20.10.2026) — Gateway-Seite gegen eine
 * eigene Test-Datenbank (C1), Sidecar nachgestellt. Kein Bankkontakt.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

process.env.BANKING_ENCRYPTION_KEY = 'a'.repeat(64);

let letzteAnfrage: any = null;
let antwort: any = { konten: [] };
let abgebrochen: number[] = [];

mock.module('../sidecar-client.js', () => {
  // Nur abrufImDialog wird ersetzt; der Rest des Moduls wird hier nicht gebraucht.
  class SidecarError extends Error {
    statusCode: number; responseBody: string;
    constructor(m: string, s: number, b: string) { super(m); this.statusCode = s; this.responseBody = b; }
  }
  return {
    SidecarError,
    abrufImDialog: async (p: any) => { letzteAnfrage = p; return antwort; },
    cancelSession: async (id: number) => { abgebrochen.push(id); },
    connect: async () => ({}), completeTan: async () => ({}), sync: async () => ({}),
    health: async () => ({ status: 'ok' }), redactClientData: (x: any) => x,
  };
});

let cleanup: () => Promise<void>;
beforeAll(async () => {
  cleanup = (await setupTestDb()).cleanup;
});
afterAll(async () => { if (cleanup) await cleanup(); });

async function bank(blz: string) {
  const { upsertInstitution, upsertAccount, createSession, archiveAccount } = await import('../store.js');
  const inst = await upsertInstitution(blz, `Bank ${blz}`, null, 'https://example.com/fints');
  const eigen = await upsertAccount(inst.id, `DE00${blz}0000000028`, 'Giro', {});
  const fremd = await upsertAccount(inst.id, `DE00${blz}0000002001`, 'Dritte', {});
  await archiveAccount(fremd.id);
  const sitzung = await createSession(inst.id, 'U', 'P', 'prod');
  return { inst, eigen, fremd, sitzung };
}

const tx = (key: string, betrag: number, datum: string) => ({
  bank_transaction_id: key, legacy_transaction_id: `alt_${key}`, booking_date: datum, value_date: datum,
  amount: betrag, currency: 'EUR', counterparty_name: 'Gegenpartei GmbH', reference: key, transaction_code: 'N062',
});

describe('Abruf nach dem Verbinden', () => {
  test('ausgeblendete Konten werden ausgeschlossen, Umsätze übernommen, Saldenprobe 0,00', async () => {
    const { rufeUmsaetzeNachVerbindenAb } = await import('../abruf-nach-verbinden.js');
    const { inst, eigen, fremd, sitzung } = await bank('70000001');
    antwort = { konten: [{
      iban: eigen.iban, status: 'ok', balance: 130, ab: '2015-01-01',
      statement_opening: { datum: '2026-01-01', betrag: 100 }, statement_closing: { datum: '2026-01-31', betrag: 130 },
      transactions: [tx('v2_a', 50, '2026-01-10'), tx('v2_b', -20, '2026-01-20')],
    }] };
    const e = await rufeUmsaetzeNachVerbindenAb(sitzung.id, inst.id);
    expect(letzteAnfrage.ausschliessen_ibans).toEqual([fremd.iban]);
    expect(e).toEqual([{ konto: '…0028', status: 'ok', ab: '2015-01-01', umsaetze: 2, neu: 2, umgeschluesselt: 0, pdfVerknuepft: 0, abrufprobe: 0, saldenprobe: 0 }]);
  });

  test('erneuter Abruf derselben Umsätze: nichts doppelt', async () => {
    const { rufeUmsaetzeNachVerbindenAb } = await import('../abruf-nach-verbinden.js');
    const { query } = await import('../../../shared/db/index.js');
    const { inst, eigen, sitzung } = await bank('70000002');
    antwort = { konten: [{ iban: eigen.iban, status: 'ok', balance: null, statement_opening: null, statement_closing: null,
      transactions: [tx('v2_a', 50, '2026-01-10')] }] };
    await rufeUmsaetzeNachVerbindenAb(sitzung.id, inst.id);
    const e = await rufeUmsaetzeNachVerbindenAb(sitzung.id, inst.id);
    expect(e![0].neu).toBe(0);
    const { rows } = await query('SELECT count(*)::int AS n FROM banking_transactions WHERE account_id = $1', [eigen.id]);
    expect(rows[0].n).toBe(1);
  });

  test('Bank verlangt weitere Freigabe: gemeldet, nichts übernommen', async () => {
    const { rufeUmsaetzeNachVerbindenAb, abrufMeldung } = await import('../abruf-nach-verbinden.js');
    const { inst, eigen, sitzung } = await bank('70000003');
    antwort = { konten: [{ iban: eigen.iban, status: 'tan_noetig', transactions: [], balance: null, statement_opening: null, statement_closing: null }] };
    const e = await rufeUmsaetzeNachVerbindenAb(sitzung.id, inst.id);
    expect(e![0].status).toBe('tan_noetig');
    expect(abrufMeldung('Testbank', e)).toContain('weitere Freigabe');
  });

  test('Kartenabrechnung aus PDF wird mit der FinTS-Zeile verknüpft', async () => {
    const { rufeUmsaetzeNachVerbindenAb } = await import('../abruf-nach-verbinden.js');
    const { insertTransaction } = await import('../store.js');
    const { inst, eigen, sitzung } = await bank('70000004');
    await insertTransaction(eigen.id, { bank_transaction_id: 'kk_1', booking_date: '2026-01-11', amount: -49.9,
      currency: 'EUR', counterparty_name: 'Gegenpartei GmbH', raw_payload: {}, source: 'kk_pdf_import' });
    antwort = { konten: [{ iban: eigen.iban, status: 'ok', balance: null, statement_opening: null, statement_closing: null,
      transactions: [tx('v2_k', -49.9, '2026-01-10')] }] };
    const e = await rufeUmsaetzeNachVerbindenAb(sitzung.id, inst.id);
    expect(e![0].pdfVerknuepft).toBe(1);
  });

  test('läuft gerade ein Abgleich: übersprungen, Meldung sagt es', async () => {
    const { rufeUmsaetzeNachVerbindenAb, abrufMeldung } = await import('../abruf-nach-verbinden.js');
    const { nimmAbgleichSperre, gibAbgleichSperreFrei } = await import('../sync-engine.js');
    const { inst, sitzung } = await bank('70000005');
    const sperre = await nimmAbgleichSperre();
    try {
      const e = await rufeUmsaetzeNachVerbindenAb(sitzung.id, inst.id);
      expect(e).toBeNull();
      expect(abrufMeldung('Testbank', e)).toContain('übersprungen');
      // Der offene Dialog wird sofort geschlossen, nicht erst nach Ablauf
      expect(abgebrochen).toContain(sitzung.id);
    } finally {
      await gibAbgleichSperreFrei(sperre!);
    }
  });

  test('Telegram-Text nennt nur Endziffern', async () => {
    const { abrufMeldung } = await import('../abruf-nach-verbinden.js');
    const t = abrufMeldung('Volksbank', [{ konto: '…0028', status: 'ok', umsaetze: 10, neu: 3, umgeschluesselt: 0, pdfVerknuepft: 3, saldenprobe: 0 }]);
    expect(t).toContain('…0028');
    expect(t).toContain('Saldenprobe ✓');
    expect(t).not.toMatch(/DE\d{20}/);
  });

  test('Abrufprobe erkennt lückenhafte Lieferung, Meldung sagt es', async () => {
    const { rufeUmsaetzeNachVerbindenAb, abrufMeldung } = await import('../abruf-nach-verbinden.js');
    const { inst, eigen, sitzung } = await bank('70000006');
    antwort = { konten: [{
      iban: eigen.iban, status: 'ok', balance: 130, ab: '2026-07-23',
      statement_opening: { datum: '2026-01-01', betrag: 100 }, statement_closing: { datum: '2026-01-31', betrag: 130 },
      transactions: [tx('v2_a', 50, '2026-01-10')],   // die −20 fehlen
    }] };
    const e = await rufeUmsaetzeNachVerbindenAb(sitzung.id, inst.id);
    expect(e![0].abrufprobe).toBe(20);
    const t = abrufMeldung('Testbank', e);
    expect(t).toContain('lückenhaft');
    expect(t).toContain('ab 23.07.2026');
  });

  test('Saldo wird auch bei Umsatzfehler übernommen', async () => {
    const { rufeUmsaetzeNachVerbindenAb } = await import('../abruf-nach-verbinden.js');
    const { query } = await import('../../../shared/db/index.js');
    const { inst, eigen, sitzung } = await bank('70000007');
    antwort = { konten: [{ iban: eigen.iban, status: 'fehler', balance: 77.5, transactions: [], statement_opening: null, statement_closing: null }] };
    const e = await rufeUmsaetzeNachVerbindenAb(sitzung.id, inst.id);
    expect(e![0].status).toBe('fehler');
    const { rows } = await query('SELECT current_balance FROM banking_accounts WHERE id = $1', [eigen.id]);
    expect(Number(rows[0].current_balance)).toBe(77.5);
  });

  test('neu gemeldetes und nicht angefragtes Konto erscheinen in der Meldung', async () => {
    const { rufeUmsaetzeNachVerbindenAb, abrufMeldung } = await import('../abruf-nach-verbinden.js');
    const { inst, eigen, sitzung } = await bank('70000008');
    antwort = { konten: [
      { iban: eigen.iban, status: 'uebersprungen', transactions: [], balance: null, statement_opening: null, statement_closing: null },
      { iban: 'DE00700000080000009999', status: 'ok', transactions: [tx('v2_x', 1, '2026-01-02')], balance: 1, statement_opening: null, statement_closing: null },
    ] };
    const e = await rufeUmsaetzeNachVerbindenAb(sitzung.id, inst.id);
    expect(e!.map(x => x.status)).toEqual(['uebersprungen', 'unbekannt']);
    const t = abrufMeldung('Testbank', e);
    expect(t).toContain('…0028: nicht angefragt');
    expect(t).toContain('…9999: neu gemeldetes Konto');
  });

  test('Fehlertext für Telegram ohne volle Konto- oder Kundennummern', async () => {
    const { maskiereFehlertext } = await import('../abruf-nach-verbinden.js');
    const t = maskiereFehlertext('Konto DE00643901300034840028 / Kunde 1234567890 abgelehnt');
    expect(t).not.toMatch(/\d{6,}/);
    expect(t).toContain('[IBAN]');
    expect(t).toContain('…7890');
  });
});

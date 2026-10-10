/**
 * assets/__tests__/expense-proposals.test.ts — Lebenszyklus eines
 * Buchungsvorschlags gegen eine echte Datenbank.
 *
 * Geprüft wird das, was bei einem Klick des Owners schiefgehen könnte:
 *
 *   - Bestätigen erzeugt GENAU EINE Kostenbuchung und eine Audit-Spur.
 *   - Zweimal bestätigen erzeugt keine zweite Buchung. Ein Doppelklick oder ein
 *     wiederholter Aufruf würde sonst dieselbe Rechnung zweimal in die
 *     Nebenkosten geben — und das fällt erst dem Mieter auf.
 *   - Verwerfen erzeugt keine Buchung.
 *   - Eine geänderte Regel lässt keinen überholten Vorschlag stehen.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertSafeDbUrl } from '../../../core/db-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let testPool: pg.Pool;
let adminPool: pg.Pool;
let testDbName: string;
let prodUrl: string;

// Erst nach dem Umbiegen von POSTGRES_URL laden, sonst zeigt der Pool des
// Moduls auf die Produktiv-Datenbank.
let proposals: typeof import('../proposals.js');

function ensurePostgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set');
  const match = readFileSync(envFile, 'utf-8').match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found');
  process.env.POSTGRES_URL = match[1];
  return match[1];
}

function sql(...teile: string[]): string {
  return readFileSync(join(__dirname, '../..', ...teile), 'utf-8');
}

beforeAll(async () => {
  prodUrl = ensurePostgresUrl();
  testDbName = `openclaw_test_vorschlag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const testUrl = prodUrl.replace(/\/[^/?]+(\?|$)/, `/${testDbName}$1`);

  adminPool = new pg.Pool({ connectionString: prodUrl });
  await adminPool.query(`CREATE DATABASE "${testDbName}"`);
  testPool = new pg.Pool({ connectionString: testUrl });

  await testPool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      module TEXT NOT NULL, version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
    )`);
  await testPool.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  await testPool.query(readFileSync(join(__dirname, '../../../shared/migrations/001_core_tables.sql'), 'utf-8'));
  await testPool.query(readFileSync(join(__dirname, '../../../shared/settings/migrations/035_system_settings.sql'), 'utf-8'));
  await testPool.query(sql('assets', 'migrations', 'V022__assets_tables.sql'));
  await testPool.query(sql('assets', 'migrations', 'V023__assets_foundation.sql'));
  await testPool.query(sql('assets', 'migrations', 'V024__nk_engine.sql'));
  await testPool.query(sql('banking', 'migrations', 'V027__banking_tables.sql'));
  await testPool.query(sql('banking', 'migrations', 'V040__banking_source_und_buchungsvorschlaege.sql'));

  process.env.POSTGRES_URL = testUrl;
  assertSafeDbUrl(testUrl);
  proposals = await import('../proposals.js');
}, 60000);

afterAll(async () => {
  try {
    const db = await import('../../../shared/db/index.js');
    await db.closePool();
  } catch { /* Pool war nicht offen */ }
  if (testPool) { try { await testPool.end(); } catch { /* egal */ } }
  if (adminPool) {
    try {
      await adminPool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [testDbName]);
      await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    } catch { /* egal */ }
    try { await adminPool.end(); } catch { /* egal */ }
  }
  process.env.POSTGRES_URL = prodUrl;
  try {
    const db2 = await import('../../../shared/db/index.js');
    await db2.closePool();
  } catch { /* egal */ }
});

// ── Hilfen ──────────────────────────────────────────────────────────────────

async function setzeRegeln(regeln: unknown[]) {
  await testPool.query(
    `INSERT INTO system_settings (key, value) VALUES ('expense_rules', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(regeln)]);
}

async function seedUmsatz(
  betrag: number, datum: string, gegenpartei: string, zweck: string,
): Promise<number> {
  const { rows } = await testPool.query(
    `INSERT INTO banking_transactions
       (account_id, bank_transaction_id, booking_date, value_date, amount, currency,
        counterparty_name, reference, raw_payload, source)
     VALUES (1, $1, $2, $2, $3, 'EUR', $4, $5, '{}'::jsonb, 'pdf_import') RETURNING id`,
    [`tx_${Math.random().toString(36).slice(2, 12)}`, datum, betrag, gegenpartei, zweck]);
  return rows[0].id;
}

const TESTREGEL = {
  id: 'test-swt-wasser',
  property: 'tp24',
  match: { counterparty: 'stadtwerke', reference: '307008' },
  cost_category: 'wasser',
  umlagefaehig: true,
  service_period: 'rechnungsmonat',
  anteil: 1,
  sicherheit: 'hoch',
  hinweis: 'Testregel',
};

beforeAll(async () => {
  // Stammdaten: ein Objekt und ein Bankkonto. Die Kostenarten bringt V024 mit.
  await testPool.query(
    `INSERT INTO properties (code, name, street, postal_code, city, property_type, owner)
     VALUES ('tp24', 'Testobjekt 24', 'Teststr. 24', '78532', 'Tuttlingen', 'residential', 'Test')
     ON CONFLICT (code) DO NOTHING`);
  await testPool.query(
    `INSERT INTO banking_institutions (blz, name, fints_url)
     VALUES ('64350070', 'Testbank', 'https://example.invalid/fints')
     ON CONFLICT (blz) DO NOTHING`);
  await testPool.query(
    `INSERT INTO banking_accounts (id, institution_id, iban, display_name)
     VALUES (1, 1, 'DE00000000000000000001', 'Testkonto') ON CONFLICT (id) DO NOTHING`);
}, 30000);

// ── Erzeugung ───────────────────────────────────────────────────────────────

describe('erzeugeVorschlaege', () => {
  it('legt für einen passenden Umsatz genau einen Vorschlag an', async () => {
    await setzeRegeln([TESTREGEL]);
    await seedUmsatz(-21, '2026-06-15', 'Stadtwerke Tuttlingen GmbH',
      '133224 DTAUS Rechnung 307008/Marktgasse 24');

    const e = await proposals.erzeugeVorschlaege({ actor: 'test' });
    expect(e.angelegt).toBe(1);

    const { rows } = await testPool.query(
      `SELECT * FROM expense_booking_proposals WHERE rule_id = 'test-swt-wasser'`);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].amount_gross)).toBe(21);
    expect(rows[0].status).toBe('offen');
    expect(rows[0].umlagefaehig).toBe(true);
  });

  it('legt beim zweiten Lauf keinen zweiten Vorschlag an', async () => {
    const e = await proposals.erzeugeVorschlaege({ actor: 'test' });
    expect(e.angelegt).toBe(0);
    expect(e.bereits_vorhanden).toBeGreaterThanOrEqual(1);
    expect(e.aktualisiert).toBe(0);
    expect(e.zurueckgezogen).toBe(0);
  });

  it('lässt einen Umsatz ohne Regeltreffer unbeachtet', async () => {
    await seedUmsatz(-99.5, '2026-06-20', 'Irgendeine Firma GmbH', 'Rechnung 12345');
    const vorher = (await testPool.query('SELECT count(*)::int AS n FROM expense_booking_proposals')).rows[0].n;
    await proposals.erzeugeVorschlaege({ actor: 'test' });
    const nachher = (await testPool.query('SELECT count(*)::int AS n FROM expense_booking_proposals')).rows[0].n;
    expect(nachher).toBe(vorher);
  });

  it('meldet eine Regel mit unbekanntem Objekt statt sie zu buchen', async () => {
    await setzeRegeln([TESTREGEL, { ...TESTREGEL, id: 'test-falsches-objekt', property: 'gibtsnicht' }]);
    const e = await proposals.erzeugeVorschlaege({ actor: 'test' });
    expect(e.uebersprungen).toBeGreaterThanOrEqual(1);
    expect(e.hinweise.some(h => h.includes('gibtsnicht'))).toBe(true);
    await setzeRegeln([TESTREGEL]);
  });
});

// ── Bestätigen ──────────────────────────────────────────────────────────────

describe('bestaetige', () => {
  it('erzeugt genau eine Buchung mit Audit-Eintrag', async () => {
    const { rows: v } = await testPool.query(
      `SELECT id FROM expense_booking_proposals WHERE status = 'offen' ORDER BY id LIMIT 1`);
    const id = v[0].id;

    const e = await proposals.bestaetige(id, {}, 'test-owner');
    expect(e).not.toBeNull();
    expect(e!.bereits_bestaetigt).toBe(false);

    const { rows: buchungen } = await testPool.query(
      'SELECT * FROM expense_bookings WHERE source_key = $1', [`proposal_${id}`]);
    expect(buchungen.length).toBe(1);
    expect(Number(buchungen[0].amount_gross)).toBe(21);
    expect(buchungen[0].umlagefaehig).toBe(true);

    const { rows: vorschlag } = await testPool.query(
      'SELECT * FROM expense_booking_proposals WHERE id = $1', [id]);
    expect(vorschlag[0].status).toBe('bestaetigt');
    expect(Number(vorschlag[0].expense_booking_id)).toBe(Number(buchungen[0].id));

    const { rows: audit } = await testPool.query(
      `SELECT * FROM audit_log WHERE action = 'expense_proposal.confirm' AND entity_id = $1`,
      [String(id)]);
    expect(audit.length).toBe(1);
  });

  it('erzeugt beim zweiten Bestätigen keine zweite Buchung', async () => {
    const { rows: v } = await testPool.query(
      `SELECT id, expense_booking_id FROM expense_booking_proposals
        WHERE status = 'bestaetigt' ORDER BY id LIMIT 1`);
    const id = v[0].id;

    const e = await proposals.bestaetige(id, {}, 'test-owner');
    expect(e!.bereits_bestaetigt).toBe(true);
    expect(Number(e!.expense_booking_id)).toBe(Number(v[0].expense_booking_id));

    const { rows: buchungen } = await testPool.query(
      'SELECT id FROM expense_bookings WHERE source_key = $1', [`proposal_${id}`]);
    expect(buchungen.length).toBe(1);
  });

  it('übernimmt eine beim Bestätigen geänderte Kostenart und Umlagefähigkeit', async () => {
    const txId = await seedUmsatz(-30, '2026-07-15', 'Stadtwerke Tuttlingen GmbH',
      '133224 DTAUS Rechnung 307008/Marktgasse 24');
    await proposals.erzeugeVorschlaege({ actor: 'test' });
    const { rows: v } = await testPool.query(
      `SELECT id FROM expense_booking_proposals WHERE transaction_id = $1`, [txId]);
    const { rows: art } = await testPool.query(
      `SELECT id FROM cost_categories WHERE code = 'instandhaltung'`);

    const e = await proposals.bestaetige(
      v[0].id, { cost_category_id: art[0].id, umlagefaehig: false, notiz: 'Reparatur' }, 'test-owner');

    const { rows: buchung } = await testPool.query(
      'SELECT * FROM expense_bookings WHERE id = $1', [e!.expense_booking_id]);
    expect(Number(buchung[0].cost_category_id)).toBe(Number(art[0].id));
    expect(buchung[0].umlagefaehig).toBe(false);
    expect(buchung[0].notes).toContain('Reparatur');
  });

  it('liefert null für einen Vorschlag, den es nicht gibt', async () => {
    expect(await proposals.bestaetige(9999999, {}, 'test-owner')).toBeNull();
  });
});

// ── Verwerfen ───────────────────────────────────────────────────────────────

describe('verwirf', () => {
  it('erzeugt keine Buchung', async () => {
    const txId = await seedUmsatz(-45, '2026-08-17', 'Stadtwerke Tuttlingen GmbH',
      '133224 DTAUS Rechnung 307008/Marktgasse 24');
    await proposals.erzeugeVorschlaege({ actor: 'test' });
    const { rows: v } = await testPool.query(
      'SELECT id FROM expense_booking_proposals WHERE transaction_id = $1', [txId]);

    const vorher = (await testPool.query('SELECT count(*)::int AS n FROM expense_bookings')).rows[0].n;
    const e = await proposals.verwirf(v[0].id, 'gehört zu einem anderen Objekt', 'test-owner');
    const nachher = (await testPool.query('SELECT count(*)::int AS n FROM expense_bookings')).rows[0].n;

    expect(e!.status).toBe('verworfen');
    expect(nachher).toBe(vorher);

    const { rows: nach } = await testPool.query(
      'SELECT * FROM expense_booking_proposals WHERE id = $1', [v[0].id]);
    expect(nach[0].expense_booking_id).toBeNull();
    expect(nach[0].notiz).toBe('gehört zu einem anderen Objekt');
  });

  it('verweigert das Verwerfen eines bestätigten Vorschlags', async () => {
    const { rows: v } = await testPool.query(
      `SELECT id FROM expense_booking_proposals WHERE status = 'bestaetigt' ORDER BY id LIMIT 1`);
    await expect(proposals.verwirf(v[0].id, 'doch nicht', 'test-owner')).rejects.toThrow();
  });
});

// ── Regeländerung ───────────────────────────────────────────────────────────

describe('Regeländerung zieht offene Vorschläge nach', () => {
  it('passt einen offenen Vorschlag an die geänderte Regel an', async () => {
    const txId = await seedUmsatz(-60, '2026-09-15', 'Stadtwerke Tuttlingen GmbH',
      '133224 DTAUS Rechnung 307008/Marktgasse 24');
    await proposals.erzeugeVorschlaege({ actor: 'test' });

    // Anteil halbiert und Umlagefähigkeit gedreht — wie bei einer nachträglich
    // geklärten Aufteilung zwischen zwei Gebäuden.
    await setzeRegeln([{ ...TESTREGEL, anteil: 0.5, umlagefaehig: false, sicherheit: 'mittel' }]);
    const e = await proposals.erzeugeVorschlaege({ actor: 'test' });
    expect(e.aktualisiert).toBeGreaterThanOrEqual(1);

    const { rows } = await testPool.query(
      'SELECT * FROM expense_booking_proposals WHERE transaction_id = $1', [txId]);
    expect(Number(rows[0].amount_gross)).toBe(30);
    expect(rows[0].umlagefaehig).toBe(false);
    expect(rows[0].sicherheit).toBe('mittel');
    expect(rows[0].status).toBe('offen');

    await setzeRegeln([TESTREGEL]);
    await proposals.erzeugeVorschlaege({ actor: 'test' });
  });

  it('zieht einen offenen Vorschlag zurück, wenn die Regel entfällt', async () => {
    const txId = await seedUmsatz(-75, '2026-09-16', 'Stadtwerke Tuttlingen GmbH',
      '133224 DTAUS Rechnung 307008/Marktgasse 24');
    await proposals.erzeugeVorschlaege({ actor: 'test' });

    await setzeRegeln([]);  // leere Liste → der Startbestand greift, der 'tp24' nicht kennt
    const e = await proposals.erzeugeVorschlaege({ actor: 'test' });
    expect(e.zurueckgezogen).toBeGreaterThanOrEqual(1);

    const { rows } = await testPool.query(
      'SELECT * FROM expense_booking_proposals WHERE transaction_id = $1', [txId]);
    expect(rows[0].status).toBe('verworfen');
    expect(rows[0].expense_booking_id).toBeNull();
    expect(rows[0].notiz).toContain('test-swt-wasser');

    await setzeRegeln([TESTREGEL]);
  });

  it('lässt bestätigte Vorschläge unangetastet', async () => {
    const { rows: vorher } = await testPool.query(
      `SELECT id, amount_gross, cost_category_id FROM expense_booking_proposals
        WHERE status = 'bestaetigt' ORDER BY id`);
    await setzeRegeln([{ ...TESTREGEL, anteil: 0.25 }]);
    await proposals.erzeugeVorschlaege({ actor: 'test' });

    for (const v of vorher) {
      const { rows } = await testPool.query(
        'SELECT amount_gross, cost_category_id, status FROM expense_booking_proposals WHERE id = $1',
        [v.id]);
      expect(rows[0].status).toBe('bestaetigt');
      expect(Number(rows[0].amount_gross)).toBe(Number(v.amount_gross));
      expect(Number(rows[0].cost_category_id)).toBe(Number(v.cost_category_id));
    }
    await setzeRegeln([TESTREGEL]);
  });
});

/**
 * assets/__tests__/umlageregel-nullprozent.test.ts — Grundkostenanteil 0 %.
 *
 * HINTERGRUND (12.10.2026). Die Route zum Anlegen einer Umlageregel setzte die
 * Anteile mit `body.base_share_percent || null`. Ein Grundkostenanteil von
 * NULL PROZENT ist aber eine gültige Angabe — genau die, die MG24 und N24
 * verwenden: 0 % Grundkosten, 100 % Verbrauch. Mit `||` wurde die 0 zu NULL,
 * und die Prüfbedingung der Tabelle ließ den Datensatz nicht zu. Eine
 * 0/100-Regel war über die Route nicht anzulegen; sie musste von Hand in die
 * Datenbank geschrieben werden.
 *
 * Diese Tests halten beides fest: dass 0/100 in der Tabelle zulässig ist und
 * dass ein fehlender Anteil bei `heating_split` abgewiesen wird. Damit ist
 * dokumentiert, warum die Route zwischen „nicht angegeben" und „null Prozent"
 * unterscheiden MUSS.
 *
 * ZUR TESTDATENBANK. `setupTestDb()` legt das Schema aus V022 an. Dort galt
 * noch der Rahmen des § 7 Abs. 1 HeizkostenV, 50 bis 70 Prozent Verbrauch;
 * erst V041 hat ihn auf 0 bis 100 Prozent geöffnet (Owner-Entscheidung
 * 10.10.2026). Diese Datei spielt die Prüfbedingung aus V041 deshalb selbst
 * ein — nur auf ihrer eigenen Testdatenbank, damit kein anderer Test davon
 * berührt wird.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;
let dbQuery: typeof import('../../../shared/db/index.js')['query'];
let objektId: number;
let kostenartId: number;

beforeAll(async () => {
  const ctx = await setupTestDb();
  cleanup = ctx.cleanup;
  const db = await import('../../../shared/db/index.js');
  dbQuery = db.query;

  const { rows: objekt } = await dbQuery(
    `INSERT INTO properties (code, name, street, postal_code, city, property_type, active)
     VALUES ('t-nullprozent', 'Test', 'Teststr. 1', '78532', 'Tuttlingen', 'residential', true)
     RETURNING id`);
  objektId = objekt[0].id;

  const { rows: art } = await dbQuery(
    'SELECT id FROM cost_categories WHERE code = $1', ['heizung']);
  kostenartId = art[0].id;

  // Prüfbedingung auf den Stand von V041 bringen (siehe Kopfkommentar).
  await dbQuery('ALTER TABLE allocation_rules DROP CONSTRAINT IF EXISTS allocation_rules_check1');
  await dbQuery(`ALTER TABLE allocation_rules ADD CONSTRAINT allocation_rules_check1 CHECK (
    key_type <> 'heating_split' OR (
      base_share_percent IS NOT NULL
      AND consumption_share_percent IS NOT NULL
      AND base_share_percent + consumption_share_percent = 100
      AND consumption_share_percent >= 0
      AND consumption_share_percent <= 100
    ))`);
});

afterAll(async () => { if (cleanup) await cleanup(); });

async function regel(grund: number | null, verbrauch: number | null) {
  return dbQuery(
    `INSERT INTO allocation_rules (property_id, cost_category_id, key_type,
       base_share_percent, consumption_share_percent, valid_from)
     VALUES ($1, $2, 'heating_split', $3, $4, '2025-01-01')
     RETURNING base_share_percent, consumption_share_percent`,
    [objektId, kostenartId, grund, verbrauch]);
}

describe('Umlageregel mit Grundkostenanteil 0 %', () => {
  test('0/100 ist zulässig und bleibt 0, nicht NULL', async () => {
    const { rows } = await regel(0, 100);
    expect(Number(rows[0].base_share_percent)).toBe(0);
    expect(Number(rows[0].consumption_share_percent)).toBe(100);
  });

  test('30/70 ist zulässig', async () => {
    const { rows } = await regel(30, 70);
    expect(Number(rows[0].base_share_percent)).toBe(30);
    expect(Number(rows[0].consumption_share_percent)).toBe(70);
  });

  test('NULL als Grundanteil wird abgewiesen — genau der alte Fehler', async () => {
    /* `|| null` machte aus der 0 ein NULL und erzeugte diesen Fehler. */
    await expect(regel(null, 100)).rejects.toThrow();
  });

  test('Anteile, die nicht 100 ergeben, werden abgewiesen', async () => {
    await expect(regel(0, 90)).rejects.toThrow();
  });
});

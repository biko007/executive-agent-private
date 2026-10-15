#!/usr/bin/env bun
/**
 * V042 zuruecknehmen.
 *
 * Nimmt die fuenf additiven Aenderungen zurueck: die beiden neuen Tabellen,
 * die Spalten an leases, rent_ledger und banking_transactions sowie den
 * Versionseintrag. DIE FORDERUNGEN SELBST BLEIBEN — rent_ledger gab es vorher
 * schon; nur die Zusatzspalten entfallen.
 *
 * Aufruf:
 *   bun run scripts/rollback-v042.ts --dry-run
 *   bun run scripts/rollback-v042.ts --apply
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function postgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL fehlt');
  const t = readFileSync(envFile, 'utf-8').match(/^POSTGRES_URL=(.+)$/m);
  if (!t) throw new Error('POSTGRES_URL fehlt in der Env-Datei');
  return t[1];
}

/*
 * banking_transactions.updated_at wird ABSICHTLICH NICHT zurueckgenommen.
 * V027 hat der Tabelle den Trigger set_updated_at() ohne die passende Spalte
 * gegeben; ohne updated_at bricht jede Aenderung an einem Umsatz ab. Die
 * Spalte zu entfernen wuerde diesen Fehler wiederherstellen — sie bleibt.
 */
const SCHRITTE = [
  `DROP TABLE IF EXISTS rent_payment_links`,
  `DROP TABLE IF EXISTS lease_payers`,
  `ALTER TABLE banking_transactions DROP COLUMN IF EXISTS duplicate_of`,
  `ALTER TABLE rent_ledger DROP COLUMN IF EXISTS kaltmiete_amount, DROP COLUMN IF EXISTS nk_amount, DROP COLUMN IF EXISTS heizkosten_amount, DROP COLUMN IF EXISTS garage_amount, DROP COLUMN IF EXISTS kitchen_amount, DROP COLUMN IF EXISTS anteil, DROP COLUMN IF EXISTS erzeugt, DROP COLUMN IF EXISTS gilt_als_bezahlt`,
  `ALTER TABLE leases DROP COLUMN IF EXISTS owner_hauptmieter`,
  `DELETE FROM schema_version WHERE module='assets' AND version=42`,
];

async function main() {
  const anwenden = process.argv.includes('--apply');
  const pool = new pg.Pool({ connectionString: postgresUrl() });
  try {
    /* Vor der Migration gibt es die Spalte duplicate_of noch nicht — der
       Probelauf soll trotzdem laufen und nicht mit einem SQL-Fehler abbrechen. */
    const { rows: da } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='banking_transactions' AND column_name='duplicate_of'`);
    const { rows } = await pool.query(`SELECT
      (SELECT count(*)::int FROM rent_ledger) AS forderungen,
      ${da.length
        ? '(SELECT count(*)::int FROM banking_transactions WHERE duplicate_of IS NOT NULL)'
        : '0'} AS dubletten`);
    console.log(`Vorher: ${rows[0].forderungen} Forderungen, ${rows[0].dubletten} markierte Dubletten`
      + (da.length ? '.' : ' (V042 ist noch nicht angewandt).'));
    if (!anwenden) {
      console.log('\nPROBELAUF. Laufen wuerden:');
      for (const s of SCHRITTE) console.log('  ' + s.replace(/\s+/g, ' ').slice(0, 96));
      console.log('\nACHTUNG: Die Dublettenmarkierung geht dabei verloren, die Umsaetze selbst nicht.');
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of SCHRITTE) await client.query(s);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    console.log('V042 zurueckgenommen.');
  } finally { await pool.end(); }
}

main().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });

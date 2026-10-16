#!/usr/bin/env bun
/**
 * V043 zuruecknehmen.
 *
 * Nimmt die fuenf additiven Aenderungen zurueck: die beiden neuen Tabellen,
 * die Spalten an leases, rent_ledger und banking_transactions sowie den
 * Versionseintrag. DIE FORDERUNGEN SELBST BLEIBEN — rent_ledger gab es vorher
 * schon; nur die Zusatzspalten entfallen.
 *
 * Aufruf:
 *   bun run scripts/rollback-v043.ts --dry-run
 *   bun run scripts/rollback-v043.ts --apply
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

const SCHRITTE = [
  `DROP TABLE IF EXISTS objekt_felder`,
  `DROP TABLE IF EXISTS objekt_fristen`,
  `DROP TABLE IF EXISTS objekt_versicherungen`,
  `DROP TABLE IF EXISTS objekt_dienstleister`,
  `DROP TABLE IF EXISTS objekt_feld_katalog`,
  `DELETE FROM schema_version WHERE module='assets' AND version=43`,
]

async function main() {
  const anwenden = process.argv.includes('--apply');
  const pool = new pg.Pool({ connectionString: postgresUrl() });
  try {
    const { rows: da } = await pool.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='objekt_felder'`);
    const { rows } = await pool.query(`SELECT
      (SELECT count(*)::int FROM properties) AS objekte,
      ${da.length ? '(SELECT count(*)::int FROM objekt_felder)' : '0'} AS werte`);
    console.log(`Vorher: ${rows[0].objekte} Objekte, ${rows[0].werte} erfasste Steckbrieffelder`
      + (da.length ? '.' : ' (V043 ist noch nicht angewandt).'));
    if (!anwenden) {
      console.log('\nPROBELAUF. Laufen wuerden:');
      for (const s of SCHRITTE) console.log('  ' + s.replace(/\s+/g, ' ').slice(0, 96));
      console.log('\nACHTUNG: Alle erfassten Steckbrieffelder, Fristen, Versicherungen und Dienstleister gehen verloren.');
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of SCHRITTE) await client.query(s);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    console.log('V043 zurueckgenommen.');
  } finally { await pool.end(); }
}

main().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });

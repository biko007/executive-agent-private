#!/usr/bin/env bun
/**
 * Rücknahme von V040 (Paket 3, Teile 3 und 5).
 *
 * Nimmt zurück:
 *   - banking_transactions.source  (Spalte wird entfernt)
 *   - expense_booking_proposals    (Tabelle wird entfernt)
 *   - schema_version banking 40
 *
 * Zwei Sicherungen, weil hier Daten verloren gehen können:
 *   1. Gibt es Umsätze mit source <> 'fints', bricht der Lauf ab. Diese
 *      Umsätze wären nach dem Entfernen der Spalte nicht mehr als
 *      nachträglich eingelesen erkennbar. Wer sie trotzdem loswerden will,
 *      entfernt sie zuerst gezielt — bewusst nicht Teil dieses Skripts.
 *   2. Gibt es bestätigte Vorschläge, bricht der Lauf ebenfalls ab. Die
 *      zugehörigen Kostenbuchungen blieben sonst ohne Herkunft zurück.
 *
 * Mit --force lassen sich beide Sperren übergehen. Das ist ein bewusster
 * Datenverlust und gehört in den Report.
 *
 * Aufruf:
 *   bun run scripts/rollback-v040.ts --dry-run
 *   bun run scripts/rollback-v040.ts --apply [--force]
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function postgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL nicht gesetzt und ~/.config/openclaw/env fehlt');
  const treffer = readFileSync(envFile, 'utf-8').match(/^POSTGRES_URL=(.+)$/m);
  if (!treffer) throw new Error('POSTGRES_URL fehlt in der Env-Datei');
  return treffer[1];
}

async function main() {
  const anwenden = process.argv.includes('--apply');
  const erzwingen = process.argv.includes('--force');
  const pool = new pg.Pool({ connectionString: postgresUrl() });

  try {
    const { rows: spalte } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'banking_transactions' AND column_name = 'source'`);
    const { rows: tabelle } = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_name = 'expense_booking_proposals'`);

    let fremde = 0;
    if (spalte.length > 0) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM banking_transactions WHERE source <> 'fints'`);
      fremde = rows[0].n;
    }
    let bestaetigt = 0;
    if (tabelle[0].n > 0) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM expense_booking_proposals WHERE status = 'bestaetigt'`);
      bestaetigt = rows[0].n;
    }

    console.log('\nRücknahme V040\n');
    console.log('  Spalte source           :', spalte.length > 0 ? 'vorhanden' : 'nicht vorhanden');
    console.log('  Tabelle Vorschläge      :', tabelle[0].n > 0 ? 'vorhanden' : 'nicht vorhanden');
    console.log('  Umsätze mit source<>fints:', fremde);
    console.log('  bestätigte Vorschläge   :', bestaetigt);

    if (!anwenden) {
      console.log('\nEs wird NICHTS geändert. Ausführen mit --apply.');
      return;
    }

    if ((fremde > 0 || bestaetigt > 0) && !erzwingen) {
      console.error(
        `\nABBRUCH: ${fremde} Umsätze tragen eine andere Herkunft als 'fints' und `
        + `${bestaetigt} Vorschläge sind bestätigt. Beides ginge verloren.\n`
        + 'Entweder vorher gezielt bereinigen oder bewusst --force setzen.');
      process.exit(1);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TABLE IF EXISTS expense_booking_proposals');
      await client.query('DROP INDEX IF EXISTS idx_banking_transactions_source');
      await client.query('ALTER TABLE banking_transactions DROP COLUMN IF EXISTS source');
      await client.query(`DELETE FROM schema_version WHERE module = 'banking' AND version = 40`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    console.log('\nZurückgenommen.');
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });

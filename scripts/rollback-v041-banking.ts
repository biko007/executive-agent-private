#!/usr/bin/env bun
/**
 * Rücknahme von V041 (Owner-Freigabe 23.10.2026 „Paket Abend").
 *
 * Nimmt zurück:
 *   - Kontostatus 'neu' (Statusprüfung wieder nur 'active'/'archived')
 *   - banking_statement_balances (Tabelle wird entfernt)
 *   - schema_version banking 41
 *
 * Sicherung: Gibt es Konten mit Status 'neu', bricht der Lauf ab — die alte
 * Prüfung ließe sie nicht zu. Vorher zuordnen (aktiv oder archiviert).
 * Die gespeicherten Auszugssalden gehen verloren; sie lassen sich nur mit
 * einem neuen Abruf bei der Bank wiedergewinnen. Das gehört in den Report.
 *
 * Aufruf:
 *   bun run scripts/rollback-v041-banking.ts --dry-run
 *   bun run scripts/rollback-v041-banking.ts --apply
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
  const pool = new pg.Pool({ connectionString: postgresUrl() });

  try {
    const { rows: neu } = await pool.query(`SELECT count(*)::int AS n FROM banking_accounts WHERE status = 'neu'`);
    const { rows: tabelle } = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'banking_statement_balances'`);
    let auszuege = 0;
    if (tabelle[0].n > 0) {
      auszuege = (await pool.query(`SELECT count(*)::int AS n FROM banking_statement_balances`)).rows[0].n;
    }

    console.log('\nRücknahme V041\n');
    console.log('  Konten mit Status neu     :', neu[0].n);
    console.log('  Tabelle Auszugssalden     :', tabelle[0].n > 0 ? `vorhanden, ${auszuege} Einträge` : 'nicht vorhanden');

    if (!anwenden) {
      console.log('\nEs wird NICHTS geändert. Ausführen mit --apply.');
      return;
    }
    if (neu[0].n > 0) {
      console.error(`\nABBRUCH: ${neu[0].n} Konten haben den Status 'neu'. Erst zuordnen, dann zurücknehmen.`);
      process.exit(1);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TABLE IF EXISTS banking_statement_balances');
      await client.query('ALTER TABLE banking_accounts DROP CONSTRAINT IF EXISTS banking_accounts_status_check');
      await client.query(`ALTER TABLE banking_accounts ADD CONSTRAINT banking_accounts_status_check CHECK (status IN ('active', 'archived'))`);
      await client.query(`DELETE FROM schema_version WHERE module = 'banking' AND version = 41`);
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

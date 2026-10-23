#!/usr/bin/env bun
/**
 * V041 anwenden — Kontostatus „neu" und banking_statement_balances.
 *
 * Owner-Freigabe 23.10.2026 „Paket Abend". Rote Zone: Vor dem Lauf gehört ein frischer Dump
 * (scripts/cc-pre-backup.sh), nach dem Lauf der Nachweis aus --check.
 *
 * Aufruf:
 *   bun run src/modules/banking/migrate-v041.ts --dry-run
 *   bun run src/modules/banking/migrate-v041.ts --apply
 *   bun run src/modules/banking/migrate-v041.ts --check
 *
 * Rücknahme: bun run scripts/rollback-v041-banking.ts --apply
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MIGRATION_SQL = join(import.meta.dir, 'migrations/V041__banking_konto_neu_und_auszugssalden.sql');

function postgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL nicht gesetzt und ~/.config/openclaw/env fehlt');
  const treffer = readFileSync(envFile, 'utf-8').match(/^POSTGRES_URL=(.+)$/m);
  if (!treffer) throw new Error('POSTGRES_URL fehlt in der Env-Datei');
  return treffer[1];
}

async function zustand(pool: pg.Pool) {
  const { rows: pruefung } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'banking_accounts'::regclass AND conname = 'banking_accounts_status_check'`);
  const { rows: tabelle } = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name = 'banking_statement_balances'`);
  const { rows: version } = await pool.query(
    `SELECT version FROM schema_version WHERE module = 'banking' ORDER BY version DESC LIMIT 1`);
  const { rows: konten } = await pool.query(
    `SELECT status, count(*)::int AS n FROM banking_accounts GROUP BY 1 ORDER BY 1`);
  return { pruefung: pruefung[0]?.def ?? null, tabelleDa: tabelle[0].n > 0, version: version[0]?.version ?? null, konten };
}

function zeigen(z: Awaited<ReturnType<typeof zustand>>) {
  console.log('  Statusprüfung banking_accounts :', z.pruefung ?? 'keine');
  console.log('  banking_statement_balances     :', z.tabelleDa ? 'vorhanden' : 'nicht vorhanden');
  console.log('  schema_version banking         :', z.version ?? 'keiner');
  for (const k of z.konten) console.log(`  Konten ${String(k.status).padEnd(9)}: ${k.n}`);
}

async function main() {
  const modus = process.argv.includes('--apply') ? 'apply'
    : process.argv.includes('--check') ? 'check' : 'dry-run';
  const pool = new pg.Pool({ connectionString: postgresUrl() });

  try {
    console.log(`\nV041 — ${modus}\n`);
    console.log('Vorher:');
    const vorher = await zustand(pool);
    zeigen(vorher);

    if (modus === 'check') return;

    if (modus === 'dry-run') {
      const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
      console.log(`\nDDL-Datei: ${MIGRATION_SQL} (${ddl.length} Byte)`);
      console.log('Es wird NICHTS geändert. Anwenden mit --apply.');
      return;
    }

    const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(ddl);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    console.log('\nNachher:');
    zeigen(await zustand(pool));
    console.log('\nAngewendet. Rücknahme: bun run scripts/rollback-v041-banking.ts --apply');
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });

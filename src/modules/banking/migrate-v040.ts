#!/usr/bin/env bun
/**
 * V040 anwenden — banking_transactions.source und expense_booking_proposals.
 *
 * Paket 3, Teile 3 und 5. Rote Zone: Vor dem Lauf gehört ein frischer Dump
 * (scripts/cc-pre-backup.sh), nach dem Lauf der Nachweis aus --check.
 *
 * Aufruf:
 *   bun run src/modules/banking/migrate-v040.ts --dry-run
 *   bun run src/modules/banking/migrate-v040.ts --apply
 *   bun run src/modules/banking/migrate-v040.ts --check
 *
 * Rücknahme: bun run scripts/rollback-v040.ts --apply
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MIGRATION_SQL = join(import.meta.dir, 'migrations/V040__banking_source_und_buchungsvorschlaege.sql');

function postgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL nicht gesetzt und ~/.config/openclaw/env fehlt');
  const treffer = readFileSync(envFile, 'utf-8').match(/^POSTGRES_URL=(.+)$/m);
  if (!treffer) throw new Error('POSTGRES_URL fehlt in der Env-Datei');
  return treffer[1];
}

async function zustand(pool: pg.Pool) {
  const { rows: spalte } = await pool.query(
    `SELECT column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'banking_transactions' AND column_name = 'source'`);
  const { rows: tabelle } = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name = 'expense_booking_proposals'`);
  const { rows: version } = await pool.query(
    `SELECT version FROM schema_version WHERE module = 'banking' ORDER BY version DESC LIMIT 1`);
  const { rows: umsaetze } = await pool.query(
    spalte.length > 0
      ? `SELECT source, count(*)::int AS n FROM banking_transactions GROUP BY 1 ORDER BY 1`
      : `SELECT 'keine Spalte' AS source, count(*)::int AS n FROM banking_transactions`);
  return { spalte: spalte[0] || null, tabelleDa: tabelle[0].n > 0, version: version[0]?.version ?? null, umsaetze };
}

function zeigen(z: Awaited<ReturnType<typeof zustand>>) {
  console.log('  banking_transactions.source :', z.spalte
    ? `${z.spalte.data_type}, Vorgabe ${z.spalte.column_default}, nullable ${z.spalte.is_nullable}`
    : 'nicht vorhanden');
  console.log('  expense_booking_proposals   :', z.tabelleDa ? 'vorhanden' : 'nicht vorhanden');
  console.log('  schema_version banking      :', z.version ?? 'keiner');
  for (const u of z.umsaetze) console.log(`  Umsätze ${String(u.source).padEnd(12)}: ${u.n}`);
}

async function main() {
  const modus = process.argv.includes('--apply') ? 'apply'
    : process.argv.includes('--check') ? 'check' : 'dry-run';
  const pool = new pg.Pool({ connectionString: postgresUrl() });

  try {
    console.log(`\nV040 — ${modus}\n`);
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
    console.log('\nAngewendet. Rücknahme: bun run scripts/rollback-v040.ts --apply');
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });

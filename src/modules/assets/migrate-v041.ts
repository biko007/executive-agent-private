#!/usr/bin/env bun
/**
 * V041 anwenden — Verbrauchsanteil bei heating_split von 50-70 auf 0-100 %.
 *
 * Paket 3c, Teil A1. Rote Zone: Vor dem Lauf gehört ein frischer Dump
 * (scripts/cc-pre-backup.sh), nach dem Lauf der Nachweis aus --check.
 *
 * Aufruf:
 *   bun run src/modules/assets/migrate-v041.ts --dry-run
 *   bun run src/modules/assets/migrate-v041.ts --apply
 *   bun run src/modules/assets/migrate-v041.ts --check
 *
 * Rücknahme: bun run scripts/rollback-v041.ts --apply
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MIGRATION_SQL = join(import.meta.dir, 'migrations/V041__heizkosten_verbrauchsanteil_frei.sql');

function postgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL nicht gesetzt und ~/.config/openclaw/env fehlt');
  const treffer = readFileSync(envFile, 'utf-8').match(/^POSTGRES_URL=(.+)$/m);
  if (!treffer) throw new Error('POSTGRES_URL fehlt in der Env-Datei');
  return treffer[1];
}

async function zustand(pool: pg.Pool) {
  const { rows: check } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'allocation_rules'::regclass AND conname = 'allocation_rules_check1'`);
  const { rows: version } = await pool.query(
    `SELECT version FROM schema_version WHERE module = 'assets' ORDER BY version DESC LIMIT 1`);
  const { rows: regeln } = await pool.query(
    `SELECT consumption_share_percent AS anteil, count(*)::int AS n
       FROM allocation_rules WHERE key_type = 'heating_split' GROUP BY 1 ORDER BY 1`);
  const def = check[0]?.def || '';
  return {
    def,
    grenze: def.includes('(50)') ? '50 bis 70 %' : def.includes('(100)') ? '0 bis 100 %' : 'unbekannt',
    version: version[0]?.version ?? null,
    regeln,
  };
}

function zeigen(z: Awaited<ReturnType<typeof zustand>>) {
  console.log('  Verbrauchsanteil erlaubt :', z.grenze);
  console.log('  schema_version assets    :', z.version ?? 'keiner');
  for (const r of z.regeln) console.log(`  heating_split mit ${String(r.anteil).padStart(6)} % : ${r.n} Regeln`);
}

async function main() {
  const modus = process.argv.includes('--apply') ? 'apply'
    : process.argv.includes('--check') ? 'check' : 'dry-run';
  const pool = new pg.Pool({ connectionString: postgresUrl() });

  try {
    console.log(`\nV041 — ${modus}\n`);
    console.log('Vorher:');
    zeigen(await zustand(pool));

    if (modus === 'check') return;

    const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
    if (modus === 'dry-run') {
      console.log(`\nDDL-Datei: ${MIGRATION_SQL} (${ddl.length} Byte)`);
      console.log('Es wird NICHTS geändert. Anwenden mit --apply.');
      return;
    }

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
    console.log('\nAngewendet. Rücknahme: bun run scripts/rollback-v041.ts --apply');
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });

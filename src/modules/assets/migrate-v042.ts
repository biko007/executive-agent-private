#!/usr/bin/env bun
/**
 * V042 anwenden — Mietforderungen, Zahlungszuordnung, Dublettenmarkierung.
 *
 * Rote Zone: Vor dem Lauf gehoert ein frischer Dump, nach dem Lauf der
 * Nachweis aus --check in den Report.
 *
 * Aufruf:
 *   bun run src/modules/assets/migrate-v042.ts --dry-run
 *   bun run src/modules/assets/migrate-v042.ts --apply
 *   bun run src/modules/assets/migrate-v042.ts --check
 *
 * Ruecknahme: bun run scripts/rollback-v042.ts --apply
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MIGRATION_SQL = join(import.meta.dir, 'migrations/V042__mietforderungen_und_zahlungszuordnung.sql');

function postgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL nicht gesetzt und ~/.config/openclaw/env fehlt');
  const treffer = readFileSync(envFile, 'utf-8').match(/^POSTGRES_URL=(.+)$/m);
  if (!treffer) throw new Error('POSTGRES_URL fehlt in der Env-Datei');
  return treffer[1];
}

/** Was nach der Migration da sein muss — dieselbe Liste fuer Pruefung und Nachweis. */
const ERWARTET = {
  spalten: [
    ['leases', 'owner_hauptmieter'],
    ['rent_ledger', 'kaltmiete_amount'], ['rent_ledger', 'nk_amount'],
    ['rent_ledger', 'heizkosten_amount'], ['rent_ledger', 'garage_amount'],
    ['rent_ledger', 'kitchen_amount'], ['rent_ledger', 'anteil'],
    ['rent_ledger', 'erzeugt'], ['rent_ledger', 'gilt_als_bezahlt'],
    ['banking_transactions', 'duplicate_of'],
  ] as [string, string][],
  tabellen: ['lease_payers', 'rent_payment_links'],
};

async function zustand(pool: pg.Pool) {
  const spalten: Record<string, boolean> = {};
  for (const [t, c] of ERWARTET.spalten) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, c]);
    spalten[`${t}.${c}`] = rows.length > 0;
  }
  const tabellen: Record<string, boolean> = {};
  for (const t of ERWARTET.tabellen) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t]);
    tabellen[t] = rows.length > 0;
  }
  const { rows: v } = await pool.query(
    `SELECT max(version)::int AS version FROM schema_version WHERE module='assets'`);
  const { rows: z } = await pool.query(`SELECT
      (SELECT count(*)::int FROM leases)               AS leases,
      (SELECT count(*)::int FROM rent_ledger)          AS forderungen,
      (SELECT count(*)::int FROM banking_transactions) AS umsaetze`);
  return { spalten, tabellen, version: v[0]?.version ?? null, bestand: z[0] };
}

function zeigen(titel: string, s: Awaited<ReturnType<typeof zustand>>) {
  console.log(`\n${titel}`);
  console.log(`  schema_version assets : ${s.version}`);
  for (const [k, v] of Object.entries(s.spalten)) console.log(`  Spalte ${k.padEnd(38)} ${v ? 'vorhanden' : 'FEHLT'}`);
  for (const [k, v] of Object.entries(s.tabellen)) console.log(`  Tabelle ${k.padEnd(37)} ${v ? 'vorhanden' : 'FEHLT'}`);
  console.log(`  Bestand: ${s.bestand.leases} Mietverhaeltnisse, ${s.bestand.forderungen} Forderungen, `
    + `${s.bestand.umsaetze} Bankumsaetze`);
}

async function main() {
  const modus = process.argv.includes('--apply') ? 'anwenden'
    : process.argv.includes('--check') ? 'check' : 'probelauf';
  const pool = new pg.Pool({ connectionString: postgresUrl() });
  try {
    const vorher = await zustand(pool);
    zeigen(modus === 'check' ? 'Zustand' : 'Zustand vorher', vorher);
    if (modus === 'check') return;

    const vollstaendig = Object.values(vorher.spalten).every(Boolean)
      && Object.values(vorher.tabellen).every(Boolean);
    if (vollstaendig && (vorher.version ?? 0) >= 42) {
      console.log('\nV042 ist bereits angewandt — nichts zu tun.');
      return;
    }
    if (modus === 'probelauf') {
      console.log('\nPROBELAUF. Angewandt wuerde:');
      console.log(`  ${MIGRATION_SQL}`);
      console.log('  Fuenf additive Aenderungen, keine Spalte und keine Zeile entfaellt.');
      return;
    }

    const sql = readFileSync(MIGRATION_SQL, 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const nachher = await zustand(pool);
    zeigen('Zustand nachher', nachher);
    const fehlt = [...Object.entries(nachher.spalten), ...Object.entries(nachher.tabellen)]
      .filter(([, v]) => !v).map(([k]) => k);
    if (fehlt.length) throw new Error(`Nach dem Lauf fehlen noch: ${fehlt.join(', ')}`);
    console.log('\nV042 angewandt.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });

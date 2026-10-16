#!/usr/bin/env bun
/**
 * V043 anwenden — Objektsteckbrief: Felder mit Quelle und Stand.
 *
 * Rote Zone: Vor dem Lauf gehoert ein frischer Dump, nach dem Lauf der
 * Nachweis aus --check in den Report.
 *
 * Aufruf:
 *   bun run src/modules/assets/migrate-v043.ts --dry-run
 *   bun run src/modules/assets/migrate-v043.ts --apply
 *   bun run src/modules/assets/migrate-v043.ts --check
 *
 * Ruecknahme: bun run scripts/rollback-v043.ts --apply
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MIGRATION_SQL = join(import.meta.dir, 'migrations/V043__objektsteckbrief.sql');

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
  spalten: [] as [string, string][],
  tabellen: ['objekt_feld_katalog', 'objekt_felder', 'objekt_fristen',
             'objekt_versicherungen', 'objekt_dienstleister'],
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
  const katalog = tabellen['objekt_feld_katalog']
    ? (await pool.query(`SELECT count(*)::int AS n FROM objekt_feld_katalog`)).rows[0].n : 0;
  const werte = tabellen['objekt_felder']
    ? (await pool.query(`SELECT count(*)::int AS n FROM objekt_felder`)).rows[0].n : 0;
  const { rows: z } = await pool.query(`SELECT (SELECT count(*)::int FROM properties) AS objekte`);
  return { spalten, tabellen, version: v[0]?.version ?? null,
    bestand: { objekte: z[0].objekte, katalog, werte } };
}

function zeigen(titel: string, s: Awaited<ReturnType<typeof zustand>>) {
  console.log(`\n${titel}`);
  console.log(`  schema_version assets : ${s.version}`);
  for (const [k, v] of Object.entries(s.spalten)) console.log(`  Spalte ${k.padEnd(38)} ${v ? 'vorhanden' : 'FEHLT'}`);
  for (const [k, v] of Object.entries(s.tabellen)) console.log(`  Tabelle ${k.padEnd(37)} ${v ? 'vorhanden' : 'FEHLT'}`);
  console.log(`  Bestand: ${s.bestand.objekte} Objekte, ${s.bestand.katalog} Katalogfelder, `
    + `${s.bestand.werte} erfasste Werte`);
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
    if (vollstaendig && (vorher.version ?? 0) >= 43) {
      console.log('\nV043 ist bereits angewandt — nichts zu tun.');
      return;
    }
    if (modus === 'probelauf') {
      console.log('\nPROBELAUF. Angewandt wuerde:');
      console.log(`  ${MIGRATION_SQL}`);
      console.log('  Fuenf neue Tabellen plus Katalogeintraege. Nichts Bestehendes wird angefasst.');
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
    console.log('\nV043 angewandt.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });

#!/usr/bin/env bun
/**
 * scripts/migrate-steckbrief — die Modul-Migrationen der Assets anwenden.
 *
 * WARUM ES DIESES SKRIPT GIBT. Der gemeinsame Läufer `runMigrations` in
 * `src/shared/db/index.ts` erkennt nur Dateinamen der Form `NNN_*.sql`. Die
 * Assets-Migrationen heißen seit jeher `V0NN__*.sql` und werden von ihm
 * stillschweigend übersprungen — sie wurden deshalb bisher jedes Mal von Hand
 * angewandt. Das ist genau die Stelle, an der ein Schutzmechanismus ins Leere
 * greift: Der rote Befehl heißt `migrate … --apply`, und wer von Hand migriert,
 * löst ihn nie aus.
 *
 * Dieses Skript heißt deshalb `migrate-…` und verlangt `--apply`. Damit fällt
 * es unter die roten Befehle aus `red-zone.conf` und braucht eine Freigabe —
 * so, wie es gedacht war. Es liegt zudem unter `scripts/migrate-*.ts` und ist
 * damit auch ein roter Pfad: Eine Änderung daran braucht `/arm` zum Übertragen.
 *
 * Aufruf:
 *   bun run scripts/migrate-steckbrief.ts              Probelauf, schreibt nichts
 *   bun run scripts/migrate-steckbrief.ts --apply      anwenden (braucht /arm)
 *
 * Jede Datei läuft in einer eigenen Transaktion. Schlägt sie fehl, wird sie
 * zurückgerollt und das Skript bricht ab — eine halb angewandte Migration
 * wäre schlimmer als gar keine.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function envWert(s: string): string {
  if (process.env[s]) return process.env[s]!;
  const d = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(d)) throw new Error(`${s} fehlt`);
  const t = readFileSync(d, 'utf-8').match(new RegExp(`^${s}=(.+)$`, 'm'));
  if (!t) throw new Error(`${s} fehlt in der Env-Datei`);
  return t[1].trim();
}
if (!process.env.POSTGRES_URL) process.env.POSTGRES_URL = envWert('POSTGRES_URL');

const { getClient, query } = await import('../src/shared/db/index.js');

const MODUL = 'assets';
const VERZEICHNIS = join(import.meta.dir, '..', 'src', 'modules', 'assets', 'migrations');
const anwenden = process.argv.includes('--apply');

/* Die Versionsnummer steckt im Namen: V043__objektsteckbrief.sql → 43. */
const dateien = readdirSync(VERZEICHNIS)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ datei: f, version: Number(f.match(/^V?(\d+)_/)?.[1] ?? NaN) }))
  .filter((e) => Number.isFinite(e.version))
  .sort((a, b) => a.version - b.version);

await query(`
  CREATE TABLE IF NOT EXISTS schema_version (
    module TEXT NOT NULL, version INTEGER NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (module, version))`);

const { rows: vorhanden } = await query<{ version: number }>(
  'SELECT version FROM schema_version WHERE module = $1', [MODUL]);
const schon = new Set(vorhanden.map((r) => r.version));

const offen = dateien.filter((e) => !schon.has(e.version));
if (offen.length === 0) {
  console.log(`Nichts offen — ${MODUL} ist auf Stand (${dateien.length} Dateien, alle angewandt).`);
  process.exit(0);
}

console.log(`Offen: ${offen.map((e) => `V${e.version}`).join(', ')}`);
for (const e of offen) console.log(`  ${e.datei}`);

if (!anwenden) {
  console.log('\nProbelauf — nichts geschrieben. Mit --apply anwenden.');
  process.exit(0);
}

for (const e of offen) {
  const sql = readFileSync(join(VERZEICHNIS, e.datei), 'utf-8');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_version (module, version) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [MODUL, e.version]);
    await client.query('COMMIT');
    console.log(`angewandt: ${e.datei}`);
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error(`FEHLGESCHLAGEN und zurueckgerollt: ${e.datei}\n  ${err.message}`);
    process.exit(1);
  } finally {
    client.release();
  }
}

console.log(`\n${offen.length} Migration(en) angewandt.`);
process.exit(0);

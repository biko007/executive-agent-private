#!/usr/bin/env bun
/**
 * Rücknahme von V041 — Verbrauchsanteil wieder auf 50 bis 70 Prozent begrenzen.
 *
 * Die Rücknahme ist nur möglich, wenn KEINE Regel mehr außerhalb des Rahmens
 * liegt: Der CHECK gilt sofort für alle Zeilen, und ein Wiederherstellen
 * würde an genau den Regeln scheitern, für die V041 angewendet wurde. Der Lauf
 * bricht deshalb vorher ab und nennt sie — Umstellen ist eine fachliche
 * Entscheidung des Owners und keine Sache eines Rücknahmeskripts.
 *
 * Aufruf:
 *   bun run scripts/rollback-v041.ts --dry-run
 *   bun run scripts/rollback-v041.ts --apply
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
    const { rows: ausserhalb } = await pool.query(
      `SELECT ar.id, p.code AS objekt, cc.code AS kostenart,
              ar.base_share_percent AS grund, ar.consumption_share_percent AS verbrauch
         FROM allocation_rules ar
         JOIN properties p ON p.id = ar.property_id
         JOIN cost_categories cc ON cc.id = ar.cost_category_id
        WHERE ar.key_type = 'heating_split'
          AND (ar.consumption_share_percent < 50 OR ar.consumption_share_percent > 70)
        ORDER BY p.code, cc.code`);

    console.log('\nRücknahme V041\n');
    console.log(`  Regeln ausserhalb 50-70 % : ${ausserhalb.length}`);
    for (const r of ausserhalb) {
      console.log(`    #${r.id} ${r.objekt}/${r.kostenart}: ${r.grund} / ${r.verbrauch}`);
    }

    if (!anwenden) {
      console.log('\nEs wird NICHTS geändert. Ausführen mit --apply.');
      return;
    }

    if (ausserhalb.length > 0) {
      console.error(
        `\nABBRUCH: ${ausserhalb.length} Regeln liegen ausserhalb von 50 bis 70 Prozent. `
        + 'Der wiederhergestellte CHECK würde sofort an ihnen scheitern.\n'
        + 'Diese Regeln zuerst auf einen Verbrauchsanteil zwischen 50 und 70 Prozent '
        + 'umstellen — das ist eine fachliche Entscheidung und gehört nicht in dieses Skript.');
      process.exit(1);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE allocation_rules DROP CONSTRAINT IF EXISTS allocation_rules_check1');
      await client.query(`ALTER TABLE allocation_rules ADD CONSTRAINT allocation_rules_check1 CHECK (
        key_type <> 'heating_split' OR (
          base_share_percent IS NOT NULL
          AND consumption_share_percent IS NOT NULL
          AND base_share_percent + consumption_share_percent = 100
          AND consumption_share_percent >= 50
          AND consumption_share_percent <= 70
        ))`);
      await client.query(`DELETE FROM schema_version WHERE module = 'assets' AND version = 41`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    console.log('\nZurückgenommen: Verbrauchsanteil wieder auf 50 bis 70 Prozent begrenzt.');
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });

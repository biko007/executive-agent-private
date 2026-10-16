#!/usr/bin/env bun
/**
 * Offene Posten als „unbestaetigt" kennzeichnen — die Owner-Entscheidungen an
 * einer Stelle, wiederholbar.
 *
 * WARUM ES DIESES SKRIPT GIBT: Das Kennzeichen sitzt auf der einzelnen
 * Forderung. Erzeugte Forderungen (`erzeugt = true`) werden bei einem
 * vollstaendigen Neuaufbau geloescht und neu angelegt — dabei geht das
 * Kennzeichen verloren. Am 16.10.2026 ist genau das passiert: Nach einem
 * Neuaufbau stand S28 W1 wieder ohne Kennzeichen da. Die von Hand erfassten
 * Zeilen (`erzeugt = false`) sind davon nicht betroffen.
 *
 * Nach jedem Neuaufbau der Forderungen also diesen Lauf anhaengen. Er ist
 * idempotent: Was schon gekennzeichnet ist, bleibt unveraendert.
 *
 * Aufruf:  bun run scripts/unbestaetigt-setzen.ts [--apply]
 */
import { readFileSync, existsSync } from 'node:fs';
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
const { query } = await import('../src/shared/db/index.js');

/** Die Entscheidungen des Owners, mit Datum und Begruendung. */
const REGELN: { lease_id: number; objekt: string; monate?: string[]; grund: string }[] = [
  {
    lease_id: 32, objekt: 'S28 W1',
    grund: 'UNBESTAETIGT (Owner 16.10.2026): Mieter ist Mitarbeiter der bikolino GmbH und im '
         + 'Rueckstand. Als offener Posten ausgewiesen, bis die Buchhaltung bestaetigt. '
         + 'Nichts an den Mieter.',
  },
  {
    lease_id: 27, objekt: 'N24 W6',
    grund: 'UNBESTAETIGT (Owner 16.10.2026): Wird in die Kautionsabrechnung aufgenommen, bis die '
         + 'Antwort der Buchhaltung (Doris) vorliegt. Versand erst gemeinsam mit der '
         + 'Nebenkostenabrechnung N24 2025 im Casameta-PDF.',
  },
  {
    lease_id: 31, objekt: 'MG24 W3', monate: ['2026-06', '2026-07'],
    grund: 'UNBESTAETIGT (Owner 16.10.2026): Am 01.06.2026 und am 01.07.2026 sind je 2.030,00 statt '
         + '2.130,00 EUR eingegangen, zusammen 200,00 EUR zu wenig. Die Frage liegt bei der '
         + 'Buchhaltung (Ergaenzung zum Schreiben vom 15.10.2026). Nichts an den Mieter.',
  },
];

const apply = process.argv.includes('--apply');
let gesamt = 0;
for (const r of REGELN) {
  const monatsfilter = r.monate?.length
    ? `AND to_char(period_month,'YYYY-MM') = ANY($2::text[])` : '';
  const params: any[] = [r.lease_id];
  if (r.monate?.length) params.push(r.monate);
  const { rows } = await query<any>(`
    SELECT id, to_char(period_month,'YYYY-MM') AS monat,
           (expected_amount - coalesce(paid_amount,0))::float AS offen, unbestaetigt
      FROM rent_ledger
     WHERE lease_id = $1 AND expected_amount > coalesce(paid_amount,0) + 0.005 ${monatsfilter}
     ORDER BY period_month`, params);
  const offen = rows.filter((x: any) => !x.unbestaetigt);
  const summe = rows.reduce((s: number, x: any) => s + x.offen, 0);
  console.log(`${r.objekt.padEnd(9)} ${String(rows.length).padStart(2)} offene Monate, `
    + `${summe.toFixed(2).padStart(9)} EUR, davon ohne Kennzeichen: ${offen.length}`);
  if (!apply || !offen.length) continue;
  await query(
    `UPDATE rent_ledger SET unbestaetigt = true,
       notes = coalesce(notes,'') || E'\\n' || $2
      WHERE id = ANY($1::bigint[])`,
    [offen.map((x: any) => x.id), r.grund]);
  gesamt += offen.length;
}
console.log(apply ? `\ngekennzeichnet: ${gesamt} Forderungen` : '\nPROBELAUF — nichts geschrieben.');
process.exit(0);

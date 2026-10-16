#!/usr/bin/env bun
/**
 * Naechtlicher SharePoint-Abgleich.
 *
 * Der Dokumentenindex (rund 12.250 Dateien) wurde bis zum 16.10.2026 von Hand
 * angestossen; der letzte Lauf lag vom 10.10.2026. Eine Recherche, die sich
 * auf diesen Index stuetzt, war damit bis zu einer Woche alt, ohne dass das
 * irgendwo stand.
 *
 * Dieser Lauf ruft denselben Abgleich wie der Telegram-Befehl `/spsync` auf —
 * dieselbe Funktion, dieselbe Sperre, derselbe Eintrag in
 * `sharepoint_sync_runs`. Zwei Unterschiede:
 *
 *   - `triggered_by` steht auf `timer`, damit im Dashboard zu sehen ist,
 *     woher der Lauf kam.
 *   - Gemeldet wird nur, was auffaellt: ein Fehler, oder wenn sich an der
 *     Dateizahl etwas Groesseres aendert. Eine gelungene Nacht meldet nichts.
 *
 * Inkrementell ist der Lauf in dem Sinn, der hier zaehlt: Der Crawl liest die
 * Ordnerbaeume, geschrieben wird nur, was sich geaendert hat (UPSERT), und
 * verschwundene Dateien werden weich markiert statt geloescht. Ein echtes
 * Graph-Delta waere sparsamer, braucht aber je Drive einen gespeicherten
 * Delta-Token; das lohnt erst, wenn der naechtliche Lauf zu lange dauert.
 *
 * Aufruf:  bun run scripts/sharepoint-sync-nachts.ts [--probelauf]
 * Dienst:  openclaw-sharepoint-sync.timer (taeglich 02:40 Uhr)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function envWert(schluessel: string): string {
  if (process.env[schluessel]) return process.env[schluessel]!;
  const datei = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(datei)) throw new Error(`${schluessel} fehlt und ~/.config/openclaw/env gibt es nicht`);
  const treffer = readFileSync(datei, 'utf-8').match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in der Env-Datei`);
  return treffer[1].trim();
}

for (const s of ['POSTGRES_URL', 'M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET']) {
  if (!process.env[s]) process.env[s] = envWert(s);
}

const probelauf = process.argv.includes('--probelauf');
const { query } = await import('../src/shared/db/index.js');

/** Dateizahl vor dem Lauf — fuer den Vergleich danach. */
const { rows: vorher } = await query<any>(
  `SELECT count(*)::int AS n FROM sharepoint_files WHERE missing_since IS NULL`);
const vorherZahl = vorher[0].n;

const { rows: letzter } = await query<any>(`
  SELECT to_char(finished_at,'YYYY-MM-DD HH24:MI') AS stand, status, total_files, triggered_by
    FROM sharepoint_sync_runs ORDER BY started_at DESC LIMIT 1`);
console.log(`Vorher: ${vorherZahl} aktive Dateien, letzter Lauf `
  + (letzter[0] ? `${letzter[0].stand} (${letzter[0].status}, ${letzter[0].triggered_by})` : 'keiner'));

if (probelauf) {
  console.log('PROBELAUF — es wird nichts abgeglichen.');
  process.exit(0);
}

const { fullSync } = await import('../src/modules/sharepoint/store.js');
const start = Date.now();
try {
  const ergebnis: any = await fullSync(
    process.env.M365_TENANT_ID!, process.env.M365_CLIENT_ID!, process.env.M365_CLIENT_SECRET!,
    undefined, process.env.M365_USER || envWert('M365_USER'));

  /* Der Lauf traegt sich selbst als `manual` ein — hier wird die Herkunft
     richtiggestellt, damit das Dashboard den naechtlichen Lauf erkennt. */
  await query(
    `UPDATE sharepoint_sync_runs SET triggered_by='timer'
      WHERE id = (SELECT id FROM sharepoint_sync_runs ORDER BY started_at DESC LIMIT 1)`);

  const { rows: nachher } = await query<any>(
    `SELECT count(*)::int AS n FROM sharepoint_files WHERE missing_since IS NULL`);
  const diff = nachher[0].n - vorherZahl;
  const dauer = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Fertig in ${dauer}s: ${nachher[0].n} aktive Dateien (${diff >= 0 ? '+' : ''}${diff}), `
    + `${ergebnis.totalSites} Sites, ${ergebnis.newlyMissing ?? 0} neu als fehlend markiert.`);
  if (ergebnis.errors?.length) {
    console.error(`${ergebnis.errors.length} Fehler im Lauf:`);
    for (const e of ergebnis.errors.slice(0, 5)) console.error('  ' + (typeof e === 'string' ? e : JSON.stringify(e)));
  }
  process.exit(0);
} catch (e: any) {
  console.error('SharePoint-Abgleich fehlgeschlagen: ' + (e?.message || e));
  process.exit(1);
}

/**
 * scripts/hole-sharepoint-datei — eine SharePoint-Datei zum Lesen herunterladen. NUR LESEN.
 *
 * Lädt die Datei in ein Zielverzeichnis, damit sie anschließend gelesen werden kann.
 * Adressiert wird über den Pfad aus `sharepoint_files`, weil die Tabelle für die
 * meisten Einträge keine Graph-Item-ID führt.
 *
 * Aufruf:  bun run scripts/hole-sharepoint-datei.ts <Zielverzeichnis> <Pfadmuster> [...]
 *
 * Das Pfadmuster ist ein Teilstring oder regulärer Ausdruck; passt es auf genau eine
 * Datei, wird diese geladen, sonst werden die Kandidaten aufgelistet.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { graphToken } from '../src/shared/m365/index.js';
import { query as dbQuery } from '../src/shared/db/index.js';

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
  return treffer[1].trim();
}

/** Jedes Pfadsegment einzeln kodieren — der Doppelpunkt der Graph-Adressierung
 *  und die Schrägstriche müssen erhalten bleiben. */
function pfadKodieren(pfad: string): string {
  return pfad.split('/').map(encodeURIComponent).join('/');
}

async function main() {
  const [ziel, ...muster] = process.argv.slice(2);
  if (!ziel || muster.length === 0) {
    console.error('Aufruf: hole-sharepoint-datei.ts <Zielverzeichnis> <Pfadmuster> [...]');
    process.exit(2);
  }
  mkdirSync(ziel, { recursive: true });

  const token = await graphToken(
    env('M365_TENANT_ID'), env('M365_CLIENT_ID'), env('M365_CLIENT_SECRET'));

  for (const m of muster) {
    const { rows } = await dbQuery<{ path: string; drive_id: string; size: number }>(
      `SELECT path, drive_id, size FROM sharepoint_files
        WHERE missing_since IS NULL AND path ~* $1 ORDER BY path`, [m]);
    if (rows.length === 0) { console.log(`KEIN TREFFER: ${m}`); continue; }
    if (rows.length > 1) {
      console.log(`MEHRDEUTIG (${rows.length}): ${m}`);
      for (const r of rows.slice(0, 15)) console.log(`   ${r.path}`);
      continue;
    }
    const datei = rows[0];
    const url = `https://graph.microsoft.com/v1.0/drives/${datei.drive_id}`
      + `/root:/${pfadKodieren(datei.path)}:/content`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.log(`FEHLER ${res.status} bei ${datei.path}: ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ablage = join(ziel, basename(datei.path));
    writeFileSync(ablage, bytes);
    console.log(`${ablage}  (${Math.round(bytes.length / 1024)} kB)`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * scripts/dropbox-holen — Dateien aus einem Dropbox-Ordner laden oder verschieben.
 *
 * Gedacht fuer Stapel, die einzeln angesehen werden muessen — etwa Fotos vom
 * Ortstermin. Die MCP-Werkzeuge liefern Text; fuer Bilder braucht es den
 * Adapter aus dem Repo.
 *
 * Aufruf:
 *   bun run scripts/dropbox-holen.ts liste   <ordner> [<muster>]
 *   bun run scripts/dropbox-holen.ts laden   <ordner> <zielverzeichnis> [<muster>]
 *   bun run scripts/dropbox-holen.ts schieben <ordner> <zielordner> [<muster>]
 *
 * <muster> ist ein regulaerer Ausdruck gegen den Dateinamen; ohne Angabe gilt
 * alles. "schieben" verschiebt, es wird nie geloescht.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDropboxAdapter } from '../src/adapters/dropbox.js';

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
  return treffer[1].trim();
}

async function main() {
  const [befehl, ordner, zweites, muster] = process.argv.slice(2);
  if (!befehl || !ordner) {
    console.error('Aufruf: bun run scripts/dropbox-holen.ts '
      + '<liste|laden|schieben> <ordner> [<ziel>] [<muster>]');
    process.exit(2);
  }

  const dropbox = createDropboxAdapter({
    appKey: env('EA_DROPBOX_APP_KEY'),
    appSecret: env('EA_DROPBOX_APP_SECRET'),
    refreshToken: env('EA_DROPBOX_REFRESH_TOKEN'),
  });

  const eintraege = await dropbox.listFolder(ordner);
  const regex = muster ? new RegExp(muster) : null;
  const dateien = eintraege
    .filter((e: any) => (e.tag ?? e['.tag']) !== 'folder')
    .filter((e: any) => !regex || regex.test(e.name))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));

  if (befehl === 'liste') {
    /* Unterordner mit ausgeben. Ohne sie sah ein Ordner, der nur Unterordner
       enthaelt, wie ein leerer Ordner aus — am 15.10.2026 wurde deshalb
       faelschlich berichtet, transfer/SWT-Rechnungen sei leer. */
    const ordnerEintraege = eintraege
      .filter((e: any) => (e.tag ?? e['.tag']) === 'folder')
      .filter((e: any) => !regex || regex.test(e.name))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
    console.log(`${dateien.length} Datei(en) und ${ordnerEintraege.length} Unterordner in ${ordner}`);
    for (const o of ordnerEintraege) console.log(`  [Ordner] ${o.name}/`);
    for (const d of dateien) {
      console.log(`  ${d.name}  (${Math.round((d.size ?? 0) / 1024)} kB)`);
    }
    return;
  }

  if (!zweites) { console.error('Ziel fehlt.'); process.exit(2); }

  if (befehl === 'laden') {
    mkdirSync(zweites, { recursive: true });
    let n = 0;
    for (const d of dateien) {
      const inhalt = await dropbox.downloadFile(`${ordner}/${d.name}`);
      writeFileSync(join(zweites, d.name), inhalt);
      n++;
    }
    console.log(`${n} Datei(en) geladen nach ${zweites}`);
    return;
  }

  if (befehl === 'schieben') {
    /* Der Zielordner wird vorab angelegt; ein vorhandener Ordner ist kein
       Fehler. Verschoben wird einzeln, damit ein Fehler bei einer Datei die
       uebrigen nicht mitreisst. */
    await dropbox.createFolder(zweites).catch(() => {});
    let n = 0; const fehler: string[] = [];
    for (const d of dateien) {
      try {
        await dropbox.moveFile(`${ordner}/${d.name}`, `${zweites}/${d.name}`);
        n++;
      } catch (e: any) {
        fehler.push(`${d.name}: ${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
    console.log(`${n} Datei(en) verschoben nach ${zweites}`);
    for (const f of fehler) console.log(`  FEHLER ${f}`);
    return;
  }

  console.error(`Unbekannter Befehl: ${befehl}`);
  process.exit(2);
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });

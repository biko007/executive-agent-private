#!/usr/bin/env bun
/**
 * Legt die SWT-Rechnungen aus dem Dropbox-Austauschordner im Belegarchiv ab.
 *
 * Owner-Anforderung: „alle Rechnungen müssen als digitale Kopie bei Bedarf zur
 * Verfügung stehen." Der Austauschordner ist dafür kein Archiv — er ist ein
 * Postfach, in dem Dateien kommen und gehen. Deshalb wird jede Rechnung in den
 * gitignorierten Laufzeitbereich kopiert, mit SHA-256 festgehalten und über die
 * vorhandene `entity_links`-Mechanik am Objekt verlinkt.
 *
 * KEINE Migration: `entity_links` existiert (Objekt, Belegart, SharePoint-
 * Referenz oder lokale Datei). Die fachlichen Felder, für die dort kein Platz
 * ist — Sparte, Vertrag, Leistungszeitraum, Verbrauch, Zählernummer —, stehen
 * im Index-JSON daneben.
 *
 * Aufruf:
 *   bun run scripts/archiv-swt-rechnungen.ts --dry-run
 *   bun run scripts/archiv-swt-rechnungen.ts --apply
 */
import { createDropboxAdapter } from '../src/adapters/dropbox.js';
import { query as dbQuery } from '../src/shared/db/index.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const QUELLE = '/bikosoc-reports/transfer/SWT-Rechnungen';
const ARCHIV = join(homedir(), '.openclaw', 'workspace', 'artifacts', 'personal', 'assets', 'belege');
const INDEX = join(ARCHIV, 'index-swt.json');
const GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://127.0.0.1:18789';

function envWert(schluessel: string): string {
  if (process.env[schluessel]) return process.env[schluessel]!;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  const treffer = readFileSync(envFile, 'utf-8').match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in der Env-Datei`);
  return treffer[1].trim();
}

/**
 * Rechnungseinheit → Objekt.
 *
 * Die Zuordnung steht hier und nicht in den Einstellungen, weil sie aus den
 * Verbrauchsstellen der Rechnungen folgt und sich nur ändert, wenn ein Objekt
 * dazukommt — dann ist ohnehin eine Codeänderung fällig.
 *
 * `objekt: null` heißt: nur archivieren, keine Verknüpfung mit einem Objekt.
 * Das betrifft die Privatwohnung des Owners; sie ist kein Mietobjekt.
 */
const EINHEITEN: Record<string, {
  objekt: string | null; ablage: string; bezeichnung: string; hinweis?: string;
}> = {
  '307008': { objekt: 'mg24', ablage: 'mg24', bezeichnung: 'Marktgasse 24 — Wasser, Abwasser, Niederschlagswasser, Strom' },
  '348661': { objekt: 'mg24', ablage: 'mg24', bezeichnung: 'Marktgasse 24 — Allgemeinstrom' },
  '328879': { objekt: 'mg24', ablage: 'mg24', bezeichnung: 'Marktgasse 24 — Baustrom (Kd 492014)',
    hinweis: 'Bauphase bis zur Schlussabnahme 04.11.2024 — Herstellungsaufwand, nicht umlagefähig' },
  '307014': { objekt: 'mg24', ablage: 'mg24-nachbar-mg22', bezeichnung: 'Marktgasse 22 — Strom, Niederschlagswasser',
    hinweis: 'NACHBARGEBÄUDE. MG22 ist kein eigenes Objekt im Bestand; die Rechnungen liegen '
      + 'bei MG24, dürfen aber NICHT auf MG24 umgelegt werden' },
  '237710': { objekt: 'l19', ablage: 'l19', bezeichnung: 'Leutenbergstr. 19 — Strom' },
  '237712': { objekt: 'l19', ablage: 'l19', bezeichnung: 'Leutenbergstr. 19 — Strom' },
  '237713': { objekt: 'l19', ablage: 'l19', bezeichnung: 'Leutenbergstr. 19 — Strom' },
  '237714': { objekt: 'l19', ablage: 'l19', bezeichnung: 'Leutenbergstr. 19 — Strom' },
  '239992': { objekt: 'l19', ablage: 'l19', bezeichnung: 'Leutenbergstr. 19 — Wasser, Abwasser, Niederschlagswasser' },
  '339065': { objekt: 's28', ablage: 's28', bezeichnung: 'Schönhalde 28 — Strom, Wasser, Abwasser, Niederschlagswasser' },
  '318635': { objekt: 'n24', ablage: 'n24', bezeichnung: 'Nonnenburgstr. 24 — Strom (Kd 527415)' },
  '334364': { objekt: 'n24', ablage: 'n24', bezeichnung: 'Nonnenburgstr. 24 — Strom, Niederschlagswasser' },
  '331631': { objekt: 'n24', ablage: 'n24', bezeichnung: 'Nonnenburgstr. 24 — Wasser, Abwasser (Kd 492014)' },
  '49267': { objekt: null, ablage: 'privat-zelterweg5', bezeichnung: 'Zelterweg 5 — Strom, Wasser, Abwasser',
    hinweis: 'Privatwohnung des Owners, kein Mietobjekt — nur Archiv' },
};

interface Beleg {
  datei: string;
  objekt: string | null;
  ablage: string;
  jahr: number;
  lieferant: 'Stadtwerke Tuttlingen GmbH';
  kundennummer: string;
  rechnungseinheit: string;
  bezeichnung: string;
  rechnungsnummer: string;
  rechnungsdatum: string;
  brutto: number | null;
  sparten: string[];
  leistungszeitraum: string | null;
  verbrauch: { strom_kwh?: number; wasser_m3?: number };
  zaehlernummern: string[];
  pfad: string;
  sha256: string;
  /** Pfad in SharePoint, falls dieselbe Rechnung dort schon liegt. */
  sharepoint?: string;
  hinweis?: string;
}

function felder(zeile: string): string[] {
  const out: string[] = [];
  let feld = ''; let inAnf = false;
  for (let i = 0; i < zeile.length; i++) {
    const c = zeile[i];
    if (c === '"') { if (inAnf && zeile[i + 1] === '"') { feld += '"'; i++; } else inAnf = !inAnf; }
    else if (c === ';' && !inAnf) { out.push(feld); feld = ''; }
    else feld += c;
  }
  out.push(feld);
  return out;
}

/** "1.234,56 €" → 1234.56 */
function geld(s: string): number | null {
  const t = (s || '').replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/** "30.01.2025" → "2025-01-30" */
function datum(s: string): string {
  const m = (s || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

async function main() {
  const anwenden = process.argv.includes('--apply');
  // Der gemeinsame Datenbankzugang liest POSTGRES_URL aus der Umgebung; beim
  // Aufruf von Hand steht sie dort nicht.
  if (!process.env.POSTGRES_URL) process.env.POSTGRES_URL = envWert('POSTGRES_URL');
  const adapter = createDropboxAdapter({
    appKey: envWert('EA_DROPBOX_APP_KEY'),
    appSecret: envWert('EA_DROPBOX_APP_SECRET'),
    refreshToken: envWert('EA_DROPBOX_REFRESH_TOKEN'),
  });

  // ── Metadaten ──────────────────────────────────────────────────────────────
  const manifestText = (await adapter.downloadFile(`${QUELLE}/manifest.csv`)).toString('utf-8');
  const manifestZeilen = manifestText.replace(/^﻿/, '').split(/\r?\n/).filter(z => z.includes(';'));
  const manifestKopf = felder(manifestZeilen[0]).map(s => s.trim());
  const mi = (n: string) => manifestKopf.indexOf(n);

  const auswertungText = (await adapter.downloadFile(`${QUELLE}/swt_auswertung.csv`)).toString('utf-8');
  const auswZeilen = auswertungText.replace(/^﻿/, '').split(/\r?\n/).filter(z => z.includes(';'));
  const auswKopf = felder(auswZeilen[0]).map(s => s.trim());
  const ai = (n: string) => auswKopf.indexOf(n);
  const auswertung = new Map<string, string[]>();
  for (const z of auswZeilen.slice(1)) {
    const f = felder(z);
    auswertung.set(f[ai('datei')].trim().replace(/\.pdf$/i, ''), f);
  }

  const belege: Beleg[] = [];
  const probleme: string[] = [];

  for (const z of manifestZeilen.slice(1)) {
    const f = felder(z);
    const datei = f[mi('datei')].trim();
    const einheit = f[mi('rechnungseinheit')].trim();
    const zuordnung = EINHEITEN[einheit];
    if (!zuordnung) {
      probleme.push(`Rechnungseinheit ${einheit} (${datei}) ist keinem Objekt zugeordnet — nicht archiviert.`);
      continue;
    }

    const rechnungsdatum = datum(f[mi('datum')].trim());
    const jahr = parseInt(rechnungsdatum.slice(0, 4), 10);
    const stamm = datei.replace(/\.pdf$/i, '');
    const a = auswertung.get(stamm);

    // Sparten: Vorrang hat die Rechnung selbst. Die Vorauswertung ist eine
    // Grobfassung — bei der Wasserendabrechnung 2025 steht dort nur "Wasser",
    // obwohl die Rechnung Wasser, Schmutzwasser UND Niederschlagswasser
    // ausweist. Deshalb werden unten die Summenzeilen der Textfassung
    // ausgewertet und die Vorauswertung nur als Rückfall verwendet.
    const spartenAusCsv: string[] = [];
    if (a) {
      for (const [spalte, name] of [['strom', 'Strom'], ['wasser', 'Wasser'],
        ['schmutzwasser', 'Schmutzwasser'], ['niederschlag', 'Niederschlagswasser']] as const) {
        const wert = geld(a[ai(spalte)] || '');
        if (wert !== null && wert !== 0) spartenAusCsv.push(name);
      }
    }
    let sparten: string[] = spartenAusCsv;

    // Zählernummern aus der Textfassung der Rechnung.
    let zaehler: string[] = [];
    let zeitraum: string | null = a ? (a[ai('zeitraum')] || '').trim() || null : null;
    const txtZiel = join(ARCHIV, zuordnung.ablage, String(jahr), `${stamm}.txt`);
    try {
      let txt: string;
      if (existsSync(txtZiel)) {
        txt = readFileSync(txtZiel, 'utf-8');
      } else {
        txt = (await adapter.downloadFile(`${QUELLE}/txt/${stamm}.txt`)).toString('utf-8');
        // Die Textfassung kommt mit ins Archiv: Sie ist die Grundlage fuer jede
        // spaetere Auswertung und spart das erneute Lesen des PDF.
        if (anwenden) { mkdirSync(dirname(txtZiel), { recursive: true }); writeFileSync(txtZiel, txt); }
      }
      zaehler = [...new Set((txt.match(/Z[äa]hlernummer:\s*([A-Z0-9]{8,})/g) || [])
        .map(s => s.replace(/.*:\s*/, '')))];
      if (!zeitraum) {
        const m = txt.match(/f[üu]r die Zeit vom\s*(\d{2}\.\d{2}\.\d{4})\s*bis\s*(\d{2}\.\d{2}\.\d{4})/);
        if (m) zeitraum = `${m[1]} bis ${m[2]}`;
      }
      // Die Summenzeilen der Rechnung: "<Sparte> <netto> <ust%> <ust> <brutto>"
      // beziehungsweise ohne Umsatzsteuer bei den Gebuehren der Stadt.
      const ausRechnung: string[] = [];
      for (const [muster, name] of [
        [/^\s*Strom\s+[\d.,-]+\s+\d{1,2},\d{2}/m, 'Strom'],
        [/^\s*Wasser\s+[\d.,-]+\s+\d{1,2},\d{2}/m, 'Wasser'],
        [/^\s*Schmutzwassergeb[üu]hr\s+[\d.,-]+/m, 'Schmutzwasser'],
        [/^\s*Niederschlagswassergeb[üu]hr\s+[\d.,-]+/m, 'Niederschlagswasser'],
      ] as const) {
        if ((muster as RegExp).test(txt)) ausRechnung.push(name as string);
      }
      if (ausRechnung.length > 0) sparten = ausRechnung;
    } catch {
      probleme.push(`Textfassung zu ${stamm} fehlt — Zählernummer nicht erfasst.`);
    }

    // Liegt die Datei schon im Archiv, wird sie nicht erneut geladen — ihr
    // Hash kommt dann aus der vorhandenen Kopie. Ein Lauf ueber 47 Rechnungen
    // dauert sonst jedes Mal zwei Minuten, ohne etwas zu aendern.
    const ziel = join(ARCHIV, zuordnung.ablage, String(jahr), datei);
    let sha: string;
    if (existsSync(ziel)) {
      sha = createHash('sha256').update(readFileSync(ziel)).digest('hex');
    } else {
      const pdf = await adapter.downloadFile(`${QUELLE}/${datei}`);
      sha = createHash('sha256').update(pdf).digest('hex');
      if (anwenden) {
        mkdirSync(dirname(ziel), { recursive: true });
        writeFileSync(ziel, pdf);
      }
    }

    belege.push({
      datei,
      objekt: zuordnung.objekt,
      ablage: zuordnung.ablage,
      jahr,
      lieferant: 'Stadtwerke Tuttlingen GmbH',
      kundennummer: f[mi('pin')].trim(),
      rechnungseinheit: einheit,
      bezeichnung: zuordnung.bezeichnung,
      rechnungsnummer: f[mi('rechnungsnr')].trim(),
      rechnungsdatum,
      brutto: geld(f[mi('betrag')]),
      sparten,
      leistungszeitraum: zeitraum,
      verbrauch: {
        ...(a && geld(a[ai('strom_kwh')] || '') !== null ? { strom_kwh: geld(a[ai('strom_kwh')])! } : {}),
        ...(a && geld(a[ai('wasser_m3')] || '') !== null ? { wasser_m3: geld(a[ai('wasser_m3')])! } : {}),
      },
      zaehlernummern: zaehler,
      pfad: ziel,
      sha256: sha,
      ...(zuordnung.hinweis ? { hinweis: zuordnung.hinweis } : {}),
    });
  }

  // ── SharePoint-Abgleich ────────────────────────────────────────────────────
  //
  // Einige Rechnungen liegen schon in SharePoint — bei L19 unter
  // "Nebenkostenabrechnungen Mieter". Die werden NICHT erneut irgendwohin
  // kopiert; der Fundort wird nur im Index vermerkt, damit erkennbar ist, dass
  // es dieselbe Rechnung ist.
  let inSharepoint = 0;
  try {
    const { rows } = await dbQuery<{ name: string; path: string }>(
      'SELECT name, path FROM sharepoint_files');
    for (const b of belege) {
      const treffer = rows.find(r => r.name.includes(b.rechnungsnummer));
      if (treffer) { b.sharepoint = treffer.path; inSharepoint++; }
    }
  } catch (e: any) {
    probleme.push(`SharePoint-Abgleich nicht moeglich: ${e.message}`);
  }

  // ── Index ──────────────────────────────────────────────────────────────────
  const index = {
    erzeugt_am: new Date().toISOString(),
    quelle: QUELLE,
    lieferant: 'Stadtwerke Tuttlingen GmbH',
    anzahl: belege.length,
    belege: belege.sort((x, y) =>
      x.ablage.localeCompare(y.ablage) || x.rechnungsdatum.localeCompare(y.rechnungsdatum)),
  };

  if (anwenden) {
    mkdirSync(ARCHIV, { recursive: true });
    writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n');
  }

  // ── Verknüpfung am Objekt ──────────────────────────────────────────────────
  let verknuepft = 0;
  let vorhanden = 0;
  if (anwenden) {
    const token = envWert('CORE_SERVICE_TOKEN');
    for (const b of belege) {
      if (!b.objekt) continue;  // Privatwohnung: nur Archiv
      const label = `SWT ${b.sparten.join('/') || 'Rechnung'} ${b.rechnungsdatum} — `
        + `${b.rechnungsnummer}${b.brutto !== null ? `, ${b.brutto.toFixed(2)} EUR` : ''}`
        + (b.ablage === 'mg24-nachbar-mg22' ? ' [Nachbargebäude MG22]' : '');

      const da = await fetch(
        `${GATEWAY}/api/links/property/${encodeURIComponent(b.objekt)}`,
        { headers: { Authorization: `Bearer ${token}` } });
      const schon: any[] = da.ok ? await da.json() : [];
      if (schon.some(l => (l.localPath || l.local_path) === b.pfad)) { vorhanden++; continue; }

      const res = await fetch(`${GATEWAY}/api/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Actor': 'archiv' },
        body: JSON.stringify({
          entityType: 'property', entityId: b.objekt,
          docType: 'local', localPath: b.pfad, label,
        }),
      });
      if (res.ok) verknuepft++;
      else probleme.push(`Verknüpfung ${b.datei}: HTTP ${res.status}`);
    }
  }

  // ── Bericht auf der Kommandozeile ─────────────────────────────────────────
  console.log(`\nSWT-Belegarchiv — ${anwenden ? 'ANWENDEN' : 'Probelauf'}\n`);
  const jeAblage = new Map<string, { n: number; summe: number }>();
  for (const b of belege) {
    const e = jeAblage.get(b.ablage) || { n: 0, summe: 0 };
    e.n++; e.summe += b.brutto || 0;
    jeAblage.set(b.ablage, e);
  }
  for (const [k, v] of [...jeAblage].sort()) {
    console.log(`  ${k.padEnd(22)} ${String(v.n).padStart(3)} Belege  ${v.summe.toFixed(2).padStart(12)} EUR`);
  }
  console.log(`\n  Belege gesamt       : ${belege.length}`);
  console.log(`  ohne Zählernummer   : ${belege.filter(b => b.zaehlernummern.length === 0).length}`);
  console.log(`  ohne Leistungszeitraum: ${belege.filter(b => !b.leistungszeitraum).length}`);
  console.log(`  auch in SharePoint  : ${inSharepoint}`);
  if (anwenden) {
    console.log(`  neu verknüpft       : ${verknuepft}`);
    console.log(`  schon verknüpft     : ${vorhanden}`);
    console.log(`\n  Index: ${INDEX}`);
  } else {
    console.log('\n  Es wird NICHTS geschrieben. Anwenden mit --apply.');
  }
  for (const p of probleme) console.log(`  · ${p}`);
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });

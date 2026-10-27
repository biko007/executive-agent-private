#!/usr/bin/env bun
/**
 * Stuendliche Neuheiten: Mails (juergen.bickel@, Yahoo) und Dokumente
 * (SharePoint, OneDrive, Dropbox) — mit Verarbeitungsvorschlag je relevanter
 * Neuheit, gemeinsam gemeldet.
 *
 * Owner-Anweisungen 27.10.2026, 10:26 (Mails) und 10:45 (Dokumentenablagen).
 * Alles nur lesend: kein Lesevermerk, kein Verschieben, kein Loeschen, keine
 * Ablage. Vorschlaege warten auf „Freigabe Mail|Dok <Kennung> <a–f>".
 *
 * Aufruf durch `neuheiten-stunde.timer` (stuendlich, Minute 7).
 *
 *   bun run scripts/neuheiten-stunde.ts                     Stundenlauf, beide Teile
 *   bun run scripts/neuheiten-stunde.ts --probe             zeigen, nichts schreiben, nichts melden
 *   bun run scripts/neuheiten-stunde.ts --nur mail|dokumente
 *   bun run scripts/neuheiten-stunde.ts --nur dokumente --nachlauf
 *        einmalig alle Dokument-Neuheiten seit 18.10.2026 → ~/bikosoc-spec/report-doc-nachlauf-<datum>.md
 *   bun run scripts/neuheiten-stunde.ts --nur mail --nachlauf
 *        dasselbe fuer Mails → report-mail-nachlauf-<datum>.md
 *
 * Keine relevante Neuheit in der Stunde: kein Report, keine Meldung, nur Journal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropboxZugang, dropboxVollzugang } from '../src/adapters/dropbox-zugang.js';
import { graphGet, graphToken } from '../src/shared/m365/index.js';
import { ladeRegeln, regelnAnlegenFallsFehlend } from '../src/modules/mail-register/relevanz.js';
import { mailLauf, mailZeile, type MailLaufErgebnis } from '../src/modules/neuheiten/mail-lauf.js';
import {
  stundenReport, melde, sperre, tabelle, freigabeZeilen, KATALOG_ZEILE, type NeuheitZeile,
} from '../src/modules/neuheiten/bericht.js';
import {
  graphQuelle, dropboxQuelle, verzeichnisQuelle, spiegelZustand, type DokQuelle, type SpiegelZustand,
} from '../src/modules/doc-register/quellen.js';
import { ladeDokRegeln, dokRegelnErgaenzen } from '../src/modules/doc-register/relevanz.js';
import { dokLauf, dokZeile, ABLAGE, type DokLaufErgebnis } from '../src/modules/doc-register/lauf.js';

const HOME = process.env.HOME || os.homedir();
const PERSONAL = path.join(HOME, '.openclaw', 'workspace', 'artifacts', 'personal');
const MAIL_ZUSTAND = path.join(PERSONAL, 'mail-register');
const DOK_ZUSTAND = path.join(PERSONAL, 'doc-register');
const REGELN = path.join(MAIL_ZUSTAND, 'relevanz.json');
const STUNDEN = path.join(PERSONAL, 'neuheiten', 'stunden');
const SPERRE = path.join(PERSONAL, 'neuheiten', 'stunde.lock');
const SPEC = path.join(HOME, 'bikosoc-spec');
const DROPBOX_REPORTS = '/bikosoc-reports';
const OWNER = 'juergen.bickel@bikolino.com';
/** iCloud-Spiegel vom iMac (Owner 27.10.2026, 10:46), Datenklasse privat. */
const SPIEGEL = path.join(HOME, 'icloud-spiegel');
const SPIEGEL_WARNUNG = path.join(PERSONAL, 'neuheiten', 'spiegel-warnung.json');
const SPIEGEL_ALT_MS = 26 * 3_600_000;
const SPIEGEL_GROSS_BYTES = 20 * 1024 ** 3;

const argv = process.argv.slice(2);
const probe = argv.includes('--probe');
const nachlauf = argv.includes('--nachlauf');
const nur = argv.includes('--nur') ? argv[argv.indexOf('--nur') + 1] : '';
const env = (k: string) => (process.env[k] ?? '').trim();
const log = (m: string) => process.stdout.write(m + '\n');
const warn = (m: string) => process.stderr.write(m + '\n');

if (nachlauf && !['mail', 'dokumente'].includes(nur)) {
  warn('--nachlauf nur zusammen mit --nur mail oder --nur dokumente');
  process.exit(2);
}

/** Graph-Datei als Bytes — graphGet liefert Text und wuerde ein PDF zerstoeren. */
async function graphRoh(url: string): Promise<Buffer> {
  const token = await graphToken(env('M365_TENANT_ID'), env('M365_CLIENT_ID'), env('M365_CLIENT_SECRET'));
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`graph content ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Laufwerk der SharePoint-Dokumente und Merkmale fuer Kopien — aus dem Index. */
async function ausIndex(): Promise<{ spLaufwerk: string | null; kopien: Set<string> }> {
  try {
    const { query, closePool } = await import('../src/shared/db/index.js');
    try {
      const lw = await query(`select drive_id, count(*) n from sharepoint_files
        where missing_since is null and site_name <> 'OneDrive' and drive_name = 'Dokumente'
        group by 1 order by 2 desc limit 1`);
      const gr = await query(`select distinct size::text || '.' || lower(substring(name from '\\.([A-Za-z0-9]+)$')) m
        from sharepoint_files where missing_since is null and size > 0`);
      return { spLaufwerk: lw.rows[0]?.drive_id ?? null, kopien: new Set(gr.rows.map((r: any) => String(r.m))) };
    } finally { await closePool(); }
  } catch (e: any) {
    warn(`neuheiten: SharePoint-Index nicht lesbar (${e?.message ?? e}) — SharePoint übersprungen, keine Kopienerkennung`);
    return { spLaufwerk: null, kopien: new Set() };
  }
}

async function dokQuellen(): Promise<{ quellen: DokQuelle[]; kopien: Set<string>; fehler: string[] }> {
  const quellen: DokQuelle[] = [];
  const fehler: string[] = [];
  const { spLaufwerk, kopien } = await ausIndex();
  if (env('M365_TENANT_ID') && env('M365_CLIENT_ID') && env('M365_CLIENT_SECRET')) {
    const hole = (u: string) => graphGet(env('M365_TENANT_ID'), env('M365_CLIENT_ID'), env('M365_CLIENT_SECRET'), u);
    if (spLaufwerk) quellen.push(graphQuelle('sharepoint', `/drives/${spLaufwerk}`, hole, graphRoh));
    else fehler.push('SharePoint: Laufwerk nicht bestimmbar');
    quellen.push(graphQuelle('onedrive', `/users/${encodeURIComponent(OWNER)}/drive`, hole, graphRoh));
  } else fehler.push('M365-Zugang fehlt — SharePoint und OneDrive übersprungen');
  const voll = dropboxVollzugang((k) => process.env[k]);
  if (voll) quellen.push(dropboxQuelle(voll.adapter));
  else fehler.push('Dropbox-Vollzugriff fehlt — Dropbox übersprungen');
  /* Der Spiegel ist erst da, wenn der Owner den launchd-Job eingerichtet hat. */
  if (spiegelZustand(SPIEGEL).vorhanden) quellen.push(verzeichnisQuelle('icloud', SPIEGEL));
  return { quellen, kopien, fehler };
}

/**
 * Fruehwarnung: Spiegel aelter als 26 h. Gemeldet hoechstens einmal je 24 h,
 * damit nicht jede Stunde dieselbe Zeile kommt. Liefert die Hinweiszeilen
 * und ob sie einen Report erzwingen.
 */
function spiegelHinweise(z: SpiegelZustand, jetzt: Date, probe: boolean): { zeilen: string[]; erzwingen: boolean } {
  if (!z.vorhanden) return { zeilen: [], erzwingen: false };
  const zeilen: string[] = [];
  let erzwingen = false;
  const gb = (z.groesseBytes / 1024 ** 3).toFixed(1).replace('.', ',');
  if (z.letzterIso && jetzt.getTime() - Date.parse(z.letzterIso) > SPIEGEL_ALT_MS) {
    const zuletzt = ladeJsonSicher<{ gemeldet?: string }>(SPIEGEL_WARNUNG).gemeldet;
    if (!zuletzt || jetzt.getTime() - Date.parse(zuletzt) > 24 * 3_600_000) {
      erzwingen = true;
      if (!probe) {
        fs.mkdirSync(path.dirname(SPIEGEL_WARNUNG), { recursive: true });
        fs.writeFileSync(SPIEGEL_WARNUNG, JSON.stringify({ gemeldet: jetzt.toISOString() }));
      }
    }
    zeilen.push(`iCloud-Spiegel steht seit ${z.letzterIso.slice(0, 16).replace('T', ' ')} UTC `
      + `(${z.quelleZeitpunkt === 'marker' ? 'Marker .letzter-lauf' : 'Verzeichniszeit'}) — launchd-Job am iMac prüfen`);
  }
  if (z.groesseBytes > SPIEGEL_GROSS_BYTES) {
    zeilen.push(`iCloud-Spiegel ist ${gb} GB groß (> 20 GB) — Ausschlüsse im rsync-Job vorschlagen (Fotos, Videos, Backups)`);
  }
  return { zeilen, erzwingen };
}

function ladeJsonSicher<T>(p: string): Partial<T> {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
}

function nachlaufReport(
  art: 'mail' | 'dokumente', zeilen: NeuheitZeile[], zaehler: Record<string, number>,
  zeile1: string, quellenText: string, dauer: number, fehler: string[],
): string {
  const je = (c: string) => zeilen.filter((z) => z.vorschlag === c).length;
  const titel = art === 'mail' ? 'Mail-Nachlauf seit 18.10. mit Vorschlägen' : 'Dokument-Nachlauf seit 18.10. mit Vorschlägen';
  const ausgeschieden = Object.entries(zaehler).sort((a, b) => b[1] - a[1]).map(([g, k]) => `${g} ${k}`).join(', ');
  const freigabe = art === 'mail' ? 'Mail' : 'Dok';
  return [
    '---',
    `titel: ${titel}`,
    `status: ${fehler.length ? 'hinweis' : 'aktion'}`,
    `aufgabe: Erstlauf ${art === 'mail' ? 'Mail-Register juergen.bickel@ und Yahoo' : 'Dokumenten-Register SharePoint, OneDrive, Dropbox'} seit 18.10.2026 mit Vorschlägen`,
    `ergebnis: [ ${[zeile1,
      `Vorschläge: a ${je('a')}, b ${je('b')}, c ${je('c')}, d ${je('d')}, e ${je('e')}, f ${je('f')}, offen ${je('offen')}`,
      `Nicht relevant: ${ausgeschieden || '–'}`].map((e) => JSON.stringify(e)).join(', ')} ]`,
    `aktion: "Vorschläge durchsehen und je ${art === 'mail' ? 'Mail' : 'Dokument'} freigeben: Freigabe ${freigabe} <Kennung> <a–f>"`,
    'tests: n/a',
    'rote_zone: nein',
    `dauer_min: ${dauer}`,
    `durchsuchte_quellen: ${JSON.stringify(quellenText)}`,
    '---',
    '',
    `# ${titel}`,
    '',
    '**AUTO · nur gelesen** · Zeiten UTC · Datenklassifizierung: intern/privat',
    '',
    `${zeile1}. Nicht relevant: ${ausgeschieden || '–'}.`,
    '',
    'Nichts wurde ausgeführt. Jede Zeile ist ein Vorschlag aus dem festen Katalog.',
    '',
    ...(zeilen.length ? [...tabelle(zeilen), '', '## Freigabe', '', ...freigabeZeilen(zeilen), ''] : ['keine relevanten Neuheiten', '']),
    KATALOG_ZEILE,
    '',
    ...(fehler.length ? ['## Hinweis', '', ...fehler.map((f) => `- ${f}`), ''] : []),
    'Rote Zone berührt: nein',
    'Rückweg: Vorschläge verfallen ungenutzt; die Register unter `artifacts/personal/` bleiben liegen.',
    '',
    '## Owner-Aktion',
    '',
    `Vorschläge durchsehen und je Zeile freigeben: \`Freigabe ${freigabe} <Kennung> <a–f>\`.`,
    '',
  ].join('\n');
}

async function lauf(): Promise<number> {
  const beginn = Date.now();
  const jetzt = new Date();
  if (!probe && regelnAnlegenFallsFehlend(REGELN)) log(`Regelwerk angelegt: ${REGELN}`);
  if (!probe && dokRegelnErgaenzen(REGELN)) log(`Regelwerk um den Block „dokumente" ergänzt: ${REGELN}`);
  const { regeln, warnungen } = ladeRegeln(REGELN);
  const { regeln: dokRegeln, warnungen: dw } = ladeDokRegeln(REGELN);
  for (const w of [...warnungen, ...dw]) warn(`relevanz: ${w}`);
  const app = dropboxZugang((k) => process.env[k]);
  /* Alles, was im Report unter „Hinweis" steht. Nur echte Ausfaelle (Quelle
     nicht lesbar, Upload oder Meldung gescheitert) setzen den Dienst auf
     „failed" — Nachzuholendes und Zugangsluecken nicht. */
  const fehler: string[] = [];
  const istAusfall = (f: string) => /nicht lesbar \(|fehlgeschlagen|nicht hochgeladen|Abbruch/.test(f);
  const code = () => (fehler.some(istAusfall) ? 1 : 0);

  let mail: MailLaufErgebnis | null = null;
  if (!nur || ['mail', 'm365', 'yahoo'].includes(nur)) {
    mail = await mailLauf({
      zustand: MAIL_ZUSTAND, regeln, env, probe, nachlauf, jetzt, nur: nur || undefined,
      dropbox: app?.adapter ?? null, log, warn,
    });
    fehler.push(...mail.fehler);
    log(mail.zusammen);
  }

  let dok: DokLaufErgebnis | null = null;
  let spiegel = { zeilen: [] as string[], erzwingen: false };
  let spiegelText = 'iCloud-Spiegel noch nicht eingerichtet';
  if (!nur || nur === 'dokumente') {
    /* Ein Fehler im Dokumententeil darf die Mailmeldung nicht verschlucken:
       Die Mails sind zu diesem Zeitpunkt schon als bewertet gespeichert. */
    try {
      const sz = spiegelZustand(SPIEGEL);
      spiegel = spiegelHinweise(sz, jetzt, probe);
      if (sz.vorhanden) {
        spiegelText = `iCloud-Spiegel ${sz.dateien} Dateien, ${(sz.groesseBytes / 1024 ** 3).toFixed(2).replace('.', ',')} GB, letzter Lauf ${sz.letzterIso?.slice(0, 16)} UTC`;
        log(spiegelText);
      }
      const { quellen, kopien, fehler: qf } = await dokQuellen();
      fehler.push(...qf);
      dok = await dokLauf({
        zustand: DOK_ZUSTAND, regeln, dokRegeln, quellen, probe, nachlauf, jetzt,
        kopieMerkmale: kopien, dropbox: app?.adapter ?? null, log, warn,
      });
      fehler.push(...dok.fehler, ...dok.hinweise);
      log(dok.zusammen);
    } catch (e: any) {
      fehler.push(`Dokumententeil Abbruch: ${String(e?.message ?? e).slice(0, 200)}`);
      warn(`neuheiten Dokumente: ${e?.stack ?? e}`);
    }
  }

  const mails = (mail?.vorschlaege ?? []).map(mailZeile);
  const dokumente = (dok?.relevant ?? []).map(dokZeile);

  if (probe) {
    for (const z of [...mails, ...dokumente]) {
      log(`  ${z.kennung} ${z.datum.slice(0, 16)} ${z.quelle.padEnd(16)} ${z.von.slice(0, 40).padEnd(40)} `
        + `${z.titel.slice(0, 50).padEnd(50)} → ${z.text}`);
    }
    if (mail) log('Mails nicht relevant: ' + JSON.stringify(mail.zaehler));
    if (dok) log('Dokumente nicht relevant: ' + JSON.stringify(dok.zaehler));
    for (const h of spiegel.zeilen) log(`Spiegel: ${h}`);
    for (const f of fehler) warn(`Hinweis: ${f}`);
    log('(Probe — nichts geschrieben, nichts gemeldet)');
    return code();
  }

  if (nachlauf) {
    const dauer = Math.max(1, Math.round((Date.now() - beginn) / 60_000));
    const datum = jetzt.toISOString().slice(0, 10).replace(/-/g, '');
    let name: string; let inhalt: string;
    if (nur === 'mail' && mail) {
      const m = mail.laeufe.find((l) => l.quelle === 'm365'); const y = mail.laeufe.find((l) => l.quelle === 'yahoo');
      name = `report-mail-nachlauf-${datum}.md`;
      inhalt = nachlaufReport('mail', mails, mail.zaehler,
        `${mails.length} relevante Mails seit 18.10. (gesehen: juergen.bickel@ ${m?.mailsGesehen ?? 0}, Yahoo ${y?.mailsGesehen ?? 0}; `
          + `Register neu: ${m?.neu.length ?? 0} + ${y?.neu.length ?? 0}, Doppel ${(m?.doppelt ?? 0) + (y?.doppelt ?? 0)})`,
        `juergen.bickel@ (Graph) und jbickel2@yahoo.de (IMAP, nur lesend) ab 18.10.2026, Stand ${jetzt.toISOString().slice(0, 16)} UTC`,
        dauer, fehler);
    } else {
      const jq = dok?.jeQuelle ?? {};
      name = `report-doc-nachlauf-${datum}.md`;
      inhalt = nachlaufReport('dokumente', dokumente, dok?.zaehler ?? {},
        `${dokumente.length} relevante Dokumente seit 18.10. (neu/geändert: ${Object.entries(jq).map(([k, v]) => `${ABLAGE[k]} ${v.neu}`).join(', ')})`,
        `SharePoint (Graph-Delta, Laufwerk Dokumente) · OneDrive juergen.bickel@ (Graph-Delta) · Dropbox Kontowurzel ohne Apps/bikosoc-reports (list_folder rekursiv) · Änderungen ab 18.10.2026, Stand ${jetzt.toISOString().slice(0, 16)} UTC · ${spiegelText}`,
        dauer, fehler);
    }
    fs.writeFileSync(path.join(SPEC, name), inhalt, 'utf-8');
    log(`Nachlauf-Report: ${path.join(SPEC, name)}`);
    return code();
  }

  fehler.push(...spiegel.zeilen);
  if (!mails.length && !dokumente.length && !spiegel.erzwingen) {
    log('neuheiten: keine relevante Neuheit — kein Report');
    for (const f of fehler) warn(`neuheiten: ${f}`);
    return code();
  }

  const stempel = jetzt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const name = `report-neuheiten-stunde-${stempel}.md`;
  const inhalt = stundenReport({ mails, dokumente, jetzt, fehler });
  fs.mkdirSync(STUNDEN, { recursive: true });
  fs.writeFileSync(path.join(STUNDEN, name), inhalt, 'utf-8');
  let hochgeladen = false;
  if (app) {
    await app.adapter.uploadFile({
      path: `${DROPBOX_REPORTS}/${name}`, body: Buffer.from(inhalt, 'utf-8'),
      contentType: 'text/markdown; charset=utf-8',
    }).then(() => { hochgeladen = true; })
      .catch((e: any) => fehler.push(`Report-Upload fehlgeschlagen: ${e?.message ?? e}`));
  } else fehler.push('kein Dropbox-Zugang — Report nur lokal');
  await melde({ mails, dokumente, reportName: name, hochgeladen, hinweise: spiegel.zeilen })
    .catch((e: any) => fehler.push(`Telegram-Hinweis fehlgeschlagen: ${e?.message ?? e}`));
  for (const f of fehler) warn(`neuheiten: ${f}`);
  log(`Report ${name}`);
  return code();
}

async function main(): Promise<number> {
  const frei = sperre(SPERRE);
  if (!frei) { log('neuheiten: ein anderer Lauf ist aktiv — übersprungen'); return 0; }
  try { return await lauf(); } finally { frei(); }
}

main().then((code) => process.exit(code)).catch((e: any) => {
  warn(`neuheiten Fehler: ${e?.message ?? e}`);
  process.exit(1);
});

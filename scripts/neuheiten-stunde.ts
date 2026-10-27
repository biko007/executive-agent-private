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
  stundenReport, melde, sperre, tabelle, freigabeZeilen, zurFreigabe, KATALOG_ZEILE, type NeuheitZeile,
} from '../src/modules/neuheiten/bericht.js';
import {
  graphQuelle, dropboxQuelle, verzeichnisQuelle, spiegelZustand, type DokQuelle, type SpiegelZustand,
} from '../src/modules/doc-register/quellen.js';
import { ladeDokRegeln, dokRegelnErgaenzen } from '../src/modules/doc-register/relevanz.js';
import { dokLauf, dokZeile, ABLAGE, pdfErsteSeite, ladeDokRegister, type DokLaufErgebnis } from '../src/modules/doc-register/lauf.js';
import { dokKennung } from '../src/modules/doc-register/relevanz.js';
import { erstelleMailboxZugang } from '../src/modules/mail-register/index.js';
import { nurLesendGraph } from '../src/modules/mail-register/lesend.js';
import { kurzId } from '../src/modules/mail-register/relevanz.js';
import {
  anthropicClient, ladeKontext, mieterErsetzer, verarbeite, ladeSpeicher, stundenReportSekretariat, telegramZeilen,
  vorgangsZeilen, vorgangsTabelle, einzelTabelle, type Element, type LaufErgebnis,
} from '../src/modules/sekretariat/index.js';

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
  /* Nur „zur Kenntnis" braucht keine Freigabe und loest keine Meldung aus. */
  if (!zurFreigabe(mails).length && !zurFreigabe(dokumente).length && !spiegel.erzwingen) {
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

// ── Sekretariat (Spec Neuheiten-Sekretariat v1, Stufe 1 des Baus) ─────────

const SEK_ZUSTAND = path.join(PERSONAL, 'sekretariat');
const SEK_EINSTELLUNGEN = path.join(SEK_ZUSTAND, 'einstellungen.json');
const sekNachlauf = argv.includes('--sekretariat-nachlauf');

/** Modus und Deckel aus artifacts/personal/sekretariat/einstellungen.json; Rückweg = `"modus": "regeln"` (wirkt beim nächsten Lauf). */
function sekEinstellungen(): { modus: 'ki' | 'regeln'; deckelProStunde: number } {
  try {
    const r = JSON.parse(fs.readFileSync(SEK_EINSTELLUNGEN, 'utf-8'));
    return { modus: r.modus === 'ki' ? 'ki' : 'regeln', deckelProStunde: Number(r.deckelProStunde) > 0 ? Number(r.deckelProStunde) : 60 };
  } catch {
    /* Ohne Einstellungsdatei bleibt es bei den Regeln — eingeschaltet wird das
       Sekretariat bewusst mit `"modus": "ki"` (nach Nachlauf und Review). */
    return { modus: 'regeln', deckelProStunde: 60 };
  }
}

/** data@ (inkl. Proton): registrierte Nachrichten, die das Sekretariat noch nicht kennt. */
async function dataElemente(bekannt: (k: string) => boolean, seit: string): Promise<{ elemente: Element[]; fehler: string[] }> {
  const fehler: string[] = [];
  const zeilen = fs.existsSync(path.join(MAIL_ZUSTAND, 'data.jsonl'))
    ? fs.readFileSync(path.join(MAIL_ZUSTAND, 'data.jsonl'), 'utf-8').split('\n').filter(Boolean).map((z) => JSON.parse(z)) : [];
  const offen = zeilen.filter((e: any) => (e.empfangenIso ?? '') >= seit && !bekannt(kurzId(String(e.messageId).trim())));
  if (!offen.length) return { elemente: [], fehler };
  const z = { tenantId: env('M365_TENANT_ID'), clientId: env('M365_CLIENT_ID'), clientSecret: env('M365_CLIENT_SECRET'), postfach: 'data@bikolino.com' };
  const q = nurLesendGraph(erstelleMailboxZugang(z), z);
  const elemente: Element[] = [];
  for (const e of offen) {
    let text = '';
    try { text = (await q.text(e.graphId)).slice(0, 3000); } catch { fehler.push(`data@: Text nicht lesbar (${String(e.betreff).slice(0, 40)})`); continue; }
    elemente.push({ typ: 'mail', kennung: kurzId(String(e.messageId).trim()), quelle: 'data', datum: e.empfangenIso, titel: e.betreff,
      von: e.absender, vonName: e.absenderName, text, anhaenge: e.anhaenge, messageId: String(e.messageId).trim(), threadIds: [],
      ordner: e.ordner, kopf: {} });
  }
  return { elemente, fehler };
}

/**
 * Abgleich Register ↔ Sekretariat (Spec „Sicherstellen" 1): Dokumente, die das
 * Register in den letzten 7 Tagen aufgenommen hat, die das Sekretariat aber
 * nicht kennt (etwa nach einem Abbruch zwischen Register und Bewertung),
 * kommen mit Namen und Pfad erneut zur Bewertung. Mails brauchen das nicht —
 * sie werden gesammelt, solange das Sekretariat sie nicht kennt.
 */
function dokNachzuegler(bekannt: (k: string) => boolean, jetzt: Date): Element[] {
  if (!fs.existsSync(DOK_ZUSTAND)) return [];
  const grenze = new Date(jetzt.getTime() - 7 * 86_400_000).toISOString();
  const raus: Element[] = [];
  for (const datei of fs.readdirSync(DOK_ZUSTAND).filter((f) => f.endsWith('.jsonl'))) {
    for (const z of fs.readFileSync(path.join(DOK_ZUSTAND, datei), 'utf-8').split('\n').filter(Boolean)) {
      let d: any;
      try { d = JSON.parse(z); } catch { continue; }
      if (!d?.kennung || (d.erkanntIso ?? '') < grenze || bekannt(d.kennung) || raus.some((x) => x.kennung === d.kennung)) continue;
      raus.push({ typ: 'dokument', kennung: d.kennung, quelle: d.quelle, datum: d.geaendertIso ?? d.erkanntIso, titel: d.name ?? '',
        von: String(d.pfad ?? '').slice(0, Math.max(0, String(d.pfad ?? '').lastIndexOf('/'))) || '/', pfad: d.pfad, text: '' });
    }
  }
  return raus;
}

function dokElemente(dok: DokLaufErgebnis): Element[] {
  return dok.neu.map((d) => ({
    typ: 'dokument' as const, kennung: d.kennung, quelle: d.quelle, datum: d.geaendertIso, titel: d.name,
    von: d.pfad.slice(0, Math.max(0, d.pfad.lastIndexOf('/'))) || '/', pfad: d.pfad,
    text: (dok.texte[d.kennung] ?? '').slice(0, 6000), kopie: d.grund === 'Kopie aus anderer Ablage',
  }));
}

async function sekretariatLauf(nachlaufModus: boolean): Promise<number> {
  const beginn = Date.now();
  const jetzt = new Date();
  const einst = sekEinstellungen();
  const { regeln } = ladeRegeln(REGELN);
  const { regeln: dokRegeln } = ladeDokRegeln(REGELN);
  const app = dropboxZugang((k) => process.env[k]);
  const hinweise: string[] = [];
  const speicher = ladeSpeicher(SEK_ZUSTAND);
  const bekannt = (k: string) => !!speicher.elemente[k] && speicher.elemente[k].status !== 'erfasst';

  /* Kontext zuerst: Fällt die Datenbank aus, bricht der Lauf ab, BEVOR die
     Register Neuheiten als gesehen verbuchen (Review 27.10.2026). */
  const { query, closePool } = await import('../src/shared/db/index.js');
  let kontext: Awaited<ReturnType<typeof ladeKontext>>;
  try { kontext = await ladeKontext((s, p) => query(s, p as any[]), regeln, []); }
  catch (e) { await closePool(); throw e; }
  const ohneMieter = mieterErsetzer(kontext.kontakte);

  // 1 Erfassen: Mails (juergen.bickel@, Yahoo), data@, Dokumente
  const mail = await mailLauf({ zustand: MAIL_ZUSTAND, regeln, env, probe: nachlaufModus, nachlauf: nachlaufModus, jetzt,
    dropbox: app?.adapter ?? null, log, warn, sekretariat: { bekannt } });
  hinweise.push(...mail.fehler);
  const data = await dataElemente(bekannt, nachlaufModus ? '2026-10-18T00:00:00.000Z' : new Date(jetzt.getTime() - 3 * 86_400_000).toISOString());
  hinweise.push(...data.fehler);
  let dok: DokLaufErgebnis | null = null;
  try {
    const { quellen, kopien, fehler: qf } = await dokQuellen();
    hinweise.push(...qf);
    dok = await dokLauf({ zustand: DOK_ZUSTAND, regeln, dokRegeln, quellen, probe: nachlaufModus, nachlauf: nachlaufModus,
      alleSeitStart: nachlaufModus, jetzt, kopieMerkmale: kopien, dropbox: app?.adapter ?? null, log, warn,
      ersteSeite: (b) => pdfErsteSeite(b, 2) });
    hinweise.push(...dok.fehler, ...dok.hinweise);
  } catch (e: any) { hinweise.push(`Dokumententeil Abbruch: ${String(e?.message ?? e).slice(0, 200)}`); }
  const dokNeu = dok ? dokElemente(dok).filter((e) => !bekannt(e.kennung)) : [];
  const nachzuegler = nachlaufModus || !Object.keys(speicher.elemente).length ? []
    : dokNachzuegler((k) => bekannt(k) || !!speicher.elemente[k] || dokNeu.some((x) => x.kennung === k), jetzt);
  if (nachzuegler.length) hinweise.push(`Abgleich: ${nachzuegler.length} Dokument(e) im Register, aber nicht im Sekretariat — erneut zur Bewertung (nur Name)`);
  const elemente = [...(mail.elemente ?? []), ...data.elemente, ...dokNeu, ...nachzuegler];
  log(`sekretariat: ${elemente.length} Neuheiten erfasst (Mail ${mail.elemente?.length ?? 0}, data@ ${data.elemente.length}, Dokumente ${elemente.length - (mail.elemente?.length ?? 0) - data.elemente.length})`);

  // 2+3 Verstehen und Verknüpfen
  let ergebnis: LaufErgebnis;
  try {
    const { vorgaenge: _v, ...ohneVorgaenge } = kontext;
    ergebnis = await verarbeite(elemente, {
      zustand: SEK_ZUSTAND, regeln, dokRegeln, ki: anthropicClient(env('ANTHROPIC_API_KEY')), kontext: ohneVorgaenge,
      deckelProStunde: nachlaufModus ? null : einst.deckelProStunde, jetzt, log,
      bankVersicherer: /@([a-z0-9.-]*\.)?(ksk-tut\.de|vbsdn\.de|volksbank[a-z-]*\.de|vr-?bank[a-z-]*\.de|dzprivatbank\.com|comdirect\.de|revolut\.com|ubs\.com|gothaer\.(de|info)|allianz\.de|alte-leipziger\.de|standardlife\.de|ruv\.de|helvetia\.(de|ch)|pantaenius\.(de|com)|vohrer\.de|swisslife\.de|nuernberger\.de|debeka\.de|ergo\.de|axa\.de|hdi\.de)$/i,
    });
  } finally { await closePool(); }
  const stand = ladeSpeicher(SEK_ZUSTAND);
  log(`sekretariat: ${JSON.stringify(ergebnis.zaehler)}; ${ergebnis.tokensEin}/${ergebnis.tokensAus} Tokens ≈ ${ergebnis.kostenUsd} $`);

  // Alarm bei Lücke in der Statuskette (und bei Nachzüglern aus dem Abgleich)
  if (nachzuegler.length) ergebnis.alarm.push(`Abgleich: ${nachzuegler.length} Dokument(e) fehlten im Sekretariat — nachbewertet`);
  if (ergebnis.alarm.length) {
    await fetch('http://127.0.0.1:18789/api/internal/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ message: 'Sekretariat: Statuskette', severity: 'warn', role: 'dev', lage: 'fehler',
        titel: 'Sekretariat: Statuskette prüfen', zeilen: ergebnis.alarm }),
    }).catch(() => hinweise.push('Alarm an Telegram nicht zugestellt'));
  }

  if (nachlaufModus) {
    fs.writeFileSync(path.join(SPEC, `report-neuheiten-nachlauf-ki-${jetzt.toISOString().slice(0, 10).replace(/-/g, '')}.md`),
      ohneMieter(nachlaufKiReport(ergebnis, stand, hinweise, Math.max(1, Math.round((Date.now() - beginn) / 60_000)))), 'utf-8');
    log('Nachlauf-Report geschrieben');
    return 0;
  }

  const { zeilen } = vorgangsZeilen(ergebnis.vorgaenge, stand.elemente);
  if (!zeilen.length && !ergebnis.einzeln.length && !ergebnis.alarm.length) {
    log('neuheiten: kein Vorgang zur Freigabe — kein Report');
    for (const h of hinweise) warn(`neuheiten: ${h}`);
    return 0;
  }
  const stempel = jetzt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const name = `report-neuheiten-stunde-${stempel}.md`;
  const inhalt = ohneMieter(stundenReportSekretariat({ ergebnis, elemente: stand.elemente, jetzt, hinweise }));
  fs.mkdirSync(STUNDEN, { recursive: true });
  fs.writeFileSync(path.join(STUNDEN, name), inhalt, 'utf-8');
  let hochgeladen = false;
  if (app) {
    await app.adapter.uploadFile({ path: `${DROPBOX_REPORTS}/${name}`, body: Buffer.from(inhalt, 'utf-8'), contentType: 'text/markdown; charset=utf-8' })
      .then(() => { hochgeladen = true; }).catch((e: any) => hinweise.push(`Report-Upload fehlgeschlagen: ${e?.message ?? e}`));
  }
  const t0 = telegramZeilen({ ergebnis, elemente: stand.elemente });
  const t = { titel: ohneMieter(t0.titel), zeilen: t0.zeilen.map(ohneMieter) };
  if (zeilen.length || ergebnis.einzeln.length) {
    await fetch('http://127.0.0.1:18789/api/internal/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ message: t.titel, severity: 'info', lage: 'hinweis', titel: t.titel, zeilen: t.zeilen,
        fuss: [hochgeladen ? `Report ${name} (Dropbox)` : `Report ${name} nur lokal`, 'Freigabe: Freigabe Vorgang <Kennung>'] }),
    }).then((r) => { if (!r.ok) hinweise.push(`Telegram ${r.status}`); }).catch((e: any) => hinweise.push(`Telegram-Hinweis fehlgeschlagen: ${e?.message ?? e}`));
  }
  for (const h of hinweise) warn(`neuheiten: ${h}`);
  log(`Report ${name}`);
  return hinweise.some((h) => /fehlgeschlagen|Abbruch|nicht lesbar \(/.test(h)) ? 1 : 0;
}

/** Nachlauf-Report: Vorgangsliste, Vergleich Regeln vs. KI, Kosten. */
function nachlaufKiReport(e: LaufErgebnis, s: ReturnType<typeof ladeSpeicher>, hinweise: string[], dauer: number): string {
  const z = e.zaehler;
  const { zeilen, kenntnis } = vorgangsZeilen(s.vorgaenge, s.elemente);
  // Regeln (Nachlauf heute Vormittag): Mail-Vorschläge vor 10:00 und relevante Dokumente des Registers
  const regelMails = new Set(fs.readFileSync(path.join(MAIL_ZUSTAND, 'vorschlaege.jsonl'), 'utf-8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((v) => v.erstelltIso < '2026-10-27T10:00').map((v) => v.id));
  const regelDoks = new Set(['sharepoint', 'onedrive', 'dropbox'].flatMap((q) => ladeDokRegister(path.join(DOK_ZUSTAND, `${q}.jsonl`)))
    .filter((x) => x.relevant).map((x) => x.kennung));
  const kiRelevant = (st: any) => st.status === 'vorschlag' || st.status === 'netz';
  const alle = Object.values(s.elemente);
  const regelSet = new Set([...regelMails, ...regelDoks]);
  const weg = alle.filter((st) => regelSet.has(st.kennung) && !kiRelevant(st));
  const neu = alle.filter((st) => !regelSet.has(st.kennung) && kiRelevant(st));
  const bleiben = alle.filter((st) => regelSet.has(st.kennung) && kiRelevant(st));
  const mails = alle.filter((x) => x.typ === 'mail'); const doks = alle.filter((x) => x.typ === 'dokument');
  const zeile = (st: any) => `| \`${st.kennung}\` | ${st.datum.slice(0, 10)} | ${zelle(st.typ === 'mail' ? st.von : st.von)} | ${zelle(st.titel).slice(0, 70)} | ${zelle(st.begruendung).slice(0, 200)} |`;
  return [
    '---',
    'titel: Neuheiten-Nachlauf mit KI – Vorgänge seit 18.10.',
    `status: ${e.alarm.length ? 'hinweis' : 'aktion'}`,
    'aufgabe: Nachlauf seit 18.10.2026 komplett mit der KI neu bewerten (Sekretariat Stufe 1), Vorgangsliste, Vergleich Regeln vs. KI, Kosten',
    `ergebnis: [ ${[`${alle.length} Neuheiten bewertet (Mails ${mails.length}, Dokumente ${doks.length}): ${zeilen.length} Vorgänge zur Freigabe, + ${kenntnis} zur Kenntnis, ${alle.filter((x) => x.status === 'netz').length} Netz-Treffer`,
      `Regeln vs. KI: ${bleiben.length} bleiben, ${weg.length} fallen weg, ${neu.length} kommen dazu`,
      `KI-Kosten Nachlauf: ${e.tokensEin} + ${e.tokensAus} Tokens ≈ ${e.kostenUsd.toFixed(2)} $ (claude-sonnet-4-6)`].map((x) => JSON.stringify(x)).join(', ')} ]`,
    'aktion: "Vorgänge durchsehen; Korrekturen (anderer Vorschlag, nicht relevant, anderes Objekt) im Chat nennen — sie werden für Stufe 2 gesammelt"',
    'tests: n/a',
    'rote_zone: nein',
    `dauer_min: ${dauer}`,
    '---',
    '',
    '# Neuheiten-Nachlauf mit KI seit 18.10.2026',
    '',
    '**AUTO · Sekretariat Stufe 1** · Zeiten UTC · Datenklassifizierung: intern/privat',
    '',
    `Statuskette: erfasst ${z.erfasst} · vorgefiltert ${z.vorgefiltert} · KI bewertet ${z.bewertet} (nicht relevant ${z.abgelegtKi}, Vorschlag ${z.vorschlag}, Netz ${z.netzEinzeln}) · wartet ${z.wartet} · Fehler ${z.fehler}.`,
    '',
    '## Vorgänge zur Freigabe',
    '',
    ...vorgangsTabelle(zeilen),
    '',
    ...zeilen.map(({ v }) => `- \`Freigabe Vorgang ${v.kennung}\``),
    '',
    `+ ${kenntnis} Vorgänge nur zur Kenntnis (im Speicher, ohne Freigabe).`,
    '',
    '## Netz-Treffer ohne Vorgang (KI: nicht relevant)',
    '',
    ...einzelTabelle(alle.filter((x) => x.status === 'netz') as any),
    '',
    '## Vergleich Regeln (Nachlauf 09:54/10:27) vs. KI',
    '',
    `| | Regeln relevant | KI relevant | bleiben | fallen weg | kommen dazu |`,
    `|---|---:|---:|---:|---:|---:|`,
    `| Mails | ${[...regelMails].length} | ${mails.filter(kiRelevant).length} | ${bleiben.filter((x) => x.typ === 'mail').length} | ${weg.filter((x) => x.typ === 'mail').length} | ${neu.filter((x) => x.typ === 'mail').length} |`,
    `| Dokumente | ${[...regelDoks].length} | ${doks.filter(kiRelevant).length} | ${bleiben.filter((x) => x.typ === 'dokument').length} | ${weg.filter((x) => x.typ === 'dokument').length} | ${neu.filter((x) => x.typ === 'dokument').length} |`,
    '',
    '### Fallen weg (Regeln relevant, KI nicht)',
    '', '| Kennung | Datum | Von/Ort | Titel | Begründung |', '|---|---|---|---|---|', ...weg.map(zeile), '',
    '### Kommen dazu (KI relevant, Regeln nicht)',
    '', '| Kennung | Datum | Von/Ort | Titel | Begründung |', '|---|---|---|---|---|', ...neu.map(zeile), '',
    '## Kosten',
    '',
    `${e.tokensEin} Eingabe- und ${e.tokensAus} Ausgabe-Tokens, geschätzt ${e.kostenUsd.toFixed(2)} $ (Listenpreis 3 $/15 $ je Mio. Tokens). Protokoll: \`artifacts/personal/sekretariat/kosten.jsonl\`.`,
    '',
    ...(e.alarm.length || hinweise.length ? ['## Hinweis', '', ...[...e.alarm, ...hinweise].map((h) => `- ${h}`), ''] : []),
    'Rote Zone berührt: nein. Postfächer und Ablagen nur gelesen; nichts ausgeführt.',
    '',
    '## Owner-Aktion',
    '',
    'Vorgänge durchsehen; Korrekturen im Chat nennen.',
    '',
  ].join('\n');
}

async function main(): Promise<number> {
  const frei = sperre(SPERRE);
  if (!frei) { log('neuheiten: ein anderer Lauf ist aktiv — übersprungen'); return 0; }
  try {
    if (sekNachlauf) return await sekretariatLauf(true);
    if (!nur && !nachlauf && !probe && sekEinstellungen().modus === 'ki' && env('ANTHROPIC_API_KEY')) {
      return await sekretariatLauf(false);
    }
    return await lauf();
  } finally { frei(); }
}

main().then((code) => process.exit(code)).catch((e: any) => {
  warn(`neuheiten Fehler: ${e?.message ?? e}`);
  process.exit(1);
});

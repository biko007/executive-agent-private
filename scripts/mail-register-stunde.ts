#!/usr/bin/env bun
/**
 * Stuendliches Mail-Register fuer juergen.bickel@bikolino.com und
 * jbickel2@yahoo.de — mit Verarbeitungsvorschlag je relevanter Mail.
 *
 * Owner-Anweisung 27.10.2026, 10:26. Beide Postfaecher NUR lesend: Graph ohne
 * Schreibbefehl, IMAP mit EXAMINE, kein Lesevermerk, kein Verschieben, keine
 * Ablage. Vorschlaege werden nie ausgefuehrt; sie warten auf die Freigabe
 * „Freigabe Mail <id> <a–f>".
 *
 * Aufruf durch `mail-register-stunde.timer` (stuendlich, Minute 7).
 *
 *   bun run scripts/mail-register-stunde.ts             Stundenlauf
 *   bun run scripts/mail-register-stunde.ts --probe     zeigen, nichts schreiben, nichts melden
 *   bun run scripts/mail-register-stunde.ts --nachlauf  einmalig alles seit 18.10.2026,
 *                                                       Report nach ~/bikosoc-spec/
 *   bun run scripts/mail-register-stunde.ts --nur m365|yahoo
 *
 * Gibt es in der Stunde keine relevante neue Mail, entsteht kein Report und
 * keine Meldung — nur eine Zeile im Journal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropboxZugang } from '../src/adapters/dropbox-zugang.js';
import { erstelleMailboxZugang, registerCsv, ladeRegister } from '../src/modules/mail-register/index.js';
import {
  nurLesendGraph, erstelleImapQuelle, registriereLesend, bekannteIdsAus,
  type LeseQuelle, type LeseLauf, type GeseheneMail,
} from '../src/modules/mail-register/lesend.js';
import {
  ladeRegeln, regelnAnlegenFallsFehlend, kopfAusschluss, bewerte, vorschlagText,
  kurzId, maskiere, type VorschlagCode,
} from '../src/modules/mail-register/relevanz.js';

const HOME = process.env.HOME || os.homedir();
const ZUSTAND = path.join(HOME, '.openclaw', 'workspace', 'artifacts', 'personal', 'mail-register');
const P = {
  data: path.join(ZUSTAND, 'data.jsonl'),
  m365: path.join(ZUSTAND, 'm365.jsonl'),
  yahoo: path.join(ZUSTAND, 'yahoo.jsonl'),
  regeln: path.join(ZUSTAND, 'relevanz.json'),
  vorschlaege: path.join(ZUSTAND, 'vorschlaege.jsonl'),
  bewertet: path.join(ZUSTAND, 'bewertet.json'),
  stand: path.join(ZUSTAND, 'stunde-stand.json'),
  stunden: path.join(ZUSTAND, 'stunden'),
};
const SPEC = path.join(HOME, 'bikosoc-spec');
/** Neben data-register.csv, eine Ebene hoeher als `data/`. */
const DROPBOX_POSTFACH = '/bikosoc-reports/transfer/postfach';
const DROPBOX_REPORTS = '/bikosoc-reports';
/** Beginn des Registers fuer beide Postfaecher (Auftrag 27.10.2026). */
const START = '2026-10-18T00:00:00.000Z';
/** Rueckblick je Stundenlauf: spaet eintreffende oder verschobene Mails. */
const UEBERLAPPUNG_MS = 48 * 3_600_000;

const argv = process.argv.slice(2);
const probe = argv.includes('--probe');
const nachlauf = argv.includes('--nachlauf');
const nur = argv.includes('--nur') ? argv[argv.indexOf('--nur') + 1] : '';
const probeDatei = (q: string) => path.join(os.tmpdir(), `mail-register-probe-${process.pid}-${q}.jsonl`);
const env = (k: string) => (process.env[k] ?? '').trim();
const log = (m: string) => process.stdout.write(m + '\n');
const warn = (m: string) => process.stderr.write(m + '\n');

interface Vorschlag {
  id: string;
  messageId: string;
  quelle: string;
  postfach: string;
  ordner: string;
  datum: string;
  absender: string;
  absenderName: string;
  betreff: string;
  objekt?: string;
  thema?: string;
  vorschlag: VorschlagCode;
  text: string;
  grund: string;
  erstelltIso: string;
}

const POSTFACH: Record<string, string> = {
  m365: 'juergen.bickel@bikolino.com', yahoo: 'jbickel2@yahoo.de',
};

function ladeJson<T>(p: string, leer: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return leer; }
}
function schreibeJson(p: string, wert: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(wert, null, 1), 'utf-8');
  fs.renameSync(tmp, p);
}

function quellen(): Array<{ name: 'm365' | 'yahoo'; zugang: () => LeseQuelle }> {
  const raus: Array<{ name: 'm365' | 'yahoo'; zugang: () => LeseQuelle }> = [];
  if (!nur || nur === 'm365') {
    if (env('M365_TENANT_ID') && env('M365_CLIENT_ID') && env('M365_CLIENT_SECRET')) {
      const z = {
        tenantId: env('M365_TENANT_ID'), clientId: env('M365_CLIENT_ID'),
        clientSecret: env('M365_CLIENT_SECRET'), postfach: POSTFACH.m365,
      };
      raus.push({ name: 'm365', zugang: () => nurLesendGraph(erstelleMailboxZugang(z), z) });
    } else warn('mail-register-stunde: M365-Zugang fehlt — juergen.bickel@ übersprungen.');
  }
  if (!nur || nur === 'yahoo') {
    if (env('YAHOO_USER') && env('YAHOO_APP_PASSWORD')) {
      raus.push({
        name: 'yahoo',
        zugang: () => erstelleImapQuelle({
          host: env('YAHOO_IMAP_HOST') || 'imap.mail.yahoo.com',
          port: Number(env('YAHOO_IMAP_PORT') || 993),
          user: env('YAHOO_USER'), pass: env('YAHOO_APP_PASSWORD'),
        }),
      });
    } else warn('mail-register-stunde: Yahoo-Zugang fehlt — Yahoo übersprungen.');
  }
  return raus;
}

const zelle = (s: string) => maskiere(String(s ?? '')).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const absenderKurz = (v: Vorschlag) => zelle(v.absenderName || v.absender).slice(0, 40);
const datumKurz = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}. ${iso.slice(11, 16)}`;

function tabelle(vs: Vorschlag[]): string[] {
  const z = ['| Kennung | Datum (UTC) | Postfach | Absender | Betreff | Vorschlag |',
    '|---|---|---|---|---|---|'];
  for (const v of [...vs].sort((a, b) => a.datum.localeCompare(b.datum))) {
    z.push(`| \`${v.id}\` | ${datumKurz(v.datum)} | ${v.quelle === 'm365' ? 'juergen.bickel@' : 'Yahoo'} `
      + `| ${absenderKurz(v)} (${zelle(v.absender)}) | ${zelle(v.betreff).slice(0, 90)} | ${v.text} |`);
  }
  return z;
}

function freigabeZeilen(vs: Vorschlag[]): string[] {
  return [...vs].sort((a, b) => a.datum.localeCompare(b.datum)).map((v) =>
    `- \`Freigabe Mail ${v.id} ${v.vorschlag === 'offen' ? '<a–f>' : v.vorschlag}\``);
}

const KATALOG_ZEILE = 'Katalog: a Beleg ablegen + Buchung · b Zählerstände/Fakten einarbeiten · '
  + 'c Antwortentwurf · d Frist/Termin · e Reklamation/Widerspruch · f nur zur Kenntnis. '
  + 'Ein anderer Buchstabe in der Freigabe ersetzt den Vorschlag.';

function stundenReport(vs: Vorschlag[], jetzt: Date, fehler: string[]): string {
  const n = (q: string) => vs.filter((v) => v.quelle === q).length;
  return [
    `# Mail-Stunde ${jetzt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `**${vs.length} relevante neue Mail(s)** — juergen.bickel@: ${n('m365')}, Yahoo: ${n('yahoo')}. `
      + 'Nichts wurde ausgeführt; jeder Vorschlag wartet auf Ihre Freigabe.',
    '',
    ...tabelle(vs),
    '',
    '## Freigabe',
    '',
    ...freigabeZeilen(vs),
    '',
    KATALOG_ZEILE,
    '',
    ...(fehler.length ? ['## Hinweis', '', ...fehler.map((f) => `- ${f}`), ''] : []),
    'Postfächer nur gelesen (kein Lesevermerk, nichts verschoben). '
      + 'Regelwerk: `artifacts/personal/mail-register/relevanz.json`.',
    '',
  ].join('\n');
}

function nachlaufReport(vs: Vorschlag[], laeufe: LeseLauf[], zaehler: Record<string, number>,
  dauerMin: number, fehler: string[]): string {
  const je = (code: string) => vs.filter((v) => v.vorschlag === code).length;
  const m = laeufe.find((l) => l.quelle === 'm365');
  const y = laeufe.find((l) => l.quelle === 'yahoo');
  const ergebnis = [
    `${vs.length} relevante Mails seit 18.10.: juergen.bickel@ ${vs.filter((v) => v.quelle === 'm365').length}, Yahoo ${vs.filter((v) => v.quelle === 'yahoo').length}`,
    `Vorschläge: a ${je('a')}, b ${je('b')}, c ${je('c')}, d ${je('d')}, e ${je('e')}, f ${je('f')}, offen ${je('offen')}`,
    `Register neu: juergen.bickel@ ${m?.neu.length ?? 0}, Yahoo ${y?.neu.length ?? 0} (Doppel übersprungen: ${(m?.doppelt ?? 0) + (y?.doppelt ?? 0)})`,
  ];
  const ausgeschieden = Object.entries(zaehler).sort((a, b) => b[1] - a[1])
    .map(([g, k]) => `${g} ${k}`).join(', ');
  return [
    '---',
    'titel: Mail-Nachlauf seit 18.10. mit Vorschlägen',
    `status: ${fehler.length ? 'hinweis' : 'aktion'}`,
    'aufgabe: Erstlauf Mail-Register juergen.bickel@ und Yahoo seit 18.10.2026 mit Verarbeitungsvorschlägen',
    `ergebnis: [ ${ergebnis.map((e) => JSON.stringify(e)).join(', ')} ]`,
    'aktion: "Vorschläge durchsehen und je Mail freigeben: Freigabe Mail <Kennung> <a–f>"',
    'tests: n/a',
    'rote_zone: nein',
    `dauer_min: ${dauerMin}`,
    `durchsuchte_quellen: "juergen.bickel@ (Graph, alle Ordner ausser Gelöscht/Junk/Entwürfe/Postausgang/Gesendet, ab 18.10.2026) · jbickel2@yahoo.de (IMAP nur lesend: INBOX, Technik-Backups, Lesestoff, Angebote, Soziale Updates, ab 18.10.2026) · Register data@ für Doppel, Stand ${new Date().toISOString().slice(0, 16)} UTC"`,
    '---',
    '',
    '# Mail-Nachlauf seit 18.10.2026',
    '',
    '**AUTO · Postfächer nur gelesen** · Zeiten UTC · Datenklassifizierung: intern/privat',
    '',
    `Gesehen: juergen.bickel@ ${m?.mailsGesehen ?? 0}, Yahoo ${y?.mailsGesehen ?? 0}. `
      + `Relevant nach Regelwerk: **${vs.length}**. Nicht relevant: ${ausgeschieden || '–'}.`,
    '',
    'Nichts wurde ausgeführt. Jede Zeile ist ein Vorschlag aus dem festen Katalog.',
    '',
    ...tabelle(vs),
    '',
    '## Freigabe',
    '',
    ...freigabeZeilen(vs),
    '',
    KATALOG_ZEILE,
    '',
    ...(fehler.length ? ['## Hinweis', '', ...fehler.map((f) => `- ${f}`), ''] : []),
    'Rote Zone berührt: nein',
    'Rückweg: Vorschläge verfallen ungenutzt; `vorschlaege.jsonl` und `bewertet.json` löschen setzt die Bewertung zurück.',
    '',
    '## Owner-Aktion',
    '',
    'Vorschläge durchsehen und je Mail freigeben: `Freigabe Mail <Kennung> <a–f>`.',
    '',
  ].join('\n');
}

async function melde(vs: Vorschlag[], reportName: string, hochgeladen: boolean): Promise<void> {
  const zeilen = [...vs].sort((a, b) => a.datum.localeCompare(b.datum)).slice(0, 12)
    .map((v) => `${absenderKurz(v)}: ${zelle(v.betreff).slice(0, 50)} → ${v.text}`);
  if (vs.length > 12) zeilen.push(`… und ${vs.length - 12} weitere`);
  const r = await fetch('http://127.0.0.1:18789/api/internal/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Mail: ${vs.length} relevante neue Mail(s)`,
      severity: 'info', lage: 'hinweis', titel: `Mail: ${vs.length} relevante neue`,
      zeilen,
      fuss: [hochgeladen ? `Report ${reportName} (Dropbox)` : `Report ${reportName} nur lokal (Dropbox-Upload fehlgeschlagen)`,
        'Freigabe: Freigabe Mail <Kennung> <a–f>'],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`notify ${r.status}`);
}

/**
 * Sperrdatei gegen gleichzeitige Laeufe (Timer und Handaufruf). Eine Sperre,
 * deren Prozess nicht mehr lebt, wird uebernommen.
 */
function sperre(): (() => void) | null {
  const pfad = path.join(ZUSTAND, 'stunde.lock');
  fs.mkdirSync(ZUSTAND, { recursive: true });
  for (let versuch = 0; versuch < 2; versuch++) {
    try {
      fs.writeFileSync(pfad, String(process.pid), { flag: 'wx' });
      return () => { try { fs.unlinkSync(pfad); } catch { /* schon weg */ } };
    } catch {
      const pid = Number(fs.readFileSync(pfad, 'utf-8').trim());
      let lebt = false;
      try { if (pid) { process.kill(pid, 0); lebt = true; } } catch { /* tot */ }
      if (lebt) return null;
      try { fs.unlinkSync(pfad); } catch { /* egal */ }
    }
  }
  return null;
}

async function main(): Promise<number> {
  const frei = sperre();
  if (!frei) { log('mail-register-stunde: ein anderer Lauf ist aktiv — übersprungen'); return 0; }
  try { return await lauf(); } finally { frei(); }
}

async function lauf(): Promise<number> {
  const beginn = Date.now();
  const jetzt = new Date();
  if (!probe && regelnAnlegenFallsFehlend(P.regeln)) log(`Regelwerk angelegt: ${P.regeln}`);
  const { regeln, warnungen } = ladeRegeln(P.regeln);
  for (const w of warnungen) warn(`relevanz: ${w}`);

  const stand = ladeJson<{ letzterLauf: Record<string, string> }>(P.stand, { letzterLauf: {} });
  const bewertet = ladeJson<{ version: 1; ids: Record<string, string> }>(P.bewertet, { version: 1, ids: {} });
  const bekannte = bekannteIdsAus([P.data, P.m365, P.yahoo]);
  const fehler: string[] = [];
  const laeufe: LeseLauf[] = [];
  const offen: Array<{ g: GeseheneMail; zugang: LeseQuelle }> = [];
  const zugaenge: LeseQuelle[] = [];
  const gesendet = new Set<string>();
  /* Ohne die gesendeten IDs ist „Antwort auf eigene Mail" nicht pruefbar;
     dann wird ein „nicht relevant" nicht festgeschrieben, sondern spaeter wiederholt. */
  let gesendetVollstaendig = true;
  const sentSeit = new Date(jetzt.getTime() - 90 * 86_400_000).toISOString();

  for (const q of quellen()) {
    const zugang = q.zugang();
    zugaenge.push(zugang);
    const letzter = stand.letzterLauf[q.name];
    const seit = nachlauf || !letzter ? START
      : new Date(Math.max(Date.parse(START), Date.parse(letzter) - UEBERLAPPUNG_MS)).toISOString();
    try {
      const lauf = await registriereLesend({
        quelle: q.name, postfach: zugang, bekannteIds: bekannte, seitIso: seit, now: jetzt,
        /* Probe: Register in eine Wegwerfdatei, damit nichts dauerhaft entsteht. */
        registerPfad: probe ? probeDatei(q.name) : P[q.name],
        logger: { info: log, warn },
      });
      laeufe.push(lauf);
      for (const g of lauf.gesehen) offen.push({ g, zugang });
      try {
        for (const id of await zugang.gesendeteIds(sentSeit)) gesendet.add(id.toLowerCase());
      } catch (e: any) {
        gesendetVollstaendig = false;
        fehler.push(`${POSTFACH[q.name]}: gesendete Mails nicht lesbar (${String(e?.message ?? e).slice(0, 120)})`);
      }
      if (!probe) stand.letzterLauf[q.name] = jetzt.toISOString();
    } catch (e: any) {
      fehler.push(`${POSTFACH[q.name]}: nicht lesbar (${String(e?.message ?? e).slice(0, 160)})`);
      warn(`mail-register-stunde ${q.name} Fehler: ${e?.message ?? e}`);
    }
  }

  /* Relevanz: jede Nachricht genau einmal, auch wenn sie in beiden Postfaechern liegt. */
  const vorschlaege: Vorschlag[] = [];
  const zaehler: Record<string, number> = {};
  let textFehler = 0;
  for (const { g, zugang } of offen) {
    const mid = g.mail.messageId.trim();
    if (bewertet.ids[mid]) continue;
    const eingang = {
      absender: g.mail.absender, absenderName: g.mail.absenderName, betreff: g.mail.betreff,
      ordner: g.ordner, kopf: g.mail.kopf,
    };
    const aus = kopfAusschluss(eingang, regeln);
    let ergebnis;
    if (aus) ergebnis = { relevant: false, grund: aus } as const;
    else {
      /* Scheitert der Text, wird die Mail nicht bewertet und im naechsten
         Lauf erneut versucht — sonst bliebe ein „kein Merkmal" fuer immer stehen. */
      let text: string;
      try { text = await zugang.text(g.mail.id); } catch (e: any) {
        textFehler++;
        continue;
      }
      ergebnis = bewerte({ ...eingang, text }, regeln, gesendet);
      if (!ergebnis.relevant && !gesendetVollstaendig) continue;
    }
    bewertet.ids[mid] = ergebnis.relevant ? 'relevant' : ergebnis.grund;
    if (!ergebnis.relevant) { zaehler[ergebnis.grund] = (zaehler[ergebnis.grund] ?? 0) + 1; continue; }
    const b = ergebnis as ReturnType<typeof bewerte>;
    vorschlaege.push({
      id: kurzId(mid), messageId: mid, quelle: g.quelle, postfach: POSTFACH[g.quelle],
      ordner: g.ordner, datum: g.mail.empfangenIso, absender: g.mail.absender.toLowerCase(),
      absenderName: maskiere(g.mail.absenderName), betreff: maskiere(g.mail.betreff),
      objekt: b.objekt, thema: b.thema, vorschlag: b.vorschlag, text: vorschlagText(b),
      grund: b.grund, erstelltIso: jetzt.toISOString(),
    });
  }
  for (const z of zugaenge) await z.schliessen();
  if (textFehler) fehler.push(`${textFehler} Mailtext(e) nicht lesbar — werden im nächsten Lauf erneut bewertet`);

  const zusammen = `mail-register-stunde: ${laeufe.map((l) => `${l.quelle} ${l.mailsGesehen} gesehen/${l.neu.length} neu`).join(', ')}; `
    + `${vorschlaege.length} relevant${fehler.length ? `; ${fehler.length} Fehler` : ''}`;

  if (probe) {
    for (const q of ['m365', 'yahoo']) { try { fs.unlinkSync(probeDatei(q)); } catch { /* keine */ } }
    log(zusammen + ' (Probe — nichts geschrieben, nichts gemeldet)');
    for (const v of vorschlaege) {
      log(`  ${v.id} ${datumKurz(v.datum)} ${v.quelle.padEnd(5)} ${v.absender.slice(0, 32).padEnd(32)} `
        + `${v.betreff.slice(0, 50).padEnd(50)} → ${v.text}  [${v.grund}]`);
    }
    log('Nicht relevant: ' + JSON.stringify(zaehler));
    return fehler.length ? 1 : 0;
  }

  schreibeJson(P.bewertet, bewertet);
  schreibeJson(P.stand, stand);
  if (vorschlaege.length) {
    fs.appendFileSync(P.vorschlaege, vorschlaege.map((v) => JSON.stringify(v)).join('\n') + '\n', 'utf-8');
  }

  const dropbox = dropboxZugang((k) => process.env[k]);
  /* CSV nur, wenn das Register gewachsen ist. */
  for (const l of laeufe.filter((x) => x.neu.length)) {
    const name = `${l.quelle}-register.csv`;
    /* Betreff gekuerzt um IBAN/Kontonummern, bevor er Dropbox erreicht. */
    const inhalt = registerCsv(ladeRegister(P[l.quelle as 'm365' | 'yahoo']).eintraege
      .map((e) => ({ ...e, betreff: maskiere(e.betreff), absenderName: maskiere(e.absenderName) })));
    fs.writeFileSync(path.join(ZUSTAND, name), inhalt, 'utf-8');
    if (dropbox) {
      await dropbox.adapter.uploadFile({
        path: `${DROPBOX_POSTFACH}/${name}`, body: Buffer.from(inhalt, 'utf-8'),
        contentType: 'text/csv; charset=utf-8',
      }).then(() => log(`${DROPBOX_POSTFACH}/${name} (${Buffer.byteLength(inhalt)} B)`))
        .catch((e: any) => { fehler.push(`CSV ${name} nicht hochgeladen: ${e?.message ?? e}`); });
    }
  }

  if (nachlauf) {
    const name = `report-mail-nachlauf-${jetzt.toISOString().slice(0, 10).replace(/-/g, '')}.md`;
    const dauer = Math.max(1, Math.round((Date.now() - beginn) / 60_000));
    fs.writeFileSync(path.join(SPEC, name), nachlaufReport(vorschlaege, laeufe, zaehler, dauer, fehler), 'utf-8');
    log(`${zusammen}\nNachlauf-Report: ${path.join(SPEC, name)}`);
    return fehler.length ? 1 : 0;
  }

  if (!vorschlaege.length) {
    log(zusammen + ' — kein Report');
    return fehler.length ? 1 : 0;
  }

  const stempel = jetzt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const name = `report-mail-stunde-${stempel}.md`;
  const inhalt = stundenReport(vorschlaege, jetzt, fehler);
  fs.mkdirSync(P.stunden, { recursive: true });
  fs.writeFileSync(path.join(P.stunden, name), inhalt, 'utf-8');
  let hochgeladen = false;
  if (dropbox) {
    await dropbox.adapter.uploadFile({
      path: `${DROPBOX_REPORTS}/${name}`, body: Buffer.from(inhalt, 'utf-8'),
      contentType: 'text/markdown; charset=utf-8',
    }).then(() => { hochgeladen = true; })
      .catch((e: any) => fehler.push(`Report-Upload fehlgeschlagen: ${e?.message ?? e}`));
  } else fehler.push('kein Dropbox-Zugang — Report nur lokal');
  await melde(vorschlaege, name, hochgeladen)
    .catch((e: any) => fehler.push(`Telegram-Hinweis fehlgeschlagen: ${e?.message ?? e}`));
  for (const f of fehler) warn(`mail-register-stunde: ${f}`);
  log(`${zusammen}\nReport ${name}`);
  return fehler.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e: any) => {
  warn(`mail-register-stunde Fehler: ${e?.message ?? e}`);
  process.exit(1);
});

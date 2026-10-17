/**
 * scripts/yahoo-inventar — Vollinventar und Register des Yahoo-Postfachs.
 * NUR LESEN: kein Verschieben, kein Loeschen, kein Lesevermerk.
 *
 * Drei Durchgaenge, absichtlich getrennt:
 *   1. Umschlaege aller Ordner (schnell, ~2 ms je Nachricht)
 *   2. Anhangsnamen nur fuer Registertreffer (~37 ms je Nachricht)
 *   3. Mailtext nur fuer die Rechnungsmails der Stadtwerke
 * Der zweite Durchgang kostet das Zwanzigfache des ersten; ihn auf die
 * Treffer zu begrenzen, spart rund eine halbe Stunde Laufzeit.
 *
 * Yahoo gibt je Ordner nur die juengsten 10.000 Nachrichten heraus
 * (Serverkennung MESSAGELIMIT). Was darueber liegt, ist ueber IMAP nicht
 * erreichbar — das Skript weist die Luecke je Ordner aus statt sie zu
 * verschweigen.
 *
 * Aufruf:
 *   bun run scripts/yahoo-inventar.ts <Zielverzeichnis>
 */
import { ImapFlow } from 'imapflow';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  kategorisiere, ausschluss, anhangsnamen, swtRechnungenAusText, zaehlernummer,
  nummerGekuerzt, type KopfDaten, type Register, type SwtRechnung,
} from '../src/modules/mail/index.js';

const REGISTER: Register[] = [
  'rechnungen', 'vertraege', 'abos', 'behoerden', 'mahnungen',
  'versicherungen', 'assets', 'stadtwerke', 'banken',
];
const BLOCK = 5000;

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
  return treffer[1].trim();
}

function csv(wert: unknown): string {
  const s = String(wert ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return /[",;]/.test(s) ? `"${s}"` : s;
}

/** Quoted-Printable und HTML zu lesbarem Text — nur fuer die SWT-Mails. */
function klartext(roh: string): string {
  return roh
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

async function main() {
  const ziel = process.argv[2];
  if (!ziel) { console.error('Aufruf: bun run scripts/yahoo-inventar.ts <Zielverzeichnis>'); process.exit(2); }
  mkdirSync(ziel, { recursive: true });

  const client = new ImapFlow({
    host: env('YAHOO_IMAP_HOST'), port: Number(env('YAHOO_IMAP_PORT') || 993), secure: true,
    auth: { user: env('YAHOO_USER'), pass: env('YAHOO_APP_PASSWORD') },
    logger: false, socketTimeout: 300000,
  });
  client.on('error', (e: any) => console.error(`[imap] ${e?.message ?? e}`));
  await client.connect();

  /* ---------- 1. Umschlaege ---------- */
  const alle: KopfDaten[] = [];
  const probe: Array<[string, number, number]> = [];
  for (const ordner of await client.list()) {
    const stand = await client.status(ordner.path, { messages: true }).catch(() => null);
    const gemeldet = stand?.messages ?? 0;
    if (gemeldet === 0) { probe.push([ordner.path, 0, 0]); continue; }
    const sperre = await client.getMailboxLock(ordner.path);
    let gelesen = 0;
    try {
      const erreichbar = (client.mailbox as { exists: number }).exists;
      for (let von = 1; von <= erreichbar; von += BLOCK) {
        const bis = Math.min(von + BLOCK - 1, erreichbar);
        for await (const m of client.fetch(`${von}:${bis}`, { uid: true, envelope: true })) {
          alle.push({
            ordner: ordner.path, uid: m.uid,
            datum: m.envelope?.date ? new Date(m.envelope.date).toISOString() : '',
            adresse: (m.envelope?.from?.[0]?.address ?? '').toLowerCase(),
            name: m.envelope?.from?.[0]?.name ?? '',
            betreff: m.envelope?.subject ?? '',
          });
          gelesen++;
        }
      }
    } finally { sperre.release(); }
    probe.push([ordner.path, gemeldet, gelesen]);
    console.error(`${String(gelesen).padStart(6)} / ${String(gemeldet).padStart(6)}  ${ordner.path}`);
  }
  console.error(`\nUmschlaege: ${alle.length}`);

  /* ---------- 2. Anhangsnamen fuer Registertreffer ---------- */
  const treffer = alle.filter((k) => kategorisiere(k).length > 0);
  console.error(`Registertreffer: ${treffer.length} — Anhangsnamen werden geholt`);
  const jeOrdner = new Map<string, KopfDaten[]>();
  for (const k of treffer) {
    const liste = jeOrdner.get(k.ordner) ?? [];
    liste.push(k); jeOrdner.set(k.ordner, liste);
  }
  const nachUid = new Map<string, KopfDaten>();
  for (const k of alle) nachUid.set(`${k.ordner}#${k.uid}`, k);
  for (const [pfad, liste] of jeOrdner) {
    const sperre = await client.getMailboxLock(pfad);
    try {
      for (let i = 0; i < liste.length; i += 500) {
        const uids = liste.slice(i, i + 500).map((k) => k.uid).join(',');
        for await (const m of client.fetch({ uid: uids }, { uid: true, bodyStructure: true }, { uid: true })) {
          const k = nachUid.get(`${pfad}#${m.uid}`);
          if (k) k.anhaenge = anhangsnamen(m.bodyStructure);
        }
      }
    } finally { sperre.release(); }
    console.error(`  Anhaenge geprueft: ${pfad} (${liste.length})`);
  }

  /* ---------- 3. Rechnungszeilen der Stadtwerke ---------- */
  const swtMails = alle.filter((k) =>
    /@(swtenergie\.de|stadtwerke-tuttlingen\.de)$/i.test(k.adresse)
    || /stadtwerke|swt/i.test(k.betreff));
  const rechnungen: Array<SwtRechnung & { quelleDatum: string; ordner: string; uid: number }> = [];
  const zaehler: Array<{ datum: string; zaehler: string; ordner: string }> = [];
  const swtJeOrdner = new Map<string, KopfDaten[]>();
  for (const k of swtMails) {
    const z = zaehlernummer(k.betreff);
    if (z) zaehler.push({ datum: k.datum.slice(0, 10), zaehler: z, ordner: k.ordner });
    const liste = swtJeOrdner.get(k.ordner) ?? [];
    liste.push(k); swtJeOrdner.set(k.ordner, liste);
  }
  for (const [pfad, liste] of swtJeOrdner) {
    const sperre = await client.getMailboxLock(pfad);
    try {
      const uids = liste.map((k) => k.uid).join(',');
      for await (const m of client.fetch({ uid: uids }, { uid: true, source: true }, { uid: true })) {
        const text = klartext(m.source?.toString('utf-8') ?? '');
        const kopf = nachUid.get(`${pfad}#${m.uid}`);
        for (const r of swtRechnungenAusText(text)) {
          rechnungen.push({ ...r, quelleDatum: (kopf?.datum ?? '').slice(0, 10), ordner: pfad, uid: m.uid });
        }
      }
    } finally { sperre.release(); }
  }
  await client.logout();
  console.error(`Stadtwerke: ${swtMails.length} Mails, ${rechnungen.length} Rechnungszeilen, ${zaehler.length} Zaehlermeldungen`);

  /* ---------- Ausgabe ---------- */
  const kopfzeile = 'datum;absender;absender_adresse;betreff;anhaenge;ordner';
  const zeile = (k: KopfDaten) => [
    k.datum.slice(0, 10), csv(k.name), csv(k.adresse), csv(k.betreff),
    csv((k.anhaenge ?? []).join(' | ')), csv(k.ordner),
  ].join(';');
  const sortiert = [...alle].sort((a, b) => b.datum.localeCompare(a.datum));

  writeFileSync(`${ziel}/yahoo-inventar-vollstaendig.csv`,
    [kopfzeile, ...sortiert.map(zeile)].join('\n') + '\n');
  writeFileSync(`${ziel}/yahoo-zaehlprobe.csv`,
    'ordner;ordnerzaehler;gelesen;luecke\n'
    + probe.map(([p, g, l]) => `${csv(p)};${g};${l};${g - l}`).join('\n') + '\n');

  const uebersicht: string[] = ['register;treffer;jahresverteilung'];
  for (const reg of REGISTER) {
    const t = sortiert.filter((k) => kategorisiere(k).includes(reg));
    writeFileSync(`${ziel}/yahoo-register-${reg}.csv`, [kopfzeile, ...t.map(zeile)].join('\n') + '\n');
    const jahre = new Map<string, number>();
    for (const k of t) {
      const j = k.datum.slice(0, 4) || 'ohne Datum';
      jahre.set(j, (jahre.get(j) ?? 0) + 1);
    }
    const verteilung = [...jahre.entries()].sort().map(([j, n]) => `${j}:${n}`).join(' ');
    uebersicht.push(`${reg};${t.length};${verteilung}`);
    console.error(`${reg.padEnd(16)} ${String(t.length).padStart(6)}  ${verteilung}`);
  }
  writeFileSync(`${ziel}/yahoo-register-uebersicht.csv`, uebersicht.join('\n') + '\n');

  /* Banken gekuerzt — Vertragsnummern gehoeren nicht im Klartext in eine Liste. */
  const banken = sortiert.filter((k) => kategorisiere(k).includes('banken'));
  writeFileSync(`${ziel}/yahoo-register-banken-gekuerzt.csv`,
    'datum;absender_adresse;betreff_gekuerzt;ordner\n'
    + banken.map((k) => [k.datum.slice(0, 10), csv(k.adresse), csv(nummerGekuerzt(k.betreff)), csv(k.ordner)].join(';')).join('\n') + '\n');

  const swtSortiert = rechnungen.sort((a, b) => a.rechnungsnummer.localeCompare(b.rechnungsnummer));
  writeFileSync(`${ziel}/yahoo-swt-index.csv`,
    'kunde;rechnungseinheit;rechnungsnummer;rechnungsdatum;betrag;maildatum;ordner\n'
    + swtSortiert.map((r) => [r.kunde, r.rechnungseinheit, r.rechnungsnummer, r.datum,
        r.betrag === null ? '' : r.betrag.toFixed(2), r.quelleDatum, csv(r.ordner)].join(';')).join('\n') + '\n');
  writeFileSync(`${ziel}/yahoo-swt-zaehlermeldungen.csv`,
    'datum;zaehlernummer;ordner\n'
    + zaehler.sort((a, b) => a.datum.localeCompare(b.datum))
        .map((z) => `${z.datum};${z.zaehler};${csv(z.ordner)}`).join('\n') + '\n');

  const absender = new Map<string, number>();
  for (const k of sortiert) if (k.adresse) absender.set(k.adresse, (absender.get(k.adresse) ?? 0) + 1);
  writeFileSync(`${ziel}/yahoo-absender.csv`, 'absender;mails\n'
    + [...absender.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a};${n}`).join('\n') + '\n');

  const aus = { gesundheit: 0, newsletter: 0, ohne: 0 };
  for (const k of sortiert) {
    const a = ausschluss(k);
    if (a === 'gesundheit') aus.gesundheit++;
    else if (a === 'newsletter') aus.newsletter++;
    else if (kategorisiere(k).length === 0) aus.ohne++;
  }
  writeFileSync(`${ziel}/yahoo-ausgeschlossen.json`, JSON.stringify(aus, null, 1) + '\n');
  console.error(`\nnicht ausgewertet: ${aus.gesundheit} Gesundheit, ${aus.newsletter} Rundschreiben, `
    + `${aus.ohne} ohne Vertrags- oder Kostenbezug`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

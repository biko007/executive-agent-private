/**
 * scripts/mail-dossier — alle Nachrichten zu einer Person sammeln. NUR LESEN.
 *
 * Fasst mehrere Graph-Suchen zusammen, wirft Doppel weg, sortiert chronologisch
 * und gibt je Nachricht Datum, Richtung, Beteiligte, Betreff, Anhangsnamen und
 * einen Textauszug aus. Gedacht als Grundlage fuer eine Fallakte — etwa bei
 * einer Endabrechnung, wo der gesamte Schriftverkehr zaehlt.
 *
 * Richtung: EIN, wenn der Suchpartner Absender ist; AUS, wenn er Empfaenger
 * ist; INTERN sonst (die Nachricht nennt ihn nur).
 *
 * Aufruf:
 *   bun run scripts/mail-dossier.ts --begriff Schweigert \
 *       --adresse joshua.schweigert@icloud.com [--ab 2024-01-01] [--zeichen 900]
 *
 * Schreibt nichts: kein Lesevermerk, keine Aenderung am Postfach.
 */
import { readFileSync } from 'node:fs';
import { graphToken } from '../src/shared/m365/index.js';
import { textAusHtml } from './lies-mail.ts';

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
  return treffer[1].trim();
}

async function graphHolen(token: string, pfad: string): Promise<any> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${pfad}`, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${pfad} → HTTP ${res.status}: ${text.slice(0, 250)}`);
  return JSON.parse(text);
}

function arg(name: string, vorgabe?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : vorgabe;
}

function adressen(n: any, feld: string): string[] {
  return (n[feld] ?? []).map((r: any) => (r.emailAddress?.address ?? '').toLowerCase());
}

async function main() {
  const begriffe = [arg('--begriff'), arg('--adresse')].filter(Boolean) as string[];
  if (begriffe.length === 0) {
    console.error('Aufruf: bun run scripts/mail-dossier.ts --begriff <Name> [--adresse <Mail>] '
      + '[--ab JJJJ-MM-TT] [--zeichen N]');
    process.exit(2);
  }
  const ab = arg('--ab', '2000-01-01')!;
  const zeichen = Number(arg('--zeichen', '900'));
  const adresse = (arg('--adresse') ?? '').toLowerCase();

  const token = await graphToken(
    env('M365_TENANT_ID'), env('M365_CLIENT_ID'), env('M365_CLIENT_SECRET'));
  const nutzer = encodeURIComponent(env('M365_USER'));

  const gesehen = new Map<string, any>();
  for (const begriff of begriffe) {
    const antwort = await graphHolen(token,
      `/users/${nutzer}/messages?$search="${encodeURIComponent(begriff)}"`
      + '&$select=id,receivedDateTime,sentDateTime,subject,from,toRecipients,ccRecipients,'
      + 'hasAttachments,body,webLink&$top=200');
    for (const n of antwort.value ?? []) if (!gesehen.has(n.id)) gesehen.set(n.id, n);
    console.log(`# Suche "${begriff}": ${(antwort.value ?? []).length} Treffer`);
  }

  const liste = [...gesehen.values()]
    .filter(n => (n.receivedDateTime ?? '').slice(0, 10) >= ab)
    .sort((a, b) => (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''));

  console.log(`# ${liste.length} Nachrichten ab ${ab}, chronologisch\n`);

  for (const n of liste) {
    const von = (n.from?.emailAddress?.address ?? '').toLowerCase();
    const an = adressen(n, 'toRecipients');
    const cc = adressen(n, 'ccRecipients');
    let richtung = 'INTERN';
    if (adresse && von.includes(adresse)) richtung = 'EIN';
    else if (adresse && [...an, ...cc].some(a => a.includes(adresse))) richtung = 'AUS';

    const roh = n.body?.content ?? '';
    const text = n.body?.contentType === 'html' ? textAusHtml(roh) : String(roh).trim();
    /* Zitierte Vorgaenger abschneiden: Sie wiederholen nur, was weiter oben in
       der Liste ohnehin steht, und blaehen die Akte auf. */
    const kern = text.split(/\nVon: |\n-----Urspr|\n_{10,}|\nAm .{5,40} schrieb/)[0].trim();

    console.log('='.repeat(76));
    console.log(`${n.receivedDateTime.slice(0, 16).replace('T', ' ')}  [${richtung}]  ${n.subject ?? ''}`);
    console.log(`  von: ${von}`);
    console.log(`  an:  ${an.join(', ')}${cc.length ? ' | cc: ' + cc.join(', ') : ''}`);
    if (n.hasAttachments) {
      try {
        const a = await graphHolen(token, `/users/${nutzer}/messages/${n.id}/attachments?$select=name,size`);
        for (const x of a.value ?? []) console.log(`  ANHANG: ${x.name} (${Math.round((x.size ?? 0) / 1024)} kB)`);
      } catch { console.log('  ANHANG: nicht lesbar'); }
    }
    console.log('-'.repeat(76));
    console.log(kern.slice(0, zeichen) || '(kein Text)');
    if (kern.length > zeichen) console.log(`… (${kern.length - zeichen} Zeichen gekuerzt)`);
    console.log();
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });

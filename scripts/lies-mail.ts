/**
 * scripts/lies-mail — Nachrichtentexte aus dem Postfach lesen. NUR LESEN.
 *
 * Ergaenzt scripts/suche-mail-energiekonzept.ts: Die Suche nennt Datum, Absender
 * und Betreff, dieses Skript liefert den Text dazu. Es schreibt nichts, weder
 * ins Postfach noch in die Datenbank, und markiert nichts als gelesen
 * ($select liest nur Felder, es wird kein Lesevermerk gesetzt).
 *
 * Aufruf:
 *   bun run scripts/lies-mail.ts "<Suchbegriff>" [--ab JJJJ-MM-TT] [--bis JJJJ-MM-TT]
 *                                                [--betreff <Teil>] [--anzahl N]
 *
 * Der Text wird aus HTML in schlichten Text ueberfuehrt und auf --zeichen
 * gekuerzt (Vorgabe 4000), damit eine lange Signaturkette den Blick nicht
 * verstellt.
 */
import { readFileSync } from 'node:fs';
import { graphToken } from '../src/shared/m365/index.js';

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
  if (!res.ok) throw new Error(`GET ${pfad} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** HTML zu lesbarem Text. Bewusst schlicht: Es geht um Inhalt, nicht um Layout. */
export function textAusHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<td[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&euro;/g, '€')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const begriff = process.argv[2];
  if (!begriff || begriff.startsWith('--')) {
    console.error('Aufruf: bun run scripts/lies-mail.ts "<Begriff>" [--ab TT] [--bis TT] '
      + '[--betreff <Teil>] [--anzahl N] [--zeichen N]');
    process.exit(2);
  }
  const ab = arg('--ab');
  const bis = arg('--bis');
  const betreff = arg('--betreff')?.toLowerCase();
  const anzahl = Number(arg('--anzahl') ?? 5);
  const zeichen = Number(arg('--zeichen') ?? 4000);

  const token = await graphToken(
    env('M365_TENANT_ID'), env('M365_CLIENT_ID'), env('M365_CLIENT_SECRET'));
  const nutzer = encodeURIComponent(env('M365_USER'));

  const antwort = await graphHolen(token,
    `/users/${nutzer}/messages?$search="${encodeURIComponent(begriff)}"`
    + '&$select=id,receivedDateTime,subject,from,toRecipients,hasAttachments,body'
    + '&$top=100');

  let treffer: any[] = antwort.value ?? [];
  if (ab) treffer = treffer.filter(n => n.receivedDateTime.slice(0, 10) >= ab);
  if (bis) treffer = treffer.filter(n => n.receivedDateTime.slice(0, 10) <= bis);
  if (betreff) treffer = treffer.filter(n => (n.subject ?? '').toLowerCase().includes(betreff));
  treffer.sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));

  console.log(`${treffer.length} Nachricht(en) nach Filterung, zeige bis zu ${anzahl}.\n`);
  for (const n of treffer.slice(0, anzahl)) {
    const roh = n.body?.content ?? '';
    const text = n.body?.contentType === 'html' ? textAusHtml(roh) : roh.trim();
    console.log('='.repeat(78));
    console.log(`DATUM:   ${n.receivedDateTime.slice(0, 16).replace('T', ' ')}`);
    console.log(`VON:     ${n.from?.emailAddress?.address ?? '?'}`);
    console.log(`AN:      ${(n.toRecipients ?? []).map((r: any) => r.emailAddress?.address).join(', ')}`);
    console.log(`BETREFF: ${n.subject ?? ''}`);
    console.log('-'.repeat(78));
    console.log(text.slice(0, zeichen));
    if (text.length > zeichen) console.log(`\n… (${text.length - zeichen} Zeichen gekuerzt)`);
    console.log();
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });

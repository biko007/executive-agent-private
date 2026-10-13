/**
 * scripts/suche-mail-energiekonzept — Postfachsuche zum Mieterstrommodell. NUR LESEN.
 *
 * Durchsucht das Postfach über Microsoft Graph nach den Begriffen rund um
 * energiekonzept ortenau, Mieterstrom und die Kundennummern und gibt Datum,
 * Absender, Betreff und Anhangsnamen aus. Schreibt nichts — weder ins Postfach
 * noch in die Datenbank.
 *
 * Graph `$search` durchsucht Betreff, Textkörper UND Anhangsnamen; deshalb
 * findet eine Suche nach einer Kundennummer auch die Rechnung, die sie nur im
 * PDF-Namen trägt.
 *
 * Aufruf:  bun run scripts/suche-mail-energiekonzept.ts [Begriff ...]
 */
import { readFileSync } from 'node:fs';
import { graphToken } from '../src/shared/m365/index.js';

const BEGRIFFE_STANDARD = [
  'energiekonzept', 'ortenau', 'Mieterstrom', 'Kundenanlage', 'Messkonzept',
  'NEWstrom', 'Reststrom', 'Metiundo', 'ER04915', '11142',
];

interface Nachricht {
  id: string;
  receivedDateTime: string;
  subject: string | null;
  from?: { emailAddress?: { name?: string; address?: string } };
  hasAttachments: boolean;
  webLink: string;
}

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
  return treffer[1].trim();
}

async function graphHolen(token: string, pfad: string): Promise<any> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${pfad}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      /* Ohne diesen Header liefert Graph bei $search einen Fehler für Postfächer,
         die nicht über ein Delegated-Token gelesen werden. */
      ConsistencyLevel: 'eventual',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${pfad} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function main() {
  const begriffe = process.argv.slice(2).length > 0
    ? process.argv.slice(2) : BEGRIFFE_STANDARD;

  const token = await graphToken(
    env('M365_TENANT_ID'), env('M365_CLIENT_ID'), env('M365_CLIENT_SECRET'));
  const nutzer = encodeURIComponent(env('M365_USER'));

  /* Jede Nachricht nur einmal ausgeben, auch wenn sie auf mehrere Begriffe passt. */
  const gesehen = new Map<string, { n: Nachricht; begriffe: string[] }>();

  for (const begriff of begriffe) {
    const pfad = `/users/${nutzer}/messages`
      + `?$search="${encodeURIComponent(begriff)}"`
      + '&$select=id,receivedDateTime,subject,from,hasAttachments,webLink'
      + '&$top=100';
    let antwort: any;
    try {
      antwort = await graphHolen(token, pfad);
    } catch (e: any) {
      console.log(`\n### ${begriff}: FEHLER — ${e.message}`);
      continue;
    }
    const treffer: Nachricht[] = antwort.value ?? [];
    console.log(`\n### ${begriff}: ${treffer.length} Treffer`
      + (treffer.length === 100 ? ' (Obergrenze erreicht — evtl. mehr)' : ''));
    for (const n of treffer) {
      const vorhanden = gesehen.get(n.id);
      if (vorhanden) { vorhanden.begriffe.push(begriff); continue; }
      gesehen.set(n.id, { n, begriffe: [begriff] });
    }
  }

  const sortiert = [...gesehen.values()].sort(
    (a, b) => a.n.receivedDateTime.localeCompare(b.n.receivedDateTime));

  console.log(`\n\n===== ${sortiert.length} Nachrichten insgesamt =====\n`);
  for (const { n, begriffe: b } of sortiert) {
    const tag = n.receivedDateTime.slice(0, 10);
    const von = n.from?.emailAddress?.address ?? '(kein Absender)';
    console.log(`${tag}  ${von.padEnd(38).slice(0, 38)}  ${(n.subject ?? '(kein Betreff)').slice(0, 95)}`);
    console.log(`            [${b.join(', ')}]`);
    if (!n.hasAttachments) continue;
    try {
      const anh = await graphHolen(
        token, `/users/${nutzer}/messages/${n.id}/attachments?$select=name,size`);
      for (const a of anh.value ?? []) {
        console.log(`            ANHANG: ${a.name}  (${Math.round((a.size ?? 0) / 1024)} kB)`);
      }
    } catch (e: any) {
      console.log(`            ANHANG: nicht lesbar — ${e.message.slice(0, 80)}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

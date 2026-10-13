/**
 * scripts/hole-mail-anhang — Anhänge aus dem Postfach herunterladen. NUR LESEN.
 *
 * Sucht Nachrichten über Graph `$search` und speichert alle Anhänge, deren Name
 * auf eines der Namensmuster passt. Schreibt nichts ins Postfach.
 *
 * Aufruf:  bun run scripts/hole-mail-anhang.ts <Zielverzeichnis> <Suchbegriff> <Namensmuster> [...]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

async function main() {
  const [ziel, begriff, ...muster] = process.argv.slice(2);
  if (!ziel || !begriff || muster.length === 0) {
    console.error('Aufruf: hole-mail-anhang.ts <Zielverzeichnis> <Suchbegriff> <Namensmuster> [...]');
    process.exit(2);
  }
  mkdirSync(ziel, { recursive: true });
  const regeln = muster.map(m => new RegExp(m, 'i'));

  const token = await graphToken(
    env('M365_TENANT_ID'), env('M365_CLIENT_ID'), env('M365_CLIENT_SECRET'));
  const nutzer = encodeURIComponent(env('M365_USER'));

  const antwort = await graphHolen(token,
    `/users/${nutzer}/messages?$search="${encodeURIComponent(begriff)}"`
    + '&$select=id,receivedDateTime,subject,hasAttachments&$top=100');

  const gespeichert = new Set<string>();
  for (const n of antwort.value ?? []) {
    if (!n.hasAttachments) continue;
    const anh = await graphHolen(token, `/users/${nutzer}/messages/${n.id}/attachments`);
    for (const a of anh.value ?? []) {
      if (!a.name || !regeln.some(r => r.test(a.name))) continue;
      if (gespeichert.has(a.name)) continue;
      if (!a.contentBytes) { console.log(`OHNE INHALT: ${a.name}`); continue; }
      const ablage = join(ziel, a.name.replace(/[/\\]/g, '_'));
      writeFileSync(ablage, Buffer.from(a.contentBytes, 'base64'));
      gespeichert.add(a.name);
      console.log(`${ablage}   <- ${n.receivedDateTime.slice(0, 10)} ${String(n.subject).slice(0, 60)}`);
    }
  }
  if (gespeichert.size === 0) console.log('Kein Anhang passte auf die Namensmuster.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

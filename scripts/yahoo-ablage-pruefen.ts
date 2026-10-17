/**
 * scripts/yahoo-ablage-pruefen — Gegenprobe zur Aufteilung der Ablage.
 * NUR LESEN.
 *
 * Vergleicht die vor dem Verschieben aufgenommenen Message-IDs mit dem, was
 * in den Jahresordnern liegt: kein Verlust, keine Dublette. Nachrichten ohne
 * Message-ID — Yahoo liefert bei einigen keine — werden ueber Datum und
 * Betreff abgeglichen und getrennt ausgewiesen.
 *
 * Aufruf: bun run scripts/yahoo-ablage-pruefen.ts <Arbeitsverzeichnis> [<Durchlauf>]
 */
import { ImapFlow } from 'imapflow';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
  return treffer[1].trim();
}

interface Nachricht { uid: number; jahr: string; messageId: string; datum: string; betreff: string; }

/** Ersatzschluessel fuer Nachrichten ohne Message-ID. */
const ersatz = (n: { datum: string; betreff: string }) => `${n.datum}|${n.betreff}`;

async function main() {
  const werk = process.argv[2];
  const nurDurchlauf = process.argv[3];
  if (!werk) { console.error('Aufruf: bun run scripts/yahoo-ablage-pruefen.ts <Arbeitsverzeichnis> [<Durchlauf>]'); process.exit(2); }

  const dateien = readdirSync(werk)
    .filter((n) => /^durchlauf-\d+-uids\.json$/.test(n))
    .filter((n) => !nurDurchlauf || n.includes(`-${String(nurDurchlauf).padStart(2, '0')}-`))
    .sort();
  if (!dateien.length) { console.error('keine Aufnahme gefunden'); process.exit(2); }

  const soll = new Map<string, Nachricht[]>();   // Jahr -> erwartete Nachrichten
  for (const d of dateien) {
    for (const n of JSON.parse(readFileSync(`${werk}/${d}`, 'utf-8')) as Nachricht[]) {
      const liste = soll.get(n.jahr) ?? [];
      liste.push(n); soll.set(n.jahr, liste);
    }
  }

  const client = new ImapFlow({
    host: env('YAHOO_IMAP_HOST'), port: Number(env('YAHOO_IMAP_PORT') || 993), secure: true,
    auth: { user: env('YAHOO_USER'), pass: env('YAHOO_APP_PASSWORD') },
    logger: false, socketTimeout: 300000,
  });
  client.on('error', (e: any) => console.error(`[imap] ${e?.message ?? e}`));
  await client.connect();

  const bericht: Array<Record<string, unknown>> = [];
  let fehlerGesamt = 0;

  for (const [jahr, erwartet] of [...soll.entries()].sort()) {
    const pfad = `Ablage/${jahr}`;
    const stand = await client.status(pfad, { messages: true }).catch(() => null);
    if (!stand) { console.log(`${pfad}: Ordner fehlt — ${erwartet.length} Nachrichten erwartet`); fehlerGesamt += erwartet.length; continue; }

    const sperre = await client.getMailboxLock(pfad);
    const istIds: string[] = [];
    const istErsatz: string[] = [];
    let gelesen = 0;
    try {
      const fenster = (client.mailbox as { exists: number }).exists;
      for (let von = 1; von <= fenster; von += 5000) {
        const bis = Math.min(von + 4999, fenster);
        for await (const m of client.fetch(`${von}:${bis}`, { uid: true, envelope: true })) {
          gelesen++;
          const id = m.envelope?.messageId ?? '';
          if (id) istIds.push(id);
          else {
            const d = m.envelope?.date ? new Date(m.envelope.date) : null;
            istErsatz.push(ersatz({
              datum: d && !Number.isNaN(d.getTime()) ? d.toISOString() : '',
              betreff: m.envelope?.subject ?? '',
            }));
          }
        }
      }
    } finally { sperre.release(); }

    const sollMitId = erwartet.filter((n) => n.messageId);
    const sollOhneId = erwartet.filter((n) => !n.messageId);
    const istSet = new Set(istIds);
    const fehlend = sollMitId.filter((n) => !istSet.has(n.messageId));
    const ersatzSet = new Set(istErsatz);
    const fehlendOhneId = sollOhneId.filter((n) => !ersatzSet.has(ersatz(n)));

    /* Eine Message-ID darf im Ziel genau so oft vorkommen wie in der Quelle.
       Mehrfach zugestellte Rundschreiben lagen schon vorher doppelt in der
       Ablage; das ist keine Dublette des Verschiebens. Gemeldet wird nur,
       was haeufiger liegt als aufgenommen. */
    const istZaehler = new Map<string, number>();
    for (const id of istIds) istZaehler.set(id, (istZaehler.get(id) ?? 0) + 1);
    const sollZaehler = new Map<string, number>();
    for (const n of sollMitId) sollZaehler.set(n.messageId, (sollZaehler.get(n.messageId) ?? 0) + 1);
    const dubletten = [...istZaehler.entries()].filter(([id, n]) => n > (sollZaehler.get(id) ?? 0));
    const mehrfachInQuelle = [...sollZaehler.values()].filter((n) => n > 1).length;

    const zeile = {
      ordner: pfad,
      gemeldet: stand.messages ?? 0,
      gelesen,
      erwartet: erwartet.length,
      mit_message_id: sollMitId.length,
      ohne_message_id: sollOhneId.length,
      fehlend: fehlend.length,
      fehlend_ohne_id: fehlendOhneId.length,
      dubletten: dubletten.length,
      mehrfach_schon_in_quelle: mehrfachInQuelle,
    };
    bericht.push(zeile);
    fehlerGesamt += fehlend.length + fehlendOhneId.length + dubletten.length;
    console.log(`${pfad.padEnd(14)} gemeldet ${String(zeile.gemeldet).padStart(6)}  gelesen ${String(gelesen).padStart(6)}`
      + `  erwartet ${String(erwartet.length).padStart(6)}`
      + `  fehlend ${fehlend.length}+${fehlendOhneId.length}  neue Dubletten ${dubletten.length}`
      + (mehrfachInQuelle ? `  (${mehrfachInQuelle} schon in der Quelle mehrfach)` : ''));
    if (fehlend.length) console.log('   erste fehlende Message-IDs:', fehlend.slice(0, 3).map((n) => n.messageId).join(' '));
  }

  const ablage = await client.status('Ablage', { messages: true }).catch(() => null);
  console.log(`\nAblage (Restbestand): ${ablage?.messages ?? '?'}`);
  console.log(fehlerGesamt === 0
    ? 'ERGEBNIS: kein Verlust, keine Dublette.'
    : `ERGEBNIS: ${fehlerGesamt} Auffaelligkeiten — nicht weiterverschieben.`);
  writeFileSync(`${werk}/gegenprobe.json`,
    JSON.stringify({ geprueft: new Date().toISOString(), ablage_rest: ablage?.messages ?? null, fehlerGesamt, bericht }, null, 1) + '\n');
  await client.logout();
  process.exit(fehlerGesamt === 0 ? 0 : 5);
}

main().catch((e) => { console.error(e); process.exit(1); });

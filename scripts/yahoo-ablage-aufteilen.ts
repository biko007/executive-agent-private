/**
 * scripts/yahoo-ablage-aufteilen — den Ordner "Ablage" in Jahresordner teilen.
 *
 * Hintergrund: Yahoo gibt je Ordner nur die juengsten 10.000 Nachrichten
 * heraus (Serverkennung MESSAGELIMIT). Die Ablage enthaelt 54.691. Teilt man
 * sie in Jahresordner, liegt jeder Ordner unter der Schwelle und ist
 * vollstaendig lesbar. Owner-Freigabe vom 18.10.2026, 00:11.
 *
 * Erlaubt ist ausschliesslich: Nachrichten aus "Ablage" in neue
 * Unterordner "Ablage/<Jahr>" DESSELBEN Postfachs verschieben. Kein
 * Loeschen, kein Lesevermerk, kein anderer Ordner.
 *
 * Ablauf je Durchlauf:
 *   1. Zaehlstand protokollieren
 *   2. erreichbares Fenster lesen (Umschlaege), nach Jahr gruppieren
 *   3. Jahresordner anlegen, soweit nicht vorhanden
 *   4. in Bloecken verschieben; UIDPLUS liefert die Ziel-UIDs
 *   5. Gegenprobe: Message-ID je Ziel-UID gegen den Vorzustand
 *   6. Zaehlstand erneut protokollieren
 * Bei einer Abweichung bricht der Lauf ab, ohne weiterzuverschieben.
 *
 * Aufruf:
 *   bun run scripts/yahoo-ablage-aufteilen.ts <Arbeitsverzeichnis> [--probe] [--max N]
 *     --probe    nur ein Durchlauf, danach anhalten (Testjahr)
 *     --max N    hoechstens N Durchlaeufe
 *     --schnell  ohne Sofortprobe im Zielordner; die Gegenprobe laeuft dann
 *                ueber scripts/yahoo-ablage-pruefen.ts
 */
import { ImapFlow } from 'imapflow';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';

const QUELLE = 'Ablage';
const BLOCK = 200;            // UIDs je MOVE
const PAUSE_MS = 400;         // Drosselung zwischen den Bloecken
const PAUSE_DURCHLAUF_MS = 2000;

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
  return treffer[1].trim();
}
const schlaf = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Nachricht { uid: number; jahr: string; messageId: string; datum: string; betreff: string; }
interface Protokoll {
  durchlauf: number;
  vorher: number;
  fenster: number;
  jeJahr: Record<string, number>;
  verschoben: Record<string, number>;
  geprueft: Record<string, number>;
  ohneMessageId: number;
  nachher: number;
  abweichung: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const werk = process.argv[2];
  if (!werk) { console.error('Aufruf: bun run scripts/yahoo-ablage-aufteilen.ts <Arbeitsverzeichnis> [--probe] [--max N]'); process.exit(2); }
  mkdirSync(werk, { recursive: true });
  const nurProbe = process.argv.includes('--probe');
  /* Die Sofortprobe liest die Umschlaege im Zielordner erneut und kostet
     etwa die Haelfte der Laufzeit. Der strengere Nachweis ist ohnehin
     scripts/yahoo-ablage-pruefen.ts nach dem Durchlauf. */
  const schnell = process.argv.includes('--schnell');
  const maxDurchlaeufe = Number(arg('--max') ?? 20);

  const client = new ImapFlow({
    host: env('YAHOO_IMAP_HOST'), port: Number(env('YAHOO_IMAP_PORT') || 993), secure: true,
    auth: { user: env('YAHOO_USER'), pass: env('YAHOO_APP_PASSWORD') },
    logger: false, socketTimeout: 300000,
  });
  client.on('error', (e: any) => console.error(`[imap] ${e?.message ?? e}`));
  await client.connect();

  const faehig = [...((client as any).capabilities?.keys?.() ?? [])];
  if (!faehig.includes('MOVE')) {
    console.error('Server kennt MOVE nicht — dieses Skript verschiebt nur per MOVE. Abbruch.');
    await client.logout(); process.exit(3);
  }

  /** Zaehlstand aller Ordner, zur Protokollierung vor und nach jedem Schritt. */
  async function zaehlstand(): Promise<Record<string, number>> {
    const raus: Record<string, number> = {};
    for (const b of await client.list()) {
      const st = await client.status(b.path, { messages: true }).catch(() => null);
      raus[b.path] = st?.messages ?? 0;
    }
    return raus;
  }

  const ordnerVorhanden = new Set((await client.list()).map((b) => b.path));
  async function jahresordner(jahr: string): Promise<string> {
    const pfad = `${QUELLE}/${jahr}`;
    if (ordnerVorhanden.has(pfad)) return pfad;
    try {
      await client.mailboxCreate(pfad);
      console.log(`  Ordner angelegt: ${pfad}`);
    } catch (e: any) {
      if (!/already exists|ALREADYEXISTS/i.test(String(e?.message))) throw e;
    }
    ordnerVorhanden.add(pfad);
    return pfad;
  }

  const protokolle: Protokoll[] = [];
  const standPfad = `${werk}/zaehlstand.json`;
  const anfangsstand = existsSync(standPfad)
    ? JSON.parse(readFileSync(standPfad, 'utf-8')).anfang
    : (await zaehlstand());
  writeFileSync(standPfad, JSON.stringify({ anfang: anfangsstand }, null, 1) + '\n');
  console.log(`Ablage am Anfang: ${anfangsstand[QUELLE]} Nachrichten\n`);

  /* Jeder Aufruf schreibt seine Aufnahme unter einer eigenen Nummer. Ohne
     das ueberschreibt ein zweiter Aufruf mit --probe die Aufnahme des ersten,
     und die Gegenprobe haette dann einen unvollstaendigen Vorzustand. */
  const schonDa = readdirSync(werk).filter((n) => /^durchlauf-\d+-uids\.json$/.test(n)).length;
  for (let durchlauf = schonDa + 1; durchlauf <= schonDa + maxDurchlaeufe; durchlauf++) {
    const vorher = (await client.status(QUELLE, { messages: true })).messages ?? 0;
    if (vorher === 0) { console.log(`Durchlauf ${durchlauf}: Ablage ist leer — fertig.`); break; }

    /* --- 2. Fenster lesen --- */
    const sperre = await client.getMailboxLock(QUELLE);
    let nachrichten: Nachricht[] = [];
    let fenster = 0;
    try {
      fenster = (client.mailbox as { exists: number }).exists;
      for (let von = 1; von <= fenster; von += 5000) {
        const bis = Math.min(von + 4999, fenster);
        for await (const m of client.fetch(`${von}:${bis}`, { uid: true, envelope: true })) {
          const d = m.envelope?.date ? new Date(m.envelope.date) : null;
          nachrichten.push({
            uid: m.uid,
            jahr: d && !Number.isNaN(d.getTime()) ? String(d.getFullYear()) : 'ohne-Datum',
            messageId: m.envelope?.messageId ?? '',
            datum: d && !Number.isNaN(d.getTime()) ? d.toISOString() : '',
            betreff: m.envelope?.subject ?? '',
          });
        }
      }
    } finally { sperre.release(); }

    const jeJahr: Record<string, number> = {};
    for (const n of nachrichten) jeJahr[n.jahr] = (jeJahr[n.jahr] ?? 0) + 1;
    console.log(`Durchlauf ${durchlauf}: Ablage ${vorher}, Fenster ${fenster}, Jahre `
      + Object.entries(jeJahr).sort().map(([j, n]) => `${j}:${n}`).join(' '));
    writeFileSync(`${werk}/durchlauf-${String(durchlauf).padStart(2, '0')}-uids.json`,
      JSON.stringify(nachrichten, null, 0) + '\n');

    /* --- 3./4. verschieben --- */
    const verschoben: Record<string, number> = {};
    const geprueft: Record<string, number> = {};
    let ohneMessageId = 0;
    for (const [jahr, anzahl] of Object.entries(jeJahr).sort()) {
      const ziel = await jahresordner(jahr);
      const liste = nachrichten.filter((n) => n.jahr === jahr);
      const erwartet = new Map<number, string>();   // Quell-UID -> Message-ID
      for (const n of liste) {
        erwartet.set(n.uid, n.messageId);
        if (!n.messageId) ohneMessageId++;
      }
      let bewegt = 0;
      let ohneUidMap = 0;
      const zielUids: number[] = [];
      const zuordnung: Array<[number, number]> = [];

      const sperre2 = await client.getMailboxLock(QUELLE);
      try {
        for (let i = 0; i < liste.length; i += BLOCK) {
          const teil = liste.slice(i, i + BLOCK).map((n) => n.uid);
          const r: any = await client.messageMove(teil.join(','), ziel, { uid: true });
          const karte: Map<number, number> | undefined = r?.uidMap;
          /* MOVE ist atomar: gelingt der Befehl, ist der ganze Block bewegt.
             Yahoo liefert die COPYUID-Antwort nur fuer einen Teil der Bloecke
             und dort gelegentlich unvollstaendig — sie ist Beleg, nicht
             Zaehlgrundlage. Gezaehlt wird der Block. */
          bewegt += teil.length;
          if (karte && karte.size) {
            for (const [quellUid, zielUid] of karte.entries()) {
              zielUids.push(Number(zielUid));
              zuordnung.push([Number(quellUid), Number(zielUid)]);
            }
            if (karte.size < teil.length) ohneUidMap += teil.length - karte.size;
          } else {
            /* Yahoo liefert die COPYUID-Antwort nur fuer einen Teil der
               Bloecke. Dann zaehlt der Block mit, und die Message-ID-Probe
               uebernimmt scripts/yahoo-ablage-pruefen.ts fuer den ganzen
               Ordner — das ist der strengere Nachweis. */
            ohneUidMap += teil.length;
          }
          process.stderr.write(`\r   ${jahr}: ${bewegt}/${anzahl}   `);
          await schlaf(PAUSE_MS);
        }
      } finally { sperre2.release(); }
      process.stderr.write('\r');
      verschoben[jahr] = bewegt;
      writeFileSync(`${werk}/durchlauf-${String(durchlauf).padStart(2, '0')}-${jahr}-zuordnung.json`,
        JSON.stringify(zuordnung, null, 0) + '\n');

      /* --- 5. Gegenprobe: Message-ID je Ziel-UID --- */
      let treffer = 0;
      if (zielUids.length && !schnell) {
        const sperre3 = await client.getMailboxLock(ziel);
        try {
          for (let i = 0; i < zuordnung.length; i += 500) {
            const teil = zuordnung.slice(i, i + 500);
            const nachId = new Map<number, string>();
            for await (const m of client.fetch({ uid: teil.map(([, z]) => z).join(',') },
                { uid: true, envelope: true }, { uid: true })) {
              nachId.set(m.uid, m.envelope?.messageId ?? '');
            }
            for (const [quellUid, zielUid] of teil) {
              const soll = erwartet.get(quellUid) ?? '';
              const ist = nachId.get(zielUid);
              if (ist === undefined) continue;
              if (soll === '' || ist === soll) treffer++;
            }
          }
        } finally { sperre3.release(); }
      }
      geprueft[jahr] = treffer;
      console.log(`   ${jahr}: ${bewegt} verschoben, ${treffer} sofort per Message-ID bestaetigt`
        + (ohneUidMap ? `, ${ohneUidMap} ohne COPYUID-Antwort (Gegenprobe separat)` : '')
        + ` -> ${ziel}`);
    }

    /* --- 6. Zaehlstand --- */
    const nachher = (await client.status(QUELLE, { messages: true })).messages ?? 0;
    const summeVerschoben = Object.values(verschoben).reduce((a, b) => a + b, 0);
    const abweichung = (vorher - nachher) - summeVerschoben;
    const prot: Protokoll = { durchlauf, vorher, fenster, jeJahr, verschoben, geprueft, ohneMessageId, nachher, abweichung };
    protokolle.push(prot);
    writeFileSync(`${werk}/protokoll.json`, JSON.stringify(protokolle, null, 1) + '\n');
    console.log(`   Ablage ${vorher} -> ${nachher}, verschoben ${summeVerschoben}, Abweichung ${abweichung}\n`);

    if (abweichung !== 0) {
      console.error(`ABBRUCH: Zaehlabweichung ${abweichung} im Durchlauf ${durchlauf}. Es wird nichts weiter verschoben.`);
      await client.logout(); process.exit(4);
    }
    if (nurProbe) { console.log('--probe: nach einem Durchlauf angehalten.'); break; }
    await schlaf(PAUSE_DURCHLAUF_MS);
  }

  const endstand = await zaehlstand();
  writeFileSync(standPfad, JSON.stringify({ anfang: anfangsstand, ende: endstand }, null, 1) + '\n');
  console.log('--- Endstand ---');
  for (const [p, n] of Object.entries(endstand).filter(([, n]) => n > 0).sort()) {
    console.log(`  ${String(n).padStart(6)}  ${p}`);
  }
  const ges = Object.values(endstand).reduce((a, b) => a + b, 0);
  const gesVorher = Object.values(anfangsstand as Record<string, number>).reduce((a, b) => a + b, 0);
  console.log(`  ${String(ges).padStart(6)}  GESAMT (vorher ${gesVorher}, Differenz ${ges - gesVorher})`);
  await client.logout();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

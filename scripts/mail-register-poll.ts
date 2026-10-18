#!/usr/bin/env bun
/**
 * Nimmt die Sammelstelle `data@bikolino.com` ins Mail-Register auf.
 *
 * Owner-Entscheidung 18.10.2026, 17:15: data@ ist die einzige Sammelstelle
 * fuer Weiterleitungen aus Fremdpostfaechern; die erste ist Proton. Dieses
 * Skript registriert die Nachrichten mit derselben Mechanik wie das Register
 * des Geschaeftspostfachs vom 17.10.2026 und schiebt Proton-Weiterleitungen
 * in den Ordner `Proton`. Es loescht nichts und versendet nichts.
 *
 * Aufruf durch den systemd-user-Timer `mail-register.timer` (alle 5 Minuten).
 *
 *   bun run scripts/mail-register-poll.ts
 *   bun run scripts/mail-register-poll.ts --probe       (zeigen, nichts tun)
 *   bun run scripts/mail-register-poll.ts --ohne-verschieben
 *   bun run scripts/mail-register-poll.ts --csv         (CSV nach Dropbox)
 *   bun run scripts/mail-register-poll.ts --nachtragen 2026-10-18T18:00:00Z
 *       (schon registrierte Nachrichten ab diesem Zeitpunkt zusaetzlich ablegen)
 *   bun run scripts/mail-register-poll.ts --ohne-ablage  (nur Register, wie vorher)
 */
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { dropboxZugang } from '../src/adapters/dropbox-zugang.js';
import {
  erstelleMailboxZugang, verarbeiteRegisterEinmal, ladeRegister, reportAbschnitt,
  registerCsv, belegCsv, belegEintraege, herkunftAusKopf,
  SAMMELSTELLE, DROPBOX_REGISTER, PROTON_ORDNER, ordnerUebergehen,
} from '../src/modules/mail-register/index.js';
import { ladeKonfiguration } from '../src/modules/mail-eingang/index.js';

const HOME = process.env.HOME || homedir();
const ZUSTAND = path.join(HOME, '.openclaw', 'workspace', 'artifacts', 'personal',
  'mail-register');
const REGISTER = path.join(ZUSTAND, 'data.jsonl');
const ABLAGESTAND = path.join(ZUSTAND, 'ablage.json');
const MAIL_KONFIG = path.join(HOME, '.config', 'openclaw', 'mail-eingang.json');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const probe = process.argv.includes('--probe');
const csvExport = process.argv.includes('--csv');
const ohneVerschieben = process.argv.includes('--ohne-verschieben');
const ohneAblage = process.argv.includes('--ohne-ablage');
const nachtragenSeitIso = arg('--nachtragen');

function env(k: string): string { return (process.env[k] ?? '').trim(); }

const zugangsdaten = {
  tenantId: env('M365_TENANT_ID'), clientId: env('M365_CLIENT_ID'),
  clientSecret: env('M365_CLIENT_SECRET'), postfach: SAMMELSTELLE,
};
if (!zugangsdaten.tenantId || !zugangsdaten.clientId || !zugangsdaten.clientSecret) {
  process.stdout.write('mail-register: M365-Zugang fehlt — nichts zu tun.\n');
  process.exit(0);
}

const postfach = erstelleMailboxZugang(zugangsdaten);

try {
  if (probe) {
    const ordner = await postfach.ordner();
    process.stdout.write(`Probe ${SAMMELSTELLE}: ${ordner.length} Ordner\n`);
    for (const o of ordner) {
      process.stdout.write(`  ${o.name.padEnd(28)} ${String(o.anzahl).padStart(6)}`
        + `${ordnerUebergehen(o.name) ? '  (übergangen)' : ''}\n`);
    }
    const stand = ladeRegister(REGISTER);
    process.stdout.write(`Register: ${stand.eintraege.length} Einträge\n`);
    for (const o of ordner.filter((x) => !ordnerUebergehen(x.name) && x.anzahl > 0)) {
      for (const m of await postfach.mails(o.id)) {
        const h = herkunftAusKopf(m.kopf, m.absender);
        process.stdout.write(`  ${m.empfangenIso.slice(0, 16)} ${h.herkunft.padEnd(7)}`
          + ` ${(m.absender || '?').padEnd(26)} ${m.betreff.slice(0, 40)}`
          + `${h.weitergeleitetVon ? ' ← ' + h.weitergeleitetVon : ''}\n`);
      }
    }
    process.exit(0);
  }

  /* Dropbox-Ablage fuer alles, was nicht per Proton kam (Owner-Regel
     18.10.2026, 20:20). Fehlt der Dropbox-Zugang, laeuft nur das Register. */
  const dropbox = dropboxZugang((k) => process.env[k]);
  const ablage = !ohneAblage && dropbox
    ? {
      dropbox: dropbox.adapter,
      homeDir: HOME,
      konfiguration: ladeKonfiguration(MAIL_KONFIG),
      ablageStandPfad: ABLAGESTAND,
      nachtragenSeitIso,
    }
    : undefined;
  if (!ohneAblage && !dropbox) {
    process.stderr.write('mail-register: kein Dropbox-Zugang — Ablage übersprungen.\n');
  }

  const lauf = await verarbeiteRegisterEinmal({
    postfach,
    registerPfad: REGISTER,
    verschieben: !ohneVerschieben,
    ablage,
    logger: {
      info: (m: string) => process.stdout.write(m + '\n'),
      warn: (m: string) => process.stderr.write(m + '\n'),
    },
  });

  const stand = ladeRegister(REGISTER);
  if (lauf.neu.length || lauf.nachgetragen.length) {
    process.stdout.write('\n' + reportAbschnitt(lauf, stand.eintraege.length) + '\n');
    if (lauf.verschoben) {
      process.stdout.write(`${lauf.verschoben} Nachricht(en) nach ${PROTON_ORDNER} verschoben.\n`);
    }
    if (lauf.nichtVerschoben) {
      process.stderr.write(`${lauf.nichtVerschoben} Nachricht(en) nicht verschoben `
        + '(kein Schreibrecht oder Ordner nicht anlegbar).\n');
    }
    /* Kurzmeldung nach bikosoc-dev. Der interne Endpunkt kennt die Chat-Bindung. */
    const proton = lauf.neu.filter((e) => e.herkunft === 'proton').length;
    const belege = belegEintraege(lauf.neu).length;
    await fetch('http://127.0.0.1:18789/api/internal/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Sammelstelle data@: ${lauf.neu.length} neue Nachricht(en) registriert`,
        severity: 'info', role: 'dev', lage: 'ok', titel: 'Sammelstelle data@',
        zeilen: [
          `${lauf.neu.length} neu, ${stand.eintraege.length} im Register`,
          `davon ${proton} per Proton weitergeleitet`,
          belege ? `${belege} mit Kostenbezug (Rechnung, Vertrag, Versicherung)` : 'kein Kostenbezug',
        ],
      }),
    }).catch(() => { /* Meldung ist Beiwerk */ });
  } else {
    process.stdout.write(`mail-register: ${lauf.mailsGesehen} Nachrichten geprüft, `
      + `nichts neu (${stand.eintraege.length} im Register).\n`);
  }

  /* CSV nur schreiben, wenn sich etwas geaendert hat — oder auf Verlangen.
     Ein Timer alle fuenf Minuten soll nicht unveraenderte Dateien hochladen. */
  if (csvExport || lauf.neu.length) {
    const zugang = dropbox;
    if (!zugang) {
      process.stderr.write('CSV-Export übersprungen: kein Dropbox-Zugang.\n');
    } else {
      const dateien: Array<[string, string]> = [
        ['data-register.csv', registerCsv(stand.eintraege)],
        ['data-belege.csv', belegCsv(stand.eintraege)],
      ];
      for (const [name, inhalt] of dateien) {
        await zugang.adapter.uploadFile({
          path: `${DROPBOX_REGISTER}/${name}`,
          body: Buffer.from(inhalt, 'utf-8'),
          contentType: 'text/csv; charset=utf-8',
        });
        process.stdout.write(`${DROPBOX_REGISTER}/${name} (${Buffer.byteLength(inhalt)} B)\n`);
      }
      const csvLokal = path.join(path.dirname(REGISTER), 'data-register.csv');
      fs.writeFileSync(csvLokal, registerCsv(stand.eintraege), 'utf-8');
    }
  }
} catch (e: any) {
  process.stderr.write(`mail-register Fehler: ${e?.message ?? e}\n`);
  process.exit(1);
}

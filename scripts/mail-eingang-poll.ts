#!/usr/bin/env bun
/**
 * Holt den Mail-Eingangskanal des Owners ab.
 *
 * Owner-Entscheidung (18.10.2026, 15:47): Mails an
 * `juergen.bickel+bikosoc@bikolino.com` sind der Eingang. Ohne Kennzeichnung
 * wandern sie in die Ablage, mit „Auftrag:" im Betreff zusaetzlich als
 * Auftragsdatei nach `~/inbox/` — dort uebernimmt der vorhandene
 * Prompt-Inbox-Poller unveraendert.
 *
 * Aufruf durch den systemd-user-Timer `mail-eingang.timer` (alle 5 Minuten).
 *
 * Fehlen die M365- oder Dropbox-Zugaenge, endet das Skript still mit 0 — dann
 * ist das Feature einfach nicht eingerichtet. Es versendet nie eine Mail.
 *
 * Aufrufe:
 *   bun run scripts/mail-eingang-poll.ts
 *   bun run scripts/mail-eingang-poll.ts --probe        (nur zeigen, nichts tun)
 *   bun run scripts/mail-eingang-poll.ts --stunden 72   (Rueckblick erweitern)
 */
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { dropboxZugang } from '../src/adapters/dropbox-zugang.js';
import {
  erstelleGraphZugang, verarbeiteMailEingangEinmal, ladeKonfiguration,
  meldungstext, reportAbschnitt, empfaengerTreffer, istOwnerAbsender, lage,
  type MailEingangZeile,
} from '../src/modules/mail-eingang/index.js';

const HOME = process.env.HOME || homedir();
const KONFIG = path.join(HOME, '.config', 'openclaw', 'mail-eingang.json');
const VERMERK = path.join(HOME, '.openclaw', 'workspace', 'artifacts',
  'mail-eingang', 'verarbeitet.json');
const PROTOKOLL = path.join(HOME, '.openclaw', 'workspace', 'artifacts',
  'mail-eingang', 'protokoll.jsonl');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const probe = process.argv.includes('--probe');
const stunden = Number(arg('--stunden') ?? '24');

function env(k: string): string {
  return (process.env[k] ?? '').trim();
}

const tenantId = env('M365_TENANT_ID');
const clientId = env('M365_CLIENT_ID');
const clientSecret = env('M365_CLIENT_SECRET');
const user = env('M365_USER');
if (!tenantId || !clientId || !clientSecret || !user) {
  process.stdout.write('mail-eingang: M365-Zugang fehlt — nichts zu tun.\n');
  process.exit(0);
}

const zugang = dropboxZugang((k) => process.env[k]);
if (!zugang) {
  process.stdout.write('mail-eingang: Dropbox-Zugang fehlt — nichts zu tun.\n');
  process.exit(0);
}

const konfiguration = ladeKonfiguration(KONFIG);
const postfach = erstelleGraphZugang({ tenantId, clientId, clientSecret, user });

/** Kurzmeldung nach bikosoc-dev. Der interne Endpunkt kennt die Chat-Bindung. */
async function melde(zeile: MailEingangZeile): Promise<void> {
  const lageWert = zeile.lage === 'fehler' ? 'fehler'
    : zeile.fremderAbsender ? 'hinweis' : 'ok';
  const zeilen = [
    `Von ${zeile.absender}${zeile.fremderAbsender ? ' (fremder Absender)' : ''}`,
    zeile.auftragsDatei
      ? `Auftrag ${path.basename(zeile.auftragsDatei)}`
      : `Ablage ${zeile.ablagePfad}`,
    zeile.anhaenge.length ? `Anhänge: ${zeile.anhaenge.join(', ')}` : 'ohne Anhang',
  ];
  if (zeile.hinweis) zeilen.push(zeile.hinweis);
  if (zeile.einsortiert === 'nicht_moeglich') {
    zeilen.push('im Postfach nicht verschoben (kein Schreibrecht)');
  }
  try {
    await fetch('http://127.0.0.1:18789/api/internal/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: meldungstext(zeile),
        severity: zeile.lage === 'fehler' ? 'error' : zeile.fremderAbsender ? 'warn' : 'info',
        role: 'dev',
        lage: lageWert,
        titel: zeile.lage === 'fehler' ? 'Mail-Eingang Fehler' : 'Mail-Eingang',
        zeilen,
      }),
    });
  } catch { /* Meldung ist Beiwerk; die Ablage zaehlt. */ }
}

function protokolliere(zeile: MailEingangZeile): void {
  fs.mkdirSync(path.dirname(PROTOKOLL), { recursive: true });
  fs.appendFileSync(PROTOKOLL, JSON.stringify({ ...zeile, lauf: new Date().toISOString() }) + '\n');
}

try {
  if (probe) {
    /* Probe: zeigen, was ein Lauf tun wuerde. Kein Upload, keine Datei,
       kein Vermerk, keine Meldung. */
    const seit = new Date(Date.now() - stunden * 3_600_000).toISOString();
    const mails = await postfach.neueMails(seit);
    const treffer = mails.filter((m) =>
      empfaengerTreffer({ to: m.to, cc: m.cc }, konfiguration.zieladresse));
    process.stdout.write(
      `Probe: ${mails.length} Mails seit ${seit}, ${treffer.length} im Eingangskanal `
      + `(${konfiguration.zieladresse}).\n`);
    for (const m of treffer) {
      const fremd = !istOwnerAbsender(m.absender, konfiguration.ownerAbsender);
      process.stdout.write(
        `  ${m.empfangenIso.slice(0, 16)} ${fremd ? 'ablage (fremd)' : lage(m.betreff)} `
        + `| ${m.absender} | ${m.betreff}${m.hatAnhaenge ? ' | mit Anhang' : ''}\n`);
    }
    process.exit(0);
  }

  const lauf = await verarbeiteMailEingangEinmal({
    postfach,
    dropbox: zugang.adapter,
    homeDir: HOME,
    konfiguration,
    vermerkPfad: VERMERK,
    rueckblickStunden: stunden,
    melde: async (z) => { protokolliere(z); await melde(z); },
    logger: {
      info: (m: string) => process.stdout.write(m + '\n'),
      warn: (m: string) => process.stderr.write(m + '\n'),
    },
  });

  if (lauf.verarbeitet.length) {
    process.stdout.write(`\n${reportAbschnitt(lauf)}\n`);
  } else {
    process.stdout.write(
      `mail-eingang: ${lauf.gesehen} Mails geprüft, keine neue im Eingangskanal.\n`);
  }
} catch (e: any) {
  process.stderr.write(`mail-eingang Fehler: ${e?.message ?? e}\n`);
  process.exit(1);
}

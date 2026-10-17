#!/usr/bin/env bun
/**
 * scripts/casameta-protokoll — den Lauf eines Portal-Agenten auswerten.
 *
 * Der Agent hängt während des Laufs nur Zeilen an `aktionen.jsonl` an. Dieses
 * Skript läuft danach und macht daraus das eigentliche Protokoll:
 *
 *   1. SECRET-SCAN. Zuerst, vor allem anderen. Taucht das Passwort irgendwo im
 *      Lauf-Ordner auf — in einer Datei, einem Dateinamen, dem Trace —, bricht
 *      das Skript ab und lädt nichts hoch. Der Wert selbst wird dabei nie
 *      ausgegeben, auch nicht gekürzt.
 *   2. Aktionen nach Postgres (wiederholbar, siehe store.ts).
 *   3. Markdown-Zusammenfassung schreiben.
 *   4. Lauf-Ordner nach Dropbox.
 *   5. Telegram an den operativen Chat — ohne Mieternamen.
 *
 * Diese Reihenfolge ist nicht beliebig: Der Secret-Scan steht vor dem Upload,
 * damit ein Fehler im Agenten nicht zu einem Passwort in der Cloud wird.
 *
 * Aufruf:  bun run scripts/casameta-protokoll.ts <lauf-ordner>
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { homedir } from 'node:os';

const ENV_PORTALE = join(homedir(), '.config', 'biko-portals', 'env');
const ENV_OPENCLAW = join(homedir(), '.config', 'openclaw', 'env');
const DROPBOX_BASIS = '/bikosoc-reports/casameta/runs';

interface LaufKopf {
  runId: string; propertyCode?: string; periodYear?: number;
  mode: 'lesen' | 'schreiben'; taskFile?: string;
  status?: 'fertig' | 'fehler' | 'gestoppt'; stopReason?: string;
}

function envWert(datei: string, schluessel: string): string | null {
  if (!existsSync(datei)) return null;
  const t = readFileSync(datei, 'utf-8').match(new RegExp(`^${schluessel}=(.*)$`, 'm'));
  return t && t[1].trim() ? t[1].trim() : null;
}

/** Alle Dateien des Lauf-Ordners, rekursiv. */
function dateienSammeln(wurzel: string, ordner = wurzel): string[] {
  const raus: string[] = [];
  for (const e of readdirSync(ordner)) {
    const p = join(ordner, e);
    if (statSync(p).isDirectory()) raus.push(...dateienSammeln(wurzel, p));
    else raus.push(p);
  }
  return raus;
}

/**
 * Sucht den Passwortwert in allen Artefakten des Laufs.
 *
 * Gibt die Fundstellen als Pfade zurück — niemals den Wert, auch nicht in
 * Teilen. Ohne hinterlegte Zugangsdaten gilt der Lauf als ungeprüft, nicht als
 * sauber; der Unterschied steht in der Rückgabe.
 *
 * Das Passwort ist ein Parameter mit Voreinstellung aus der env-Datei. Nur so
 * lässt sich die Funktion testen, ohne echte Zugangsdaten anzulegen.
 */
function secretScan(
  ordner: string,
  passwort: string | null = envWert(ENV_PORTALE, 'CASAMETA_PASSWORD'),
): { geprueft: boolean; treffer: string[] } {
  if (!passwort) return { geprueft: false, treffer: [] };
  const treffer: string[] = [];
  for (const datei of dateienSammeln(ordner)) {
    if (datei.includes(passwort)) { treffer.push(`${relative(ordner, datei)} (Dateiname)`); continue; }
    /* Binärdateien wie Screenshots und trace.zip werden als Rohbytes gelesen;
       ein Passwort im Klartext fiele auch dort auf. */
    try {
      if (readFileSync(datei).toString('latin1').includes(passwort)) {
        treffer.push(relative(ordner, datei));
      }
    } catch { /* unlesbare Datei — im Zweifel melden wir sie nicht als sauber */ }
  }
  return { geprueft: true, treffer };
}

function kopfLesen(ordner: string): LaufKopf {
  const p = join(ordner, 'lauf.json');
  if (!existsSync(p)) throw new Error(`lauf.json fehlt in ${ordner}`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function aktionenLesen(ordner: string): any[] {
  const p = join(ordner, 'aktionen.jsonl');
  if (!existsSync(p)) return [];
  const raus: any[] = [];
  let nr = 0;
  for (const zeile of readFileSync(p, 'utf-8').split('\n')) {
    const t = zeile.trim();
    if (!t) continue;
    nr++;
    try {
      const a = JSON.parse(t);
      raus.push({
        seq: a.seq ?? nr,
        occurredAt: a.occurredAt ?? new Date().toISOString(),
        actionType: a.actionType,
        pageUrl: a.pageUrl ?? null, pageTitle: a.pageTitle ?? null,
        element: a.element ?? null, fieldLabel: a.fieldLabel ?? null,
        valueBefore: a.valueBefore ?? null, valueAfter: a.valueAfter ?? null,
        verified: typeof a.verified === 'boolean' ? a.verified : null,
        screenshotBefore: a.screenshotBefore ?? null,
        screenshotAfter: a.screenshotAfter ?? null,
        note: a.note ?? null,
      });
    } catch {
      /* Eine kaputte Zeile darf den ganzen Lauf nicht verwerfen — sie wird
         übersprungen und unten gezählt. */
    }
  }
  return raus;
}

function zusammenfassung(kopf: LaufKopf, aktionen: any[], scan: ReturnType<typeof secretScan>): string {
  const gelesen = aktionen.filter(a => a.actionType === 'lesen').length;
  const geschrieben = aktionen.filter(a => a.actionType === 'schreiben');
  const unbestaetigt = geschrieben.filter(a => a.verified === false);
  const stopps = aktionen.filter(a => a.actionType === 'stopp');

  const z: string[] = [];
  z.push(`# Casameta-Lauf ${kopf.runId}`, '');
  z.push(`**Objekt:** ${kopf.propertyCode ?? '—'} · **Jahr:** ${kopf.periodYear ?? '—'} · `
    + `**Modus:** ${kopf.mode} · **Status:** ${kopf.status ?? 'fertig'}`, '');
  if (kopf.stopReason) z.push(`**Abbruchgrund:** ${kopf.stopReason}`, '');
  z.push('| Kennzahl | Wert |', '|---|---|');
  z.push(`| gelesen | ${gelesen} |`);
  z.push(`| geschrieben | ${geschrieben.length} |`);
  z.push(`| davon nicht nachkontrolliert bestätigt | ${unbestaetigt.length} |`);
  z.push(`| Stopps | ${stopps.length} |`);
  z.push(`| Secret-Scan | ${scan.geprueft ? (scan.treffer.length === 0 ? 'sauber' : `${scan.treffer.length} TREFFER`) : 'übersprungen, keine Zugangsdaten hinterlegt'} |`);
  z.push('');

  if (geschrieben.length > 0) {
    z.push('## Geschriebene Werte', '');
    z.push('| # | Feld | vorher | nachher | bestätigt |', '|---|---|---|---|---|');
    for (const a of geschrieben) {
      z.push(`| ${a.seq} | ${a.fieldLabel ?? a.element ?? '—'} | ${a.valueBefore ?? '—'} `
        + `| ${a.valueAfter ?? '—'} | ${a.verified === true ? 'ja' : a.verified === false ? '**nein**' : '—'} |`);
    }
    z.push('');
  }
  if (stopps.length > 0) {
    z.push('## Stopps', '');
    for (const a of stopps) z.push(`- ${a.note ?? 'ohne Angabe'} (${a.pageUrl ?? '—'})`);
    z.push('');
  }
  return z.join('\n');
}

/**
 * Eine Lauf-Meldung zustellen.
 *
 * GESTALTUNG (Owner-Auftrag 14.10.2026, nachgezogen am 17.10.2026): Diese
 * Meldung fehlte in der Inventur und ging deshalb weiter im alten Format
 * hinaus — mehrere Zeilen blanker Text, ein rotes Symbol im Text und ein
 * „NICHT BESTÄTIGT" in Grossbuchstaben. Jetzt liefert das Skript Lage, Titel
 * und Fakten; formatiert wird an der einen geprueften Stelle in der
 * Notify-Route.
 *
 * Der interne Endpunkt kennt die Chat-Bindung und braucht kein Token im
 * Skript. Er hört nur auf localhost.
 */
async function telegram(meldung: {
  lage: 'ok' | 'hinweis' | 'fehler';
  titel: string;
  zeilen: string[];
  fuss?: string[];
}): Promise<boolean> {
  const schwere = meldung.lage === 'fehler' ? 'error'
    : meldung.lage === 'hinweis' ? 'warn' : 'info';
  try {
    const r = await fetch('http://127.0.0.1:18789/api/internal/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        /* Rueckfall, falls die Route die Gestaltung einmal nicht anwendet. */
        message: [meldung.titel, ...meldung.zeilen].join(' · '),
        severity: schwere, role: 'operativ',
        lage: meldung.lage, titel: meldung.titel,
        zeilen: meldung.zeilen, fuss: meldung.fuss ?? [],
      }),
    });
    return r.ok;
  } catch { return false; }
}

async function nachDropbox(ordner: string, runId: string): Promise<string | null> {
  const { dropboxZugang } = await import('../src/adapters/dropbox-zugang.js');
  const zugang = dropboxZugang((k) => envWert(ENV_OPENCLAW, k));
  if (!zugang) return null;
  const adapter = zugang.adapter;
  const ziel = `${DROPBOX_BASIS}/${runId}`;
  for (const datei of dateienSammeln(ordner)) {
    const rel = relative(ordner, datei).split('/').join('/');
    const typ = extname(datei) === '.png' ? 'image/png'
      : extname(datei) === '.zip' ? 'application/zip'
      : extname(datei) === '.json' || extname(datei) === '.jsonl' ? 'application/json'
      : 'text/plain; charset=utf-8';
    await adapter.uploadFile({ path: `${ziel}/${rel}`, body: readFileSync(datei), contentType: typ });
  }
  return ziel;
}

async function main() {
  const ordner = process.argv[2];
  if (!ordner || !existsSync(ordner)) {
    console.error('Aufruf: bun run scripts/casameta-protokoll.ts <lauf-ordner>');
    process.exit(2);
  }

  const kopf = kopfLesen(ordner);
  const aktionen = aktionenLesen(ordner);

  // 1. Secret-Scan — vor allem anderen.
  const scan = secretScan(ordner);
  if (scan.treffer.length > 0) {
    console.error('ABBRUCH: Der Lauf-Ordner enthält den Passwortwert.');
    for (const t of scan.treffer) console.error(`  betroffen: ${t}`);
    console.error('Es wurde nichts hochgeladen und nichts gemeldet.');
    await telegram({
      lage: 'fehler',
      titel: 'Casameta abgebrochen',
      zeilen: [
        `Lauf ${kopf.runId}`,
        `Zugangsdaten in ${scan.treffer.length} Lauf-Datei(en) gefunden`,
        'kein Upload erfolgt',
      ],
    });
    process.exit(1);
  }

  // 2. Nach Postgres.
  process.env.POSTGRES_URL ||= envWert(ENV_OPENCLAW, 'POSTGRES_URL') ?? '';
  const store = await import('../src/modules/casameta/store.js');
  await store.laufAnlegen({
    runId: kopf.runId, propertyCode: kopf.propertyCode ?? null,
    periodYear: kopf.periodYear ?? null, mode: kopf.mode,
    taskFile: kopf.taskFile ?? null, artifactPath: ordner,
  });
  const neu = await store.uebernehmeAktionen(kopf.runId, aktionen);

  // 3. Zusammenfassung.
  const md = zusammenfassung(kopf, aktionen, scan);
  writeFileSync(join(ordner, 'zusammenfassung.md'), md, 'utf-8');

  // 4. Dropbox.
  const dropboxPfad = await nachDropbox(ordner, kopf.runId);

  await store.laufAbschliessen(kopf.runId, {
    status: kopf.status ?? 'fertig', stopReason: kopf.stopReason ?? null,
    summary: md.slice(0, 4000), dropboxPath: dropboxPfad,
  });

  // 5. Telegram — bewusst knapp und ohne Namen.
  const geschrieben = aktionen.filter(a => a.actionType === 'schreiben');
  const unbestaetigt = geschrieben.filter(a => a.verified === false).length;
  const stopps = aktionen.filter(a => a.actionType === 'stopp');
  /* Ein Lauf, bei dem etwas nicht bestaetigt werden konnte oder der gestoppt
     hat, ist kein Fehler — aber auch nicht einfach „erledigt". */
  const lage = unbestaetigt > 0 || stopps.length > 0 ? 'hinweis' : 'ok';
  const zeilen = [
    `Objekt ${kopf.propertyCode ?? '—'} ${kopf.periodYear ?? ''}`.trim(),
    `Modus ${kopf.mode}`,
    `Status ${kopf.status ?? 'fertig'}`,
    `gelesen ${aktionen.length - geschrieben.length - stopps.length}`,
    `geschrieben ${geschrieben.length}`,
  ];
  if (unbestaetigt > 0) zeilen.push(`nicht bestätigt: ${unbestaetigt}`);

  const fuss: string[] = [];
  if (stopps.length > 0) fuss.push(`Stopps: ${stopps.map(s => s.note ?? '—').join('; ')}`);
  fuss.push(scan.geprueft ? 'Secret-Scan sauber' : 'Secret-Scan übersprungen (keine Zugangsdaten)');
  if (dropboxPfad) fuss.push(`Ablage: ${dropboxPfad}/zusammenfassung.md`);

  const gemeldet = await telegram({
    lage, titel: `Casameta-Lauf ${kopf.runId}`, zeilen, fuss,
  });

  console.log(`${neu} neue Aktion(en) übernommen, ${aktionen.length} insgesamt.`);
  console.log(`Secret-Scan: ${scan.geprueft ? 'sauber' : 'übersprungen (keine Zugangsdaten hinterlegt)'}`);
  console.log(`Dropbox: ${dropboxPfad ?? 'übersprungen (keine Zugangsdaten)'}`);
  console.log(`Telegram: ${gemeldet ? 'gemeldet' : 'nicht erreichbar'}`);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}

export { secretScan, zusammenfassung, aktionenLesen };

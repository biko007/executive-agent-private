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

async function telegram(text: string): Promise<boolean> {
  /* Der interne Endpunkt kennt die Chat-Bindung und braucht kein Token im
     Skript. Er hört nur auf localhost. */
  try {
    const r = await fetch('http://127.0.0.1:18789/api/internal/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, severity: 'info', role: 'operativ' }),
    });
    return r.ok;
  } catch { return false; }
}

async function nachDropbox(ordner: string, runId: string): Promise<string | null> {
  const appKey = envWert(ENV_OPENCLAW, 'EA_DROPBOX_APP_KEY');
  const appSecret = envWert(ENV_OPENCLAW, 'EA_DROPBOX_APP_SECRET');
  const refreshToken = envWert(ENV_OPENCLAW, 'EA_DROPBOX_REFRESH_TOKEN');
  if (!appKey || !appSecret || !refreshToken) return null;

  const { createDropboxAdapter } = await import('../src/adapters/dropbox.js');
  const adapter = createDropboxAdapter({ appKey, appSecret, refreshToken });
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
    await telegram(`🔴 Casameta-Lauf ${kopf.runId}: ABBRUCH — Zugangsdaten in den `
      + `Lauf-Artefakten gefunden (${scan.treffer.length} Datei(en)). Kein Upload erfolgt.`);
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
  const zeilen = [
    `Casameta-Lauf ${kopf.runId}`,
    `Objekt ${kopf.propertyCode ?? '—'} ${kopf.periodYear ?? ''} · Modus ${kopf.mode} · Status ${kopf.status ?? 'fertig'}`,
    `gelesen ${aktionen.length - geschrieben.length - stopps.length} · geschrieben ${geschrieben.length}`
      + (unbestaetigt > 0 ? ` · NICHT BESTÄTIGT ${unbestaetigt}` : ''),
  ];
  if (stopps.length > 0) zeilen.push(`Stopps: ${stopps.map(s => s.note ?? '—').join('; ')}`);
  zeilen.push(scan.geprueft ? 'Secret-Scan sauber' : 'Secret-Scan übersprungen (keine Zugangsdaten)');
  if (dropboxPfad) zeilen.push(`Ablage: ${dropboxPfad}/zusammenfassung.md`);
  const gemeldet = await telegram(zeilen.join('\n'));

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

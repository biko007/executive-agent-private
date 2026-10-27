/**
 * neuheiten/bericht — die gemeinsame stuendliche Meldung fuer Mails und Dokumente.
 *
 * Owner-Anweisungen 27.10.2026, 10:26 (Mails) und 10:45 (Dokumentenablagen):
 * eine Telegram-Sammelmeldung und ein Report `report-neuheiten-stunde-*.md`,
 * nur wenn es in der Stunde relevante neue Mails ODER Dokumente gab. Je Zeile
 * eine Freigabezeile; ausgefuehrt wird nichts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { maskiere, type VorschlagCode } from '../mail-register/relevanz.js';

/** Eine Zeile der Meldung — Mail oder Dokument. */
export interface NeuheitZeile {
  /** `m-…` fuer Mails, `d-…` fuer Dokumente. */
  kennung: string;
  art: 'Mail' | 'Dok';
  datum: string;
  /** Postfach oder Ablage, kurz. */
  quelle: string;
  /** Absender (Mail) oder Ordner (Dokument). */
  von: string;
  /** Betreff oder Dateiname. */
  titel: string;
  vorschlag: VorschlagCode;
  text: string;
}

export const KATALOG_ZEILE = 'Katalog: a Beleg ablegen + Buchung · b Zählerstände/Fakten einarbeiten · '
  + 'c Antwort/Antwortentwurf · d Frist/Termin · e Reklamation/Widerspruch · f nur zur Kenntnis. '
  + 'Ein anderer Buchstabe in der Freigabe ersetzt den Vorschlag.';

export const zelle = (s: string) => maskiere(String(s ?? '')).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
export const datumKurz = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}. ${iso.slice(11, 16)}`;

const sortiert = (z: NeuheitZeile[]) => [...z].sort((a, b) => a.datum.localeCompare(b.datum));

export function tabelle(zeilen: NeuheitZeile[]): string[] {
  const kopf = zeilen[0]?.art === 'Dok'
    ? ['| Kennung | Geändert (UTC) | Ablage | Ordner | Datei | Vorschlag |']
    : ['| Kennung | Datum (UTC) | Postfach | Absender | Betreff | Vorschlag |'];
  const z = [...kopf, '|---|---|---|---|---|---|'];
  for (const v of sortiert(zeilen)) {
    z.push(`| \`${v.kennung}\` | ${datumKurz(v.datum)} | ${zelle(v.quelle)} | ${zelle(v.von).slice(0, 70)} `
      + `| ${zelle(v.titel).slice(0, 90)} | ${v.text} |`);
  }
  return z;
}

/** `Freigabe Mail m-… a` bzw. `Freigabe Dok d-… a`. */
export function freigabeZeilen(zeilen: NeuheitZeile[]): string[] {
  return sortiert(zeilen).map((v) =>
    `- \`Freigabe ${v.art} ${v.kennung} ${v.vorschlag === 'offen' ? '<a–f>' : v.vorschlag}\``);
}

export function stundenReport(
  p: { mails: NeuheitZeile[]; dokumente: NeuheitZeile[]; jetzt: Date; fehler: string[] },
): string {
  const z: string[] = [
    `# Neuheiten ${p.jetzt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `**${p.mails.length} relevante Mail(s), ${p.dokumente.length} relevante(s) Dokument(e).** `
      + 'Nichts wurde ausgeführt; jeder Vorschlag wartet auf Ihre Freigabe.',
    '',
  ];
  for (const [titel, zeilen] of [['Mails', p.mails], ['Dokumente', p.dokumente]] as const) {
    z.push(`## ${titel}`, '');
    if (!zeilen.length) { z.push('keine', ''); continue; }
    z.push(...tabelle(zeilen), '', ...freigabeZeilen(zeilen), '');
  }
  z.push(KATALOG_ZEILE, '');
  if (p.fehler.length) z.push('## Hinweis', '', ...p.fehler.map((f) => `- ${f}`), '');
  z.push('Postfächer und Ablagen nur gelesen (kein Lesevermerk, nichts verschoben). '
    + 'Regelwerk: `artifacts/personal/mail-register/relevanz.json`.', '');
  return z.join('\n');
}

/** Kurzmeldung an den Owner-DM; hoechstens 12 Zeilen. */
export async function melde(
  p: { mails: NeuheitZeile[]; dokumente: NeuheitZeile[]; reportName: string; hochgeladen: boolean; hinweise?: string[] },
  senden: (body: unknown) => Promise<{ ok: boolean; status: number }> = async (body) => {
    const r = await fetch('http://127.0.0.1:18789/api/internal/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    return { ok: r.ok, status: r.status };
  },
): Promise<void> {
  const alle = [...sortiert(p.mails), ...sortiert(p.dokumente)];
  const zeilen = alle.slice(0, 12).map((v) =>
    `${v.art === 'Mail' ? '✉' : '📄'} ${zelle(v.von).slice(0, 30)}: ${zelle(v.titel).slice(0, 50)} → ${v.text}`);
  if (alle.length > 12) zeilen.push(`… und ${alle.length - 12} weitere`);
  /* Fruehwarnungen (iCloud-Spiegel) stehen vorn — sie sind der Anlass, wenn sonst nichts neu ist. */
  zeilen.unshift(...(p.hinweise ?? []).map((h) => `⚠ ${h}`));
  const titel = `Neu: ${p.mails.length} Mail(s), ${p.dokumente.length} Dokument(e)`;
  const r = await senden({
    message: titel, severity: 'info', lage: 'hinweis', titel, zeilen,
    fuss: [p.hochgeladen ? `Report ${p.reportName} (Dropbox)` : `Report ${p.reportName} nur lokal (Dropbox-Upload fehlgeschlagen)`,
      'Freigabe: Freigabe Mail|Dok <Kennung> <a–f>'],
  });
  if (!r.ok) throw new Error(`notify ${r.status}`);
}

// ── Hilfen fuer Zustand ────────────────────────────────────────────────────

export function ladeJson<T>(p: string, leer: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return leer; }
}

export function schreibeJson(p: string, wert: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(wert, null, 1), 'utf-8');
  fs.renameSync(tmp, p);
}

/**
 * Sperrdatei gegen gleichzeitige Laeufe. Eine Sperre, deren Prozess nicht
 * mehr lebt, wird uebernommen. Liefert die Freigabe oder null.
 */
export function sperre(pfad: string): (() => void) | null {
  fs.mkdirSync(path.dirname(pfad), { recursive: true });
  for (let versuch = 0; versuch < 2; versuch++) {
    try {
      fs.writeFileSync(pfad, String(process.pid), { flag: 'wx' });
      return () => { try { fs.unlinkSync(pfad); } catch { /* schon weg */ } };
    } catch {
      let pid = 0;
      try { pid = Number(fs.readFileSync(pfad, 'utf-8').trim()); } catch { /* weg */ }
      let lebt = false;
      try { if (pid) { process.kill(pid, 0); lebt = true; } } catch { /* tot */ }
      if (lebt) return null;
      try { fs.unlinkSync(pfad); } catch { /* egal */ }
    }
  }
  return null;
}

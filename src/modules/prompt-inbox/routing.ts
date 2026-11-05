/**
 * Session-Routing der Prompt-Inbox nach Dateipräfix
 * (Spec Cowork-Platform §13.1, Owner-Freigabe 05.11.2026).
 *
 * Dateinamen nach dem Schema `JJJJMMTT-HHMM-<präfix>-<thema>.txt`, auch hinter
 * den Transportvorsätzen (Zeitstempel des Pollers, `dropbox-<stempel>-`,
 * `auftrag-mail-<stempel>-`). Das Präfix entscheidet über die tmux-Sitzung:
 *
 *   ~/.config/openclaw/inbox-sessions.conf, eine Regel je Zeile
 *     <präfix>=<sitzung>:<arbeitsverzeichnis>
 *   z. B. design=design:~/.openclaw/workspace/.openclaw/extensions/executive-dashboard
 *
 * Ohne Treffer bleibt alles wie bisher: Sitzung bikosoc. Die Datei enthält
 * keine Geheimnisse — die Anmeldung setzt das Startskript.
 *
 * Eine ungültige Zeile wird übersprungen und gemeldet, nie ein Absturz: Ein
 * Tippfehler in der Konfiguration darf die Inbox nicht anhalten.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SITZUNGSNAME } from '../cc-prompt-dispatch/index.js';

export interface SitzungsRegel {
  praefix: string;
  sitzung: string;
  verzeichnis: string;
}

export interface RoutingTabelle {
  regeln: Map<string, SitzungsRegel>;
  /** Übersprungene Zeilen mit Zeilennummer und Grund — fürs Protokoll. */
  fehler: { zeile: number; grund: string }[];
}

/** Die Sitzung, in die ohne Regel zugestellt wird (bisheriges Verhalten). */
export const STANDARD_SITZUNG = 'bikosoc';

const PRAEFIX = /^[a-z0-9]{2,20}$/;

export function routingPfad(homeDir: string): string {
  return path.join(homeDir, '.config', 'openclaw', 'inbox-sessions.conf');
}

/** Konfiguration lesen. Fehlende Datei = keine Regeln. */
export function ladeRouting(homeDir: string, pfad = routingPfad(homeDir)): RoutingTabelle {
  let text = '';
  try { text = fs.readFileSync(pfad, 'utf-8'); } catch { /* keine Datei: keine Regeln */ }
  return parseRouting(text, homeDir);
}

export function parseRouting(text: string, homeDir: string): RoutingTabelle {
  const regeln = new Map<string, SitzungsRegel>();
  const fehler: { zeile: number; grund: string }[] = [];
  text.split('\n').forEach((roh, i) => {
    const zeile = roh.trim();
    if (!zeile || zeile.startsWith('#')) return;
    const nr = i + 1;
    const gleich = zeile.indexOf('=');
    if (gleich < 0) { fehler.push({ zeile: nr, grund: 'kein =' }); return; }
    const praefix = zeile.slice(0, gleich).trim();
    const rest = zeile.slice(gleich + 1).trim();
    const doppel = rest.indexOf(':');
    if (doppel < 0) { fehler.push({ zeile: nr, grund: 'kein : zwischen Sitzung und Verzeichnis' }); return; }
    const sitzung = rest.slice(0, doppel).trim();
    let verzeichnis = rest.slice(doppel + 1).trim();
    if (!PRAEFIX.test(praefix)) { fehler.push({ zeile: nr, grund: `ungültiges Präfix „${praefix}"` }); return; }
    if (!SITZUNGSNAME.test(sitzung)) { fehler.push({ zeile: nr, grund: `ungültiger Sitzungsname „${sitzung}"` }); return; }
    if (verzeichnis === '~') verzeichnis = homeDir;
    else if (verzeichnis.startsWith('~/')) verzeichnis = path.join(homeDir, verzeichnis.slice(2));
    if (!path.isAbsolute(verzeichnis)) { fehler.push({ zeile: nr, grund: 'Verzeichnis nicht absolut' }); return; }
    if (regeln.has(praefix)) { fehler.push({ zeile: nr, grund: `Präfix „${praefix}" doppelt — erste Regel gilt` }); return; }
    regeln.set(praefix, { praefix, sitzung, verzeichnis: path.normalize(verzeichnis) });
  });
  return { regeln, fehler };
}

/**
 * Das Routing-Präfix eines Dateinamens, oder null, wenn der Name nicht dem
 * Schema folgt. Transportvorsätze werden wie in `auftragsKennung` entfernt.
 */
export function routingPraefix(dateiname: string): string | null {
  let name = dateiname;
  name = name.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, '');
  name = name.replace(/^dropbox-(\d{8}-\d{6}-)?/, '');
  name = name.replace(/^auftrag-mail-\d{8}-\d{4}-/, '');
  const m = name.match(/^\d{8}-\d{4}-([a-z0-9]+)-[^/]+\.txt$/);
  return m ? m[1] : null;
}

/** Die Regel für eine Datei, oder null für die Standardsitzung bikosoc. */
export function regelFuer(dateiname: string, tabelle: RoutingTabelle): SitzungsRegel | null {
  const praefix = routingPraefix(dateiname);
  if (!praefix) return null;
  const regel = tabelle.regeln.get(praefix);
  // Eine Regel auf bikosoc selbst ist der Normalweg — kein eigener Kanal.
  if (!regel || regel.sitzung === STANDARD_SITZUNG) return null;
  return regel;
}

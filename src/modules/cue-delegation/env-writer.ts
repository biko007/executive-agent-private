/**
 * cue-delegation/env-writer — chirurgischer Schreiber fuer ~/.config/openclaw/env.
 *
 * Die Datei haelt alle Secrets des Systems. Dieser Schreiber darf deshalb
 * **ausschliesslich** die drei Cue-Schluessel veraendern; jeder andere
 * Schluessel wird abgewiesen (Whitelist, technisch erzwungen — nicht per
 * Disziplin). Alles andere in der Datei bleibt byte-identisch: Kommentare,
 * Leerzeilen, Reihenfolge und Zeilenende-Stil.
 *
 * `rewriteCueEnv` ist rein (String → String) und damit ohne echte Datei
 * pruefbar. `writeCueEnv` legt vorher eine Sicherung an und schreibt atomar
 * ueber eine Temp-Datei plus `rename`, damit ein Abbruch mitten im Schreiben
 * die Secret-Datei nicht halbfertig zuruecklaesst.
 */
import fs from 'node:fs';
import { cueEnvPath } from './config.js';

/** Die einzigen Schluessel, die dieser Schreiber anfassen darf. */
export const CUE_ENV_KEYS = ['CUE_DELEGATION_ENABLED', 'MANUS_API_KEY', 'MANUS_CUE_AGENT_ID'] as const;
export type CueEnvKey = (typeof CUE_ENV_KEYS)[number];

/** Zeitstempel fuer den Sicherungsnamen: 20261008-080312 (Europe/Berlin). */
export function backupStamp(now: Date): string {
  const teile = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const v = (t: string) => teile.find((p) => p.type === t)?.value ?? '00';
  return `${v('year')}${v('month')}${v('day')}-${v('hour')}${v('minute')}${v('second')}`;
}

/**
 * Die genannten Schluessel im Dateiinhalt ersetzen und den Rest unberuehrt
 * lassen.
 *
 * Es werden **alle** Zeilen eines Schluessels ersetzt, nicht nur die erste:
 * bei einem systemd-`EnvironmentFile` gewinnt die letzte Zeile, ein
 * stehengelassener Zweitwert wuerde den neuen also aushebeln. Fehlt ein
 * Schluessel ganz, wird er am Ende angefuegt.
 */
export function rewriteCueEnv(content: string, updates: Record<string, string>): string {
  const erlaubt: readonly string[] = CUE_ENV_KEYS;

  for (const [key, value] of Object.entries(updates)) {
    if (!erlaubt.includes(key)) {
      throw new Error(`env_key_not_allowed:${key}`);
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`env_value_has_newline:${key}`);
    }
  }

  let out = content;
  for (const [key, value] of Object.entries(updates)) {
    const zeile = `${key}=${value}`;
    // [^\r\n]* statt .* — ein vorhandenes \r bleibt als Gruppe erhalten,
    // damit der Zeilenende-Stil der Datei unveraendert bleibt.
    const muster = new RegExp(`^${key}=[^\\r\\n]*(\\r?)$`, 'gm');
    if (muster.test(out)) {
      muster.lastIndex = 0;
      out = out.replace(muster, (_treffer, cr: string) => `${zeile}${cr}`);
    } else {
      if (out.length > 0 && !out.endsWith('\n')) out += '\n';
      out += `${zeile}\n`;
    }
  }
  return out;
}

export interface WriteCueEnvResult {
  envPath: string;
  /** Pfad der Sicherung, oder null wenn bewusst keine angelegt wurde. */
  backupPath: string | null;
}

export interface WriteCueEnvOptions {
  envPath?: string;
  now?: Date;
  /** Keine Sicherung anlegen — fuer den zweiten Schreibvorgang desselben Laufs. */
  skipBackup?: boolean;
}

/**
 * Die Cue-Schluessel in die env-Datei schreiben.
 * Die Datei muss existieren — sie wird nie neu angelegt, damit ein falscher
 * Pfad nicht still eine zweite, leere Secret-Datei erzeugt.
 */
export function writeCueEnv(
  updates: Record<string, string>,
  opts: WriteCueEnvOptions = {},
): WriteCueEnvResult {
  const envPath = opts.envPath ?? cueEnvPath();
  const original = fs.readFileSync(envPath, 'utf-8');
  const modus = fs.statSync(envPath).mode & 0o777;

  let backupPath: string | null = null;
  if (!opts.skipBackup) {
    backupPath = `${envPath}.bak-cuesetup-${backupStamp(opts.now ?? new Date())}`;
    fs.writeFileSync(backupPath, original, { mode: modus });
  }

  const neu = rewriteCueEnv(original, updates);
  const temp = `${envPath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, neu, { mode: modus });
  fs.renameSync(temp, envPath);

  return { envPath, backupPath };
}

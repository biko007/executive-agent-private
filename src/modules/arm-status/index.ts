/**
 * arm-status — braucht Claude Code eine Armierung, ohne es versucht zu haben?
 *
 * Dieses Modul sammelt die Tatsachen: Git-Zustand und `schema_version`. Die
 * Bewertung selbst liegt in `muster.ts` als reine Funktionen — dort sind auch
 * die Fehlalarm-Fälle geprüft.
 *
 * Es liegt bewusst NICHT in der Prompt-Inbox: Ein statischer Guard verbietet
 * ihr jeden eigenen Unterprozess, damit aller tmux-Zugriff an einer Stelle
 * bleibt. Git-Aufrufe gehören nach derselben Logik hierher.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  lesePfadMuster, istRoterPfad, offeneMigrationen, fasseArmBedarf,
  type ArmBedarf, type MigrationsDatei,
} from './muster.js';

export {
  lesePfadMuster, istRoterPfad, offeneMigrationen, fasseArmBedarf, zerlegeMigration,
} from './muster.js';
export type { ArmBedarf, MigrationsDatei } from './muster.js';

/** Die Repositorien, in denen rote Pfade liegen können. */
const REPOS = [
  '.openclaw/workspace/.openclaw/extensions/executive-agent',
  '.openclaw/workspace/.openclaw/extensions/executive-dashboard',
];

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repo, ...args],
      { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * Dateien in Commits, die noch nicht auf `origin` liegen.
 *
 * `@{upstream}..HEAD` ist der richtige Bereich: Er beschreibt genau, was ein
 * Push übertragen würde. Fehlt der Upstream, gibt git nichts zurück und die
 * Prüfung schweigt — besser als zu raten.
 */
export function ungepushteDateien(repoPfad: string): string[] {
  const roh = git(repoPfad, ['diff', '--name-only', '@{upstream}..HEAD']);
  return roh.split('\n').map(z => z.trim()).filter(Boolean);
}

/**
 * Prüft beide Tatsachen und liefert das Ergebnis.
 *
 * `dbAbfrage` wird hereingegeben, damit das Modul keine Datenbankabhängigkeit
 * mitschleppt und in Tests ohne Datenbank läuft.
 */
export async function pruefeArmBedarf(opts: {
  homeDir?: string;
  dbAbfrage?: (sql: string) => Promise<{ modul: string; version: number }[]>;
  /** Nur für Tests: vorgegebene Dateilisten je Repo. */
  ungepusht?: Record<string, string[]>;
  /** Nur für Tests: Inhalt der red-zone.conf. */
  konfig?: string;
  /** Nur für Tests: vorhandene Migrationsdateien. */
  migrationsDateien?: string[];
} = {}): Promise<ArmBedarf> {
  const homeDir = opts.homeDir ?? homedir();

  const konfigPfad = join(homeDir, '.config', 'openclaw', 'red-zone.conf');
  const konfig = opts.konfig
    ?? (existsSync(konfigPfad) ? readFileSync(konfigPfad, 'utf-8') : '');
  const muster = lesePfadMuster(konfig);
  if (muster.length === 0) return { wartet: false };

  // ── 1. Ungepushte rote Pfade ─────────────────────────────────────────────
  const rotePfadeUngepusht: { pfad: string; muster: string }[] = [];
  for (const rel of REPOS) {
    const repo = join(homeDir, rel);
    const dateien = opts.ungepusht ? (opts.ungepusht[rel] || []) : ungepushteDateien(repo);
    for (const d of dateien) {
      const treffer = istRoterPfad(d, muster);
      if (treffer) rotePfadeUngepusht.push({ pfad: d, muster: treffer });
    }
  }

  // ── 2. Migrationsdateien ohne Eintrag in schema_version ──────────────────
  let offen: MigrationsDatei[] = [];
  const dateien = opts.migrationsDateien ?? migrationsDateienSuchen(homeDir);
  if (dateien.length > 0 && opts.dbAbfrage) {
    try {
      const zeilen = await opts.dbAbfrage(
        'SELECT module AS modul, version FROM schema_version');
      const angewendet = new Set(zeilen.map(z => `${z.modul}:${z.version}`));
      offen = offeneMigrationen(dateien, angewendet);
    } catch {
      // Ohne Datenbank keine Aussage — schweigen statt raten.
      offen = [];
    }
  }

  return fasseArmBedarf({ rotePfadeUngepusht, offeneMigrationen: offen });
}

/** Alle versionierten Migrationsdateien im Agent-Repo, als Repo-relative Pfade. */
function migrationsDateienSuchen(homeDir: string): string[] {
  const repo = join(homeDir, REPOS[0]);
  const roh = git(repo, ['ls-files', 'src/**/migrations/V*.sql']);
  return roh.split('\n').map(z => z.trim()).filter(Boolean);
}

/**
 * cue-delegation — Laufzeit-Lesen der env-Datei und der Nachrichten-ID-Speicher.
 *
 * Hintergrund: /cue_setup soll ohne Gateway-Restart wirken. Dafuer muss die
 * **Datei** Vorrang vor `process.env` haben — `readEnvKey()` aus shared/utils
 * macht es umgekehrt und taugt hier nicht. Diese Tests sichern genau das ab.
 *
 * Es wird nur gegen Temp-Dateien gelesen, nie gegen die echte env.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cueEnvPath, parseEnvFile, readCueEnvFile, resetCueEnvCache, loadCueConfig, cueStatus,
} from '../config.js';
import {
  lastInboundMessageId, noteInboundMessageId, resetInboundStore, stripCommandPrefix,
} from '../commands.js';

const verzeichnisse: string[] = [];

function tempHome(inhalt: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-home-'));
  fs.mkdirSync(path.join(home, '.config/openclaw'), { recursive: true });
  fs.writeFileSync(cueEnvPath(home), inhalt, { mode: 0o600 });
  verzeichnisse.push(home);
  return home;
}

afterEach(() => {
  resetCueEnvCache();
  resetInboundStore();
  while (verzeichnisse.length) {
    fs.rmSync(verzeichnisse.pop()!, { recursive: true, force: true });
  }
});

describe('parseEnvFile', () => {
  test('liest KEY=VALUE und ueberspringt Kommentare und Leerzeilen', () => {
    const werte = parseEnvFile([
      '# Kommentar',
      '',
      'A=1',
      'B = zwei ',
      'ohne-gleichheitszeichen',
      '=leerer-key',
    ].join('\n'));
    expect(werte).toEqual({ A: '1', B: 'zwei' });
  });

  test('streift export-Prefix und Anfuehrungszeichen ab', () => {
    const werte = parseEnvFile(['export A=1', 'B="zwei"', "C='drei'"].join('\n'));
    expect(werte).toEqual({ A: '1', B: 'zwei', C: 'drei' });
  });

  test('ein Wert mit Gleichheitszeichen bleibt vollstaendig', () => {
    expect(parseEnvFile('POSTGRES_URL=postgres://u:p@h/db?x=1').POSTGRES_URL)
      .toBe('postgres://u:p@h/db?x=1');
  });
});

describe('readCueEnvFile', () => {
  test('liest die Datei des angegebenen Pfades', () => {
    const home = tempHome('MANUS_API_KEY=sk-aus-datei\n');
    expect(readCueEnvFile({ envPath: cueEnvPath(home) }).MANUS_API_KEY).toBe('sk-aus-datei');
  });

  test('eine fehlende Datei gilt als leer, nicht als Fehler', () => {
    expect(readCueEnvFile({ envPath: '/nicht/vorhanden/env' })).toEqual({});
  });
});

describe('loadCueConfig', () => {
  test('uebergebenes env hat Vorrang und liest keine Datei', () => {
    const cfg = loadCueConfig({
      CUE_DELEGATION_ENABLED: 'true', MANUS_API_KEY: 'k-injiziert', MANUS_CUE_AGENT_ID: 'a1',
    } as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe('k-injiziert');
    expect(cueStatus(cfg).ready).toBe(true);
  });

  test('ohne Argument gewinnt die Datei gegen process.env', () => {
    // Genau der Fall nach /cue_setup: process.env traegt noch den Startwert
    // CHANGEME, die Datei den echten Key. Ohne Dateivorrang waere ein
    // Gateway-Restart noetig.
    const home = tempHome([
      'CUE_DELEGATION_ENABLED=true',
      'MANUS_API_KEY=sk-aus-datei-0123456789',
      'MANUS_CUE_AGENT_ID=agent-aus-datei',
    ].join('\n'));

    const sicherung = { ...process.env };
    try {
      process.env.HOME = home;
      process.env.CUE_DELEGATION_ENABLED = 'false';
      process.env.MANUS_API_KEY = 'CHANGEME';
      process.env.MANUS_CUE_AGENT_ID = 'CHANGEME';
      resetCueEnvCache();

      const cfg = loadCueConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.apiKey).toBe('sk-aus-datei-0123456789');
      expect(cfg.agentId).toBe('agent-aus-datei');
      expect(cueStatus(cfg).ready).toBe(true);
    } finally {
      process.env = sicherung;
      resetCueEnvCache();
    }
  });

  test('fehlt ein Schluessel in der Datei, gilt process.env als Rueckfall', () => {
    const home = tempHome('CUE_DELEGATION_ENABLED=true\n');
    const sicherung = { ...process.env };
    try {
      process.env.HOME = home;
      process.env.MANUS_API_KEY = 'sk-aus-prozess-0123456789';
      process.env.MANUS_CUE_AGENT_ID = 'agent-aus-prozess';
      resetCueEnvCache();

      const cfg = loadCueConfig();
      expect(cfg.apiKey).toBe('sk-aus-prozess-0123456789');
      expect(cfg.agentId).toBe('agent-aus-prozess');
    } finally {
      process.env = sicherung;
      resetCueEnvCache();
    }
  });
});

describe('Nachrichten-ID-Speicher', () => {
  test('merkt die letzte Nachrichten-ID je Chat', () => {
    noteInboundMessageId('chat-1', '111', 1_000);
    noteInboundMessageId('chat-2', '222', 1_000);
    noteInboundMessageId('chat-1', '333', 2_000);
    expect(lastInboundMessageId('chat-1', 2_000)).toBe('333');
    expect(lastInboundMessageId('chat-2', 2_000)).toBe('222');
    expect(lastInboundMessageId('chat-3', 2_000)).toBeUndefined();
  });

  test('ein alter Eintrag gilt nicht mehr', () => {
    noteInboundMessageId('chat-1', '111', 1_000);
    expect(lastInboundMessageId('chat-1', 1_000 + 3 * 60_000)).toBeUndefined();
  });

  test('leere Angaben werden ignoriert', () => {
    noteInboundMessageId('', '111', 1_000);
    noteInboundMessageId('chat-1', '', 1_000);
    expect(lastInboundMessageId('chat-1', 1_000)).toBeUndefined();
  });

  test('der Speicher waechst nicht unbegrenzt', () => {
    for (let i = 0; i < 50; i++) noteInboundMessageId(`chat-${i}`, String(i), 1_000);
    // Deckel 20 — der jeweils neueste Eintrag bleibt in jedem Fall erhalten.
    expect(lastInboundMessageId('chat-49', 1_000)).toBe('49');
    expect(lastInboundMessageId('chat-0', 1_000)).toBeUndefined();
  });
});

describe('stripCommandPrefix', () => {
  test('entfernt ein fuehrendes Befehlswort, falls der Host es mitliefert', () => {
    // Live-Befund 08.10.2026, 09:13: in ctx.args stand der komplette
    // Nachrichtentext einschliesslich "/cue ".
    expect(stripCommandPrefix('/cue Recherchiere drei Quellen')).toBe('Recherchiere drei Quellen');
    expect(stripCommandPrefix('  /CUE   Text  ')).toBe('Text');
    expect(stripCommandPrefix('/cue_setup sk-abcdefghijklmnop')).toBe('sk-abcdefghijklmnop');
    expect(stripCommandPrefix('/cue-setup sk-abcdefghijklmnop')).toBe('sk-abcdefghijklmnop');
    expect(stripCommandPrefix('/cue')).toBe('');
  });

  test('laesst normalen Text unberuehrt', () => {
    expect(stripCommandPrefix('Recherchiere drei Quellen')).toBe('Recherchiere drei Quellen');
    // Kein Teilwort-Treffer: /cuesetup ist ein anderer Befehl.
    expect(stripCommandPrefix('/cuesetup abc')).toBe('/cuesetup abc');
    // Ein /cue mitten im Text bleibt stehen.
    expect(stripCommandPrefix('Erklaere mir /cue bitte')).toBe('Erklaere mir /cue bitte');
    // Nur das erste Befehlswort wird entfernt.
    expect(stripCommandPrefix('/cue /cue doppelt')).toBe('/cue doppelt');
  });
});

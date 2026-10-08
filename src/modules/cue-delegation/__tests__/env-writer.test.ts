/**
 * cue-delegation — env-Schreiber.
 *
 * Die echte ~/.config/openclaw/env wird hier **nie** angefasst: `rewriteCueEnv`
 * arbeitet auf einem String-Fixture, `writeCueEnv` auf einer Temp-Datei.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CUE_ENV_KEYS, rewriteCueEnv, writeCueEnv, backupStamp } from '../env-writer.js';

/** Realitaetsnaher Auszug: Secrets anderer Module, Kommentare, Leerzeilen. */
const FIXTURE = [
  '# Kommentarkopf',
  'OPENAI_API_KEY=sk-fremd-nicht-anfassen',
  '',
  '# Yahoo Mail',
  'YAHOO_USER=jemand@example.com',
  'YAHOO_IMAP_PORT=993',
  '',
  '# ── Manus-Cue-Delegation (Phase 1, experimentell) ──',
  '# Platzhalter CHANGEME = nicht konfiguriert',
  'CUE_DELEGATION_ENABLED=false',
  'MANUS_API_KEY=CHANGEME',
  'MANUS_CUE_AGENT_ID=CHANGEME',
  '',
].join('\n');

/** Alle Zeilen, die keinen der drei Cue-Schluessel tragen. */
function fremdeZeilen(text: string): string[] {
  const keys: readonly string[] = CUE_ENV_KEYS;
  return text.split('\n').filter((z) => !keys.some((k) => z.startsWith(`${k}=`)));
}

describe('rewriteCueEnv', () => {
  test('ersetzt die drei Schluessel und laesst den Rest byte-identisch', () => {
    const neu = rewriteCueEnv(FIXTURE, {
      MANUS_API_KEY: 'sk-neuer-key-1234567890',
      CUE_DELEGATION_ENABLED: 'true',
      MANUS_CUE_AGENT_ID: 'agent-abc',
    });

    expect(neu).toContain('MANUS_API_KEY=sk-neuer-key-1234567890');
    expect(neu).toContain('CUE_DELEGATION_ENABLED=true');
    expect(neu).toContain('MANUS_CUE_AGENT_ID=agent-abc');
    // Kein Platzhalter bleibt als *Wert* stehen — der Kommentar, der das Wort
    // erklaert, muss dagegen unveraendert erhalten bleiben.
    expect(neu.split('\n').filter((z) => /=CHANGEME$/.test(z))).toEqual([]);
    expect(neu).toContain('# Platzhalter CHANGEME = nicht konfiguriert');

    // Jede andere Zeile steht unveraendert und in derselben Reihenfolge da.
    expect(fremdeZeilen(neu)).toEqual(fremdeZeilen(FIXTURE));
    // Fremde Secrets bleiben wortgleich erhalten.
    expect(neu).toContain('OPENAI_API_KEY=sk-fremd-nicht-anfassen');
    expect(neu).toContain('YAHOO_IMAP_PORT=993');
    // Zeilenzahl aendert sich nicht, weil alle Schluessel bereits vorhanden waren.
    expect(neu.split('\n').length).toBe(FIXTURE.split('\n').length);
  });

  test('ein einzelner Schluessel laesst die beiden anderen unberuehrt', () => {
    const neu = rewriteCueEnv(FIXTURE, { MANUS_CUE_AGENT_ID: 'agent-xyz' });
    expect(neu).toContain('MANUS_CUE_AGENT_ID=agent-xyz');
    expect(neu).toContain('MANUS_API_KEY=CHANGEME');
    expect(neu).toContain('CUE_DELEGATION_ENABLED=false');
  });

  test('fehlender Schluessel wird am Ende angefuegt', () => {
    const ohne = 'OPENAI_API_KEY=sk-fremd\n';
    const neu = rewriteCueEnv(ohne, { MANUS_API_KEY: 'sk-abcdefghijklmnop' });
    expect(neu).toBe('OPENAI_API_KEY=sk-fremd\nMANUS_API_KEY=sk-abcdefghijklmnop\n');
  });

  test('fehlendes Zeilenende am Dateischluss wird ergaenzt', () => {
    const neu = rewriteCueEnv('A=1', { MANUS_API_KEY: 'sk-abcdefghijklmnop' });
    expect(neu).toBe('A=1\nMANUS_API_KEY=sk-abcdefghijklmnop\n');
  });

  test('doppelte Zeilen eines Schluessels werden beide ersetzt', () => {
    // Bei EnvironmentFile gewinnt die letzte Zeile — ein stehengelassener
    // Zweitwert wuerde den neuen aushebeln.
    const doppelt = 'MANUS_API_KEY=alt1\nB=2\nMANUS_API_KEY=alt2\n';
    const neu = rewriteCueEnv(doppelt, { MANUS_API_KEY: 'neu' });
    expect(neu).toBe('MANUS_API_KEY=neu\nB=2\nMANUS_API_KEY=neu\n');
  });

  test('CRLF-Zeilenenden bleiben erhalten', () => {
    const crlf = 'A=1\r\nMANUS_API_KEY=alt\r\nB=2\r\n';
    const neu = rewriteCueEnv(crlf, { MANUS_API_KEY: 'neu' });
    expect(neu).toBe('A=1\r\nMANUS_API_KEY=neu\r\nB=2\r\n');
  });

  test('ein fremder Schluessel wird abgewiesen', () => {
    expect(() => rewriteCueEnv(FIXTURE, { OPENAI_API_KEY: 'boese' })).toThrow('env_key_not_allowed:OPENAI_API_KEY');
    expect(() => rewriteCueEnv(FIXTURE, { POSTGRES_URL: 'boese' })).toThrow('env_key_not_allowed:POSTGRES_URL');
  });

  test('ein Wert mit Zeilenumbruch wird abgewiesen', () => {
    expect(() => rewriteCueEnv(FIXTURE, { MANUS_API_KEY: 'a\nPOSTGRES_URL=boese' }))
      .toThrow('env_value_has_newline:MANUS_API_KEY');
    expect(() => rewriteCueEnv(FIXTURE, { MANUS_API_KEY: 'a\rb' }))
      .toThrow('env_value_has_newline:MANUS_API_KEY');
  });

  test('Sonderzeichen im Wert werden nicht als Regex gedeutet', () => {
    const neu = rewriteCueEnv(FIXTURE, { MANUS_API_KEY: 'sk-$1-&-\\x-abcdef' });
    expect(neu).toContain('MANUS_API_KEY=sk-$1-&-\\x-abcdef');
  });
});

describe('writeCueEnv (Temp-Datei)', () => {
  const angelegt: string[] = [];

  function tempEnv(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-env-'));
    const p = path.join(dir, 'env');
    fs.writeFileSync(p, FIXTURE, { mode: 0o600 });
    angelegt.push(dir);
    return p;
  }

  afterEach(() => {
    while (angelegt.length) {
      const dir = angelegt.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('schreibt die Werte, legt eine Sicherung an und haelt Modus 0600', () => {
    const envPath = tempEnv();
    const res = writeCueEnv(
      { MANUS_API_KEY: 'sk-abcdefghijklmnop', CUE_DELEGATION_ENABLED: 'true' },
      { envPath, now: new Date('2026-10-08T06:03:12Z') },
    );

    expect(res.envPath).toBe(envPath);
    expect(res.backupPath).toBe(`${envPath}.bak-cuesetup-20261008-080312`);
    expect(fs.readFileSync(res.backupPath!, 'utf-8')).toBe(FIXTURE);

    const inhalt = fs.readFileSync(envPath, 'utf-8');
    expect(inhalt).toContain('MANUS_API_KEY=sk-abcdefghijklmnop');
    expect(inhalt).toContain('CUE_DELEGATION_ENABLED=true');
    expect(inhalt).toContain('OPENAI_API_KEY=sk-fremd-nicht-anfassen');
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(res.backupPath!).mode & 0o777).toBe(0o600);
  });

  test('skipBackup legt keine zweite Sicherung an', () => {
    const envPath = tempEnv();
    const res = writeCueEnv({ MANUS_CUE_AGENT_ID: 'agent-1' }, { envPath, skipBackup: true });
    expect(res.backupPath).toBeNull();
    expect(fs.readdirSync(path.dirname(envPath))).toEqual(['env']);
    expect(fs.readFileSync(envPath, 'utf-8')).toContain('MANUS_CUE_AGENT_ID=agent-1');
  });

  test('hinterlaesst keine Temp-Datei', () => {
    const envPath = tempEnv();
    writeCueEnv({ MANUS_CUE_AGENT_ID: 'agent-1' }, { envPath, skipBackup: true });
    expect(fs.readdirSync(path.dirname(envPath)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  test('eine nicht vorhandene env-Datei wird nicht neu angelegt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-env-'));
    angelegt.push(dir);
    const fehlt = path.join(dir, 'env');
    expect(() => writeCueEnv({ MANUS_API_KEY: 'sk-abcdefghijklmnop' }, { envPath: fehlt })).toThrow();
    expect(fs.existsSync(fehlt)).toBe(false);
  });

  test('backupStamp liefert Berliner Zeit', () => {
    expect(backupStamp(new Date('2026-10-08T06:03:12Z'))).toBe('20261008-080312');
    // Winterzeit: UTC+1
    expect(backupStamp(new Date('2026-01-15T06:03:12Z'))).toBe('20260115-070312');
  });
});

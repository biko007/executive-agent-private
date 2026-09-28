/**
 * Tests für das Einlesen der Nuveon-Zugangsdaten.
 *
 * Kern der Zusicherung: ein Passwort, das `printf %q` shell-zitiert hat, kommt
 * **zeichengleich** zurück. Genau hier lag die Falle — ein Parser, der nur
 * umschließende Anführungszeichen abstreift, liefert für `geh\!eim` den String
 * `geh\!eim` statt `geh!eim`. Der Login scheitert dann mit richtigem Passwort,
 * und der Import stoppt nach zwei Versuchen.
 *
 * Die Testdateien werden mit demselben zsh-/bash-`printf %q` erzeugt, das der
 * Owner-Einzeiler auf dem Mac verwendet — nicht mit einer Nachbildung.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readNuveonCredentials } from '../nuveon-credentials.js';

const workDir = mkdtempSync(join(tmpdir(), 'wiki-creds-test-'));
let fileCounter = 0;

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Env-Datei so schreiben, wie der Owner-Einzeiler es tut: mit `printf %q`.
 * Die Werte gehen über argv an bash; das ist im Test unkritisch.
 */
function writeCredFileViaPrintfQ(user: string, pass: string): string {
  const path = join(workDir, `cred-${fileCounter++}.env`);
  const script = 'printf \'NUVEON_WIKI_USER=%q\\nNUVEON_WIKI_PASS=%q\\n\' "$1" "$2"';
  const content = execFileSync('bash', ['-c', script, 'bash', user, pass], {
    encoding: 'utf-8',
  });
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

/** Env-Datei mit wörtlichem Inhalt schreiben (für Sonderfälle). */
function writeCredFileRaw(content: string): string {
  const path = join(workDir, `cred-raw-${fileCounter++}.env`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

describe('printf %q — Rundlauf', () => {
  const faelle: Array<{ name: string; user: string; pass: string }> = [
    { name: 'schlichtes Passwort', user: 'biko', pass: 'geheim123' },
    { name: 'Ausrufezeichen', user: 'biko', pass: 'geh!eim' },
    { name: 'Leerzeichen', user: 'biko', pass: 'zwei worte' },
    { name: 'einfaches Anführungszeichen', user: 'biko', pass: "es' geht" },
    { name: 'doppeltes Anführungszeichen', user: 'biko', pass: 'sag "hallo"' },
    { name: 'Dollarzeichen und Backtick', user: 'biko', pass: 'a$b`c' },
    { name: 'Backslash', user: 'biko', pass: 'a\\b\\c' },
    { name: 'Sonderzeichen gemischt', user: 'biko', pass: '#P&w!2026$x*(}[|;' },
    { name: 'Umlaute', user: 'jürgen', pass: 'Schlüssel-Größe' },
    { name: 'führendes und schließendes Leerzeichen', user: 'biko', pass: ' rand ' },
    { name: 'sieht aus wie zitiert', user: 'biko', pass: "'abc'" },
    { name: 'Tabulator', user: 'biko', pass: 'a\tb' },
  ];

  for (const fall of faelle) {
    test(`${fall.name} kommt zeichengleich zurück`, async () => {
      const path = writeCredFileViaPrintfQ(fall.user, fall.pass);
      const creds = await readNuveonCredentials(path);
      expect(creds.user).toBe(fall.user);
      expect(creds.pass).toBe(fall.pass);
    });
  }
});

describe('Sonderfälle', () => {
  test('fehlende Datei ergibt leere Werte, ohne Fehler', async () => {
    const creds = await readNuveonCredentials(join(workDir, 'gibt-es-nicht.env'));
    expect(creds).toEqual({ user: '', pass: '' });
  });

  test('leere Platzhalter werden als fehlend erkannt', async () => {
    // Genau der Zustand, den der Owner-Einzeiler bei leerer Eingabe erzeugt.
    const path = writeCredFileRaw("NUVEON_WIKI_USER=''\nNUVEON_WIKI_PASS=''\n");
    const creds = await readNuveonCredentials(path);
    expect(creds.user).toBe('');
    expect(creds.pass).toBe('');
  });

  test('fehlende Variablen ergeben leere Werte', async () => {
    const path = writeCredFileRaw('# nur ein Kommentar\n');
    const creds = await readNuveonCredentials(path);
    expect(creds).toEqual({ user: '', pass: '' });
  });

  test('unzitierte Datei funktioniert ebenfalls', async () => {
    // Falls die Datei einmal von Hand ohne %q geschrieben wird.
    const path = writeCredFileRaw('NUVEON_WIKI_USER=biko\nNUVEON_WIKI_PASS=schlicht\n');
    const creds = await readNuveonCredentials(path);
    expect(creds.user).toBe('biko');
    expect(creds.pass).toBe('schlicht');
  });

  test('Syntaxfehler in der Datei führt nicht zum Absturz', async () => {
    const path = writeCredFileRaw("NUVEON_WIKI_PASS='unbalanciert\n");
    const creds = await readNuveonCredentials(path);
    expect(creds).toEqual({ user: '', pass: '' });
  });

  test('der Dateipfad wird als Argument übergeben, nicht eingesetzt', async () => {
    // Ein Pfad mit Shell-Metazeichen darf nichts ausführen. Die Datei existiert
    // nicht, also sind leere Werte das erwartete Ergebnis — kein Seiteneffekt.
    const marker = join(workDir, 'darf-nicht-entstehen');
    const boeserPfad = `${workDir}/x; touch ${marker}; echo `;
    const creds = await readNuveonCredentials(boeserPfad);
    expect(creds).toEqual({ user: '', pass: '' });
    expect(() => rmSync(marker)).toThrow(); // Datei wurde nicht erzeugt
  });
});

/**
 * Die Vormerkung — Beschriftung, kein Schlüssel.
 *
 * Der wichtigste Test ist nicht, dass sie funktioniert, sondern dass sie
 * NICHTS freigibt: Eine kaputte, fremde oder uralte Vormerkung darf weder die
 * Freigabe verhindern noch sie ersetzen. Sie darf auch kein beliebiges Wort in
 * die Sitzung des Owners schreiben — sonst wäre aus einer Beschriftung eine
 * Fernsteuerung geworden.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  vormerkungLesen, vormerkungSchreiben, vormerkungLoeschen, vormerkungPfad,
  VORMERKUNG_TTL_MS, SCHRITT_MAX,
} from '../vormerkung.js';

let verzeichnis: string;
let flagge: string;

beforeEach(() => {
  verzeichnis = mkdtempSync(join(tmpdir(), 'vormerkung-'));
  flagge = join(verzeichnis, '.armed-bikosoc');
});
afterEach(() => {
  rmSync(verzeichnis, { recursive: true, force: true });
});

describe('Schreiben und Lesen', () => {
  test('legt den Schritt ab und gibt ihn unverändert zurück', () => {
    vormerkungSchreiben(flagge, 'Migration V043 anwenden', 'weiter');
    const v = vormerkungLesen(flagge);
    expect(v?.schritt).toBe('Migration V043 anwenden');
    expect(v?.anstoss).toBe('weiter');
  });

  test('liegt neben dem Flag, nicht darin', () => {
    vormerkungSchreiben(flagge, 'etwas', 'weiter');
    expect(vormerkungPfad(flagge)).toBe(`${flagge}.vormerkung`);
    /* Entscheidend: Das Flag selbst entsteht dabei NICHT. Sonst hätte cc sich
       mit einer Vormerkung selbst scharfgestellt. */
    expect(existsSync(flagge)).toBe(false);
  });

  test('nur der Eigentümer darf sie lesen (0600)', () => {
    vormerkungSchreiben(flagge, 'etwas', 'weiter');
    expect(statSync(vormerkungPfad(flagge)).mode & 0o777).toBe(0o600);
  });

  test('löschen ist still, auch wenn nichts da ist', () => {
    expect(() => vormerkungLoeschen(flagge)).not.toThrow();
    vormerkungSchreiben(flagge, 'etwas', 'weiter');
    vormerkungLoeschen(flagge);
    expect(vormerkungLesen(flagge)).toBeNull();
  });
});

describe('Was NICHT durchkommt', () => {
  test('ein fremdes Anstoßwort wird verworfen, nicht übernommen', () => {
    /* Von Hand geschrieben, am Schreibpfad vorbei — so sähe eine manipulierte
       Datei aus. Das Wort landet nicht in der Sitzung. */
    writeFileSync(vormerkungPfad(flagge), JSON.stringify({
      schritt: 'harmlos', anstoss: 'rm -rf /', gestellt: Date.now(),
    }));
    expect(vormerkungLesen(flagge)?.anstoss).toBe('');
  });

  test('beim Schreiben wird ein fremdes Anstoßwort abgewiesen', () => {
    expect(() => vormerkungSchreiben(flagge, 'etwas', 'deploy')).toThrow(/nicht erlaubt/);
    expect(existsSync(vormerkungPfad(flagge))).toBe(false);
  });

  test('ein leerer Schritt wird abgewiesen', () => {
    expect(() => vormerkungSchreiben(flagge, '   ', 'weiter')).toThrow(/nicht leer/);
  });

  test('zu alt zählt nicht mehr', () => {
    const alt = Date.now() - VORMERKUNG_TTL_MS - 1000;
    vormerkungSchreiben(flagge, 'von gestern', 'weiter', alt);
    expect(vormerkungLesen(flagge)).toBeNull();
    /* Knapp innerhalb der Frist dagegen schon. */
    vormerkungSchreiben(flagge, 'frisch genug', 'weiter', Date.now() - VORMERKUNG_TTL_MS + 60_000);
    expect(vormerkungLesen(flagge)?.schritt).toBe('frisch genug');
  });

  test('kaputter Inhalt ergibt null statt eines Fehlers', () => {
    for (const roh of ['kein json', '{}', '{"schritt":""}', '[]', '{"schritt":"x"}']) {
      writeFileSync(vormerkungPfad(flagge), roh);
      expect(vormerkungLesen(flagge), roh).toBeNull();
    }
  });

  test('ein überlanger Schritt wird gekürzt, nicht abgewiesen', () => {
    vormerkungSchreiben(flagge, 'x'.repeat(SCHRITT_MAX + 500), 'weiter');
    expect(vormerkungLesen(flagge)?.schritt.length).toBe(SCHRITT_MAX);
  });

  test('ohne Datei schlicht null', () => {
    expect(vormerkungLesen(flagge)).toBeNull();
  });
});

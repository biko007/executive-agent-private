/**
 * Casameta wird über den Chrome des Owners bedient — nicht mehr vom Server.
 *
 * ANLASS (Owner-Entscheidung, 16.10.2026). Der serverseitige Login ist zweimal
 * gemessen worden und scheitert an Cloudflare Turnstile:
 *
 *   13.10.  headless                      Fehler 600010
 *   14.10.  sichtbarer Browser unter Xvfb Fehler 600010 — identisch
 *   16.10.  Portal erneut gelesen: Turnstile unverändert aktiv,
 *           kein Passwortfeld ausgeliefert
 *
 * Daraus folgt nicht nur „der Weg funktioniert nicht", sondern auch: **Auf dem
 * Server soll kein Passwort mehr liegen.** Wo keines liegt, kann keines
 * abhandenkommen — und ein Passwort, das ohnehin nichts bewirkt, ist reines
 * Risiko.
 *
 * Gelöscht wurde nichts. Die Skripte und die Mehrkontentechnik bleiben stehen;
 * ein Revert stellt den alten Zustand her, falls das Portal den Bot-Schutz je
 * abschaltet. Diese Tests halten fest, dass der Passwortpfad bis dahin
 * verschlossen bleibt.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const WURZEL = path.resolve(import.meta.dir, '..', '..', '..', '..');
const lies = (p: string) => fs.readFileSync(path.join(WURZEL, p), 'utf-8');

describe('Das Credentials-Skript nimmt kein Passwort mehr entgegen', () => {
  const skript = lies('ops/bin/casameta-credentials');

  test('bricht ab, bevor irgendetwas eingelesen wird', () => {
    const sperre = skript.indexOf('exit 3');
    const eingabe = skript.search(/\bread\b/);
    expect(sperre).toBeGreaterThan(-1);
    /* Entscheidend: Der Abbruch steht VOR jeder Eingabeaufforderung. Sonst
       stünde das Passwort schon im Speicher, bevor abgelehnt wird. */
    if (eingabe > -1) expect(sperre).toBeLessThan(eingabe);
  });

  test('nennt den Grund und den neuen Weg', () => {
    expect(skript).toContain('Chrome des Owners');
    expect(skript).toContain('600010');
    expect(skript).toContain('casameta-run');
  });

  test('sagt auch, wie es rückgängig zu machen wäre', () => {
    expect(skript).toContain('Revert');
  });
});

describe('casameta-run bereitet nur noch vor', () => {
  const skript = lies('ops/bin/casameta-run');

  test('ruft den serverseitigen Login nicht mehr auf', () => {
    const uebergabe = skript.indexOf('Uebergabe an den Chrome');
    const login = skript.indexOf('casameta-login.ts');
    expect(uebergabe).toBeGreaterThan(-1);
    /* Der alte Weg bleibt als toter Code stehen, damit ein Revert vollständig
       ist — aber er muss NACH dem exit liegen. */
    if (login > -1) expect(login).toBeGreaterThan(skript.indexOf('exit 0', uebergabe));
  });

  test('setzt den Lauf auf „wartet", nicht auf „fehler"', () => {
    /* Es ist nichts schiefgegangen: Der Lauf wartet auf den Owner. Ein
       „fehler" würde die Auswertung und die Lämpchen verfälschen. */
    expect(skript).toContain('"status": "wartet"');
  });

  test('schreibt eine Übergabedatei mit Auftrag, Regeln und Rückweg', () => {
    expect(skript).toContain('uebergabe.md');
    expect(skript).toContain('Was du nicht darfst');     // die Schutzregeln
    expect(skript).toContain('ergebnis.md');             // der Rückweg
    expect(skript).toContain('casameta-protokoll.ts');   // die Auswertung
  });
});

describe('Das Login-Skript verweigert den Anmeldeversuch', () => {
  const skript = lies('scripts/casameta-login.ts');

  test('ohne --trotzdem wird nicht angemeldet', () => {
    expect(skript).toContain("if (!argv.includes('--trotzdem'))");
    expect(skript).toContain('process.exit(3)');
  });

  test('JEDER Anmeldeversuch liegt hinter einer Sperre', () => {
    /* Dieser Test hat beim Schreiben eine Luecke gefunden: Der Zweig
       `--selbsttest` verwirft die Sitzung und meldet sich neu an — er ist
       also ein Anmeldeversuch und stand zunaechst VOR der Sperre. Jetzt
       traegt jeder Aufruf von anmelden() eine eigene davor. */
    const sperren = [...skript.matchAll(/argv\.includes\('--trotzdem'\)/g)].map(m => m.index!);
    const versuche = [...skript.matchAll(/await anmelden\(/g)].map(m => m.index!);
    expect(sperren.length).toBeGreaterThan(0);
    expect(versuche.length).toBeGreaterThan(0);
    for (const v of versuche) {
      expect(sperren.some(s => s < v), `Anmeldung an Stelle ${v} ohne Sperre davor`).toBe(true);
    }
  });

  test('die passwortfreien Abfragen bleiben erreichbar', () => {
    /* --konten und --pruefen brauchen kein Passwort und bleiben nützlich:
       Das eine beantwortet „liegt hier noch etwas?", das andere „trägt eine
       Sitzung noch?". Sie müssen also durchkommen — und dürfen sich dabei
       nirgends anmelden.

       Die Reihenfolge im Text taugt dafür nicht als Maß: Seit der Selbsttest
       eine eigene Sperre trägt, steht eine davon vor `--pruefen`. Geprüft wird
       deshalb der ZWEIG selbst. */
    for (const flag of ['--konten', '--pruefen']) {
      const start = skript.indexOf(`argv.includes('${flag}')`);
      expect(start, flag).toBeGreaterThan(-1);
      /* Der Zweig endet an seiner eigenen schliessenden Klammer — bei
         `--pruefen` ist das wichtig, denn danach folgt der (gesperrte)
         Anmeldepfad, der sonst faelschlich mitgelesen wuerde. */
      const ende = skript.indexOf('\n  }\n', start);
      const zweig = skript.slice(start, ende > -1 ? ende : skript.length);
      expect(zweig, flag).toContain('process.exit');
      expect(zweig, flag).not.toContain('anmelden(');
    }
  });
});

describe('Repo und ausgespielte Fassung stimmen überein', () => {
  /* Der Smoke-Test prüft das ebenfalls über Hashes; hier steht es noch einmal
     inhaltlich, damit ein Auseinanderlaufen schon im Testlauf auffällt. */
  for (const name of ['casameta-credentials', 'casameta-run']) {
    test(name, () => {
      const repo = lies(path.join('ops', 'bin', name));
      const live = fs.readFileSync(path.join(process.env.HOME!, 'bin', name), 'utf-8');
      expect(live).toBe(repo);
    });
  }
});

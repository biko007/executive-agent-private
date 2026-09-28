/**
 * wiki/nuveon-credentials — Zugangsdaten für den Nuveon-Import einlesen.
 *
 * Warum eine eigene Datei und kein einfacher KEY=VALUE-Parser:
 *
 * `~/.config/openclaw/nuveon-wiki.env` wird per Konvention mit `printf %q`
 * geschrieben, damit die Datei mit `set -a; source …` verwendbar bleibt. `%q`
 * zitiert shell-gerecht — aus `geh!eim` wird `geh\!eim`, aus `ab cd` wird
 * `ab\ cd`, aus einem Leerstring `''`. Ein selbstgeschriebener Parser, der nur
 * umschließende Anführungszeichen abstreift, liefert für solche Werte den
 * falschen String; der Login schlägt fehl und der Import stoppt nach zwei
 * Versuchen (Stop-Condition 2), obwohl das Passwort richtig übermittelt wurde.
 *
 * Deshalb wertet hier die Shell selbst die Datei aus. Das ist die einzige
 * Auslegung, die mit allen `%q`-Formen übereinstimmt.
 *
 * Geheimnisschutz: Die Werte kommen über stdout des Kindprozesses und leben nur
 * im Speicher. Sie stehen nie in argv (dort steht nur der Dateipfad), nie in
 * einer Umgebungsvariable dieses Prozesses und werden nie geloggt.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

export interface NuveonCredentials {
  user: string;
  pass: string;
}

/**
 * Shell-Skript, das die Datei einliest und beide Werte NUL-getrennt ausgibt.
 * NUL ist der einzige Trenner, der in einem Passwort nicht vorkommen kann.
 * Der Dateipfad wird als Argument übergeben, nicht in das Skript eingesetzt —
 * damit ist kein Einschleusen über den Pfad möglich.
 */
const READ_SCRIPT = [
  'set -a',
  '. "$1"',
  'set +a',
  'printf %s "${NUVEON_WIKI_USER-}"',
  'printf "\\0"',
  'printf %s "${NUVEON_WIKI_PASS-}"',
].join('; ');

/**
 * Zugangsdaten lesen. Fehlt die Datei oder sind die Werte leer, kommen leere
 * Strings zurück — der Aufrufer entscheidet dann über den Abbruch.
 */
export async function readNuveonCredentials(filePath: string): Promise<NuveonCredentials> {
  if (!existsSync(filePath)) return { user: '', pass: '' };

  let stdout: string;
  try {
    const result = await execFileAsync('bash', ['-c', READ_SCRIPT, 'bash', filePath], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf-8',
    });
    stdout = result.stdout;
  } catch {
    // Unlesbare oder fehlerhafte Datei wie fehlende Zugangsdaten behandeln.
    // Die Fehlermeldung wird absichtlich nicht weitergegeben: sie könnte den
    // Dateiinhalt zitieren.
    return { user: '', pass: '' };
  }

  const separatorIndex = stdout.indexOf('\u0000');
  if (separatorIndex < 0) return { user: '', pass: '' };

  return {
    // Beim Benutzernamen sind umgebende Leerzeichen mit Sicherheit unbeabsichtigt.
    user: stdout.slice(0, separatorIndex).trim(),
    // Beim Passwort NICHT trimmen — ein Leerzeichen am Rand kann echt sein.
    pass: stdout.slice(separatorIndex + 1),
  };
}

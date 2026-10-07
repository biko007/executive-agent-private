/**
 * shared/utils/bild-format — Bildformat an den ersten Bytes erkennen.
 *
 * WARUM NICHT MIME ODER ENDUNG: Beides liefert der Client und ist frei wählbar.
 * Ein Upload, der `image/jpeg` behauptet, kann alles enthalten. Die ersten Bytes
 * einer Datei lügen nicht.
 *
 * Mobile Safari meldet für HEIC-Aufnahmen je nach iOS-Fassung `image/heic`,
 * `image/heif` oder einen leeren MIME-Typ — eine MIME-Weiche würde genau den
 * Fall verfehlen, der funktionieren soll.
 *
 * ZWEITE FASSUNG IM DASHBOARD: `server.mjs` hat denselben Erkenner (Funktion
 * `bildFormatErkennen`). Die beiden Dienste sind getrennte Prozesse in
 * getrennten Repositories ohne gemeinsames Paket; eine Kopie ist hier der
 * kleinere Preis als ein geteiltes Paket nur für dreißig Zeilen. Wer eine Marke
 * ergänzt, ergänzt sie an beiden Stellen — deshalb steht der Hinweis in beiden
 * Dateien.
 */

export type BildFormat = 'png' | 'jpeg' | 'heic';

/** HEIF-Markenkennungen, die ein Standbild bezeichnen. AVIF bewusst nicht. */
const HEIF_MARKEN = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1',
]);

/** Alle Markenkennungen aus der ftyp-Box lesen (Hauptmarke plus verträgliche). */
function ftypMarken(buf: Buffer): string[] {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return [];
  const boxLaenge = Math.min(buf.readUInt32BE(0), buf.length);
  const marken = [buf.toString('latin1', 8, 12)];
  for (let i = 16; i + 4 <= boxLaenge; i += 4) {
    marken.push(buf.toString('latin1', i, i + 4));
  }
  return marken;
}

/**
 * Liefert 'png', 'jpeg', 'heic' — oder null, wenn die Bytes keines dieser
 * Formate zeigen.
 */
export function bildFormatErkennen(buf: Buffer): BildFormat | null {
  if (!buf || buf.length < 12) return null;

  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG'
      && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'png';
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';

  const marken = ftypMarken(buf);
  if (marken.length && !marken[0].startsWith('avi') && marken.some(m => HEIF_MARKEN.has(m))) {
    return 'heic';
  }
  return null;
}

/**
 * Passt der gemeldete MIME-Typ zu den tatsächlichen Bytes?
 *
 * Nur für Bild-MIMEs gedacht. Für alles andere (Video) liefert die Funktion
 * `true`, weil dieser Erkenner dafür nicht zuständig ist — der Aufrufer
 * entscheidet dann über seine eigene Whitelist.
 */
export function mimePasstZuBytes(mime: string, buf: Buffer): boolean {
  const erwartet: Record<string, BildFormat> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/heic': 'heic',
    'image/heif': 'heic',
  };
  const soll = erwartet[mime];
  if (!soll) return true;            // kein Bild-MIME — hier nicht zuständig
  return bildFormatErkennen(buf) === soll;
}

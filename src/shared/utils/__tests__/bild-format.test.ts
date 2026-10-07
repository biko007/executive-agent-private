import { describe, expect, test } from 'bun:test';
import { bildFormatErkennen, mimePasstZuBytes } from '../bild-format.js';

/** PNG-Signatur plus genug Fuellbytes fuer die Mindestlaenge. */
function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8),
  ]);
}

function jpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
}

/** ftyp-Box mit Hauptmarke und optionalen vertraeglichen Marken bauen. */
function ftyp(haupt: string, vertraeglich: string[] = []): Buffer {
  const laenge = 16 + vertraeglich.length * 4;
  const b = Buffer.alloc(laenge + 8);
  b.writeUInt32BE(laenge, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(haupt, 8, 'latin1');
  b.writeUInt32BE(0, 12);                  // minor version
  vertraeglich.forEach((m, i) => b.write(m, 16 + i * 4, 'latin1'));
  return b;
}

describe('bildFormatErkennen', () => {
  test('erkennt PNG an der Signatur', () => {
    expect(bildFormatErkennen(png())).toBe('png');
  });

  test('erkennt JPEG an der Signatur', () => {
    expect(bildFormatErkennen(jpeg())).toBe('jpeg');
  });

  test('erkennt HEIC an der Hauptmarke', () => {
    expect(bildFormatErkennen(ftyp('heic'))).toBe('heic');
  });

  test('erkennt HEIC auch, wenn die Marke erst in der Vertraeglichkeitsliste steht', () => {
    // iPhone-Aufnahmen tragen z. B. ftyp mif1 mit heic in der Liste
    expect(bildFormatErkennen(ftyp('mif1', ['heic', 'hevc']))).toBe('heic');
  });

  test('AVIF gilt NICHT als HEIC', () => {
    expect(bildFormatErkennen(ftyp('avif', ['mif1']))).toBeNull();
  });

  test('MP4-Video ist kein Bild', () => {
    expect(bildFormatErkennen(ftyp('isom', ['mp41']))).toBeNull();
  });

  test('zu kurze und leere Puffer ergeben null', () => {
    expect(bildFormatErkennen(Buffer.alloc(0))).toBeNull();
    expect(bildFormatErkennen(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  test('WebP und GIF sind nicht erlaubt', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(12)]);
    expect(bildFormatErkennen(webp)).toBeNull();
    expect(bildFormatErkennen(gif)).toBeNull();
  });
});

describe('mimePasstZuBytes', () => {
  test('passender Bild-MIME wird angenommen', () => {
    expect(mimePasstZuBytes('image/png', png())).toBe(true);
    expect(mimePasstZuBytes('image/jpeg', jpeg())).toBe(true);
    expect(mimePasstZuBytes('image/heic', ftyp('heic'))).toBe(true);
    expect(mimePasstZuBytes('image/heif', ftyp('mif1', ['heic']))).toBe(true);
  });

  test('gelogener Bild-MIME wird abgewiesen', () => {
    expect(mimePasstZuBytes('image/jpeg', png())).toBe(false);
    expect(mimePasstZuBytes('image/png', jpeg())).toBe(false);
    expect(mimePasstZuBytes('image/heic', jpeg())).toBe(false);
  });

  test('Nicht-Bild-MIMEs fallen nicht in die Zustaendigkeit', () => {
    expect(mimePasstZuBytes('video/mp4', ftyp('isom', ['mp41']))).toBe(true);
    expect(mimePasstZuBytes('video/quicktime', Buffer.alloc(16))).toBe(true);
  });
});

/**
 * Grundrissblatt im Einheitsformat — SVG erzeugen.
 *
 * Owner-Vorgabe 16.10.2026 (Teil 4): A4 quer, ein Blatt je Geschoss,
 * maßstäblich 1:100, Nordpfeil, Kopfzeile mit Kürzel, Adresse, Geschoss,
 * Quelle und Stand. Wände vereinfacht, Räume mit Name und Fläche, Einheiten
 * farbig mit Legende, Gemeinschaftsflächen grau, Stellplätze nummeriert.
 *
 * Die Zeichnung entsteht aus einer **vermessenen Quelle** — DXF, DWG oder ein
 * Aufmaß. Nichts wird geschätzt: Kommt die Geometrie nicht aus einer solchen
 * Quelle, trägt das Blatt im Kopf „nicht maßstäblich", und der Maßstabsbalken
 * entfällt. Ein erfundener Grundriss wäre schlimmer als gar keiner.
 *
 * Koordinaten kommen in METERN, Ursprung links unten, y nach oben — so liegen
 * sie in jeder CAD-Quelle. Das Blatt rechnet in Millimetern auf dem Papier.
 */

/** A4 quer in Millimetern. */
export const BLATT = { breite: 297, hoehe: 210 } as const;
export const RAND = { links: 12, rechts: 12, oben: 24, unten: 14 } as const;

/** Farben je Einheit. Gedeckt, damit Raumnamen lesbar bleiben. */
export const EINHEIT_FARBEN = [
  '#cfe3f5', '#d8f0d8', '#fde8cc', '#f3d9ea', '#e2dcf5', '#d6f0ef', '#f6f0c8',
];
export const GEMEINSCHAFT_FARBE = '#e6e6e6';

export interface Raum {
  name: string;
  /** Fläche in m², wie in der Quelle ausgewiesen. */
  flaeche?: number;
  /** Einheit, zu der der Raum gehört — `null` = Gemeinschaftsfläche. */
  einheit?: string | null;
  /** Umriss in Metern, im Uhrzeigersinn oder dagegen; erster Punkt nicht wiederholen. */
  punkte: [number, number][];
}

export interface Oeffnung {
  /** Tür oder Fenster, als Strecke in Metern. */
  art: 'tuer' | 'fenster';
  von: [number, number];
  bis: [number, number];
}

export interface Stellplatz {
  nummer: string;
  punkte: [number, number][];
}

export interface Blatt {
  objekt: string;
  adresse: string;
  geschoss: string;
  quelle: string;
  stand: string;
  /** 100 = 1:100. `null` = nicht maßstäblich (Quelle nicht vermessen). */
  massstab: number | null;
  /** Drehung des Nordpfeils in Grad, 0 = Norden oben. */
  nord_grad?: number;
  raeume: Raum[];
  oeffnungen?: Oeffnung[];
  stellplaetze?: Stellplatz[];
  /** Hinweis, der unter dem Kopf steht — etwa „Beispielgeometrie". */
  hinweis?: string;
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function zahl(n: number, stellen = 2): string {
  return n.toFixed(stellen).replace('.', ',');
}

/** Schwerpunkt eines Polygons — dort steht die Beschriftung. */
export function schwerpunkt(p: [number, number][]): [number, number] {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    const f = x1 * y2 - x2 * y1;
    a += f; x += (x1 + x2) * f; y += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = p.length;
    return [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n];
  }
  a *= 0.5;
  return [x / (6 * a), y / (6 * a)];
}

/** Fläche eines Polygons in m² — zur Probe gegen die Angabe aus der Quelle. */
export function polygonFlaeche(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Umschließendes Rechteck aller Geometrie in Metern. */
export function ausdehnung(b: Blatt): { x0: number; y0: number; x1: number; y1: number } {
  const alle: [number, number][] = [
    ...b.raeume.flatMap(r => r.punkte),
    ...(b.stellplaetze || []).flatMap(s => s.punkte),
  ];
  if (!alle.length) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return {
    x0: Math.min(...alle.map(p => p[0])), y0: Math.min(...alle.map(p => p[1])),
    x1: Math.max(...alle.map(p => p[0])), y1: Math.max(...alle.map(p => p[1])),
  };
}

/**
 * Das Blatt als SVG.
 *
 * Bei festem Maßstab wird NICHT auf das Blatt skaliert: 1:100 heißt 1:100.
 * Passt die Zeichnung nicht, meldet die Funktion das — ein stillschweigend
 * verkleinertes Blatt mit der Aufschrift „1:100" wäre eine Falschangabe.
 */
export function grundrissSvg(b: Blatt): { svg: string; warnungen: string[] } {
  const warnungen: string[] = [];
  const a = ausdehnung(b);
  const breiteM = a.x1 - a.x0;
  const hoeheM = a.y1 - a.y0;
  const platzB = BLATT.breite - RAND.links - RAND.rechts;
  const platzH = BLATT.hoehe - RAND.oben - RAND.unten;

  /* mm je Meter. 1:100 heisst 10 mm je Meter. */
  let mmProM = b.massstab ? 1000 / b.massstab : Math.min(platzB / breiteM, platzH / hoeheM) * 0.95;
  if (b.massstab && (breiteM * mmProM > platzB || hoeheM * mmProM > platzH)) {
    warnungen.push(`Die Zeichnung ist im Maßstab 1:${b.massstab} größer als das Blatt `
      + `(${zahl(breiteM, 1)} × ${zahl(hoeheM, 1)} m). Entweder ein größeres Format oder ein `
      + `kleinerer Maßstab — automatisch verkleinert wird nicht.`);
    mmProM = Math.min(platzB / breiteM, platzH / hoeheM) * 0.95;
  }

  const zeichenB = breiteM * mmProM;
  const zeichenH = hoeheM * mmProM;
  const offX = RAND.links + (platzB - zeichenB) / 2;
  const offY = RAND.oben + (platzH - zeichenH) / 2;
  /* Papier: y nach unten. Quelle: y nach oben. */
  const px = (x: number) => offX + (x - a.x0) * mmProM;
  const py = (y: number) => offY + (a.y1 - y) * mmProM;
  const pfad = (p: [number, number][]) =>
    p.map((q, i) => `${i ? 'L' : 'M'}${px(q[0]).toFixed(2)},${py(q[1]).toFixed(2)}`).join(' ') + ' Z';

  const einheiten = [...new Set(b.raeume.map(r => r.einheit).filter(Boolean))] as string[];
  const farbe = (e: string | null | undefined) =>
    e ? EINHEIT_FARBEN[einheiten.indexOf(e) % EINHEIT_FARBEN.length] : GEMEINSCHAFT_FARBE;

  const flaecheJeEinheit = new Map<string, number>();
  for (const r of b.raeume) {
    if (!r.einheit) continue;
    const f = r.flaeche ?? polygonFlaeche(r.punkte);
    flaecheJeEinheit.set(r.einheit, Math.round(((flaecheJeEinheit.get(r.einheit) || 0) + f) * 100) / 100);
  }

  /* Probe: Angabe aus der Quelle gegen die gezeichnete Flaeche. */
  for (const r of b.raeume) {
    if (r.flaeche === undefined) continue;
    const gezeichnet = polygonFlaeche(r.punkte);
    if (Math.abs(gezeichnet - r.flaeche) > Math.max(0.5, r.flaeche * 0.05)) {
      warnungen.push(`${r.name}: Quelle nennt ${zahl(r.flaeche)} m², der Umriss ergibt `
        + `${zahl(gezeichnet)} m².`);
    }
  }

  const t: string[] = [];
  t.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${BLATT.breite}mm" height="${BLATT.hoehe}mm" `
    + `viewBox="0 0 ${BLATT.breite} ${BLATT.hoehe}" font-family="Helvetica, Arial, sans-serif">`);
  t.push(`<rect width="${BLATT.breite}" height="${BLATT.hoehe}" fill="#ffffff"/>`);
  t.push(`<rect x="5" y="5" width="${BLATT.breite - 10}" height="${BLATT.hoehe - 10}" `
    + `fill="none" stroke="#333" stroke-width="0.4"/>`);

  /* Kopfzeile */
  t.push(`<text x="10" y="13" font-size="5.2" font-weight="bold">${esc(b.objekt)} · ${esc(b.geschoss)}</text>`);
  t.push(`<text x="10" y="18.5" font-size="3.2" fill="#444">${esc(b.adresse)}</text>`);
  const massText = b.massstab ? `Maßstab 1:${b.massstab}` : 'nicht maßstäblich';
  t.push(`<text x="${BLATT.breite - 10}" y="13" font-size="3.6" text-anchor="end" font-weight="bold">${esc(massText)}</text>`);
  t.push(`<text x="${BLATT.breite - 10}" y="18.5" font-size="2.8" text-anchor="end" fill="#444">`
    + `Quelle: ${esc(b.quelle)} · Stand ${esc(b.stand)}</text>`);
  t.push(`<line x1="10" y1="20.5" x2="${BLATT.breite - 10}" y2="20.5" stroke="#333" stroke-width="0.3"/>`);
  if (b.hinweis) {
    t.push(`<text x="10" y="${BLATT.hoehe - 9}" font-size="3" fill="#b26a00" font-weight="bold">`
      + `${esc(b.hinweis)}</text>`);
  }

  /* Raeume */
  for (const r of b.raeume) {
    t.push(`<path d="${pfad(r.punkte)}" fill="${farbe(r.einheit)}" stroke="#222" stroke-width="0.7"/>`);
  }
  for (const r of b.raeume) {
    const [cx, cy] = schwerpunkt(r.punkte);
    const f = r.flaeche ?? polygonFlaeche(r.punkte);
    t.push(`<text x="${px(cx).toFixed(2)}" y="${py(cy).toFixed(2)}" font-size="2.6" `
      + `text-anchor="middle">${esc(r.name)}</text>`);
    t.push(`<text x="${px(cx).toFixed(2)}" y="${(py(cy) + 3.2).toFixed(2)}" font-size="2.4" `
      + `text-anchor="middle" fill="#555">${zahl(f)} m²</text>`);
  }

  /* Stellplaetze */
  for (const s of b.stellplaetze || []) {
    t.push(`<path d="${pfad(s.punkte)}" fill="#f0f0f0" stroke="#666" stroke-width="0.5" stroke-dasharray="1.5,1"/>`);
    const [cx, cy] = schwerpunkt(s.punkte);
    t.push(`<text x="${px(cx).toFixed(2)}" y="${py(cy).toFixed(2)}" font-size="2.6" `
      + `text-anchor="middle" fill="#444">${esc(s.nummer)}</text>`);
  }

  /* Oeffnungen: Tuer als Viertelkreis-Andeutung, Fenster als helle Linie. */
  for (const o of b.oeffnungen || []) {
    const x1 = px(o.von[0]), y1 = py(o.von[1]), x2 = px(o.bis[0]), y2 = py(o.bis[1]);
    if (o.art === 'fenster') {
      t.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" `
        + `stroke="#ffffff" stroke-width="1.4"/>`);
      t.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" `
        + `stroke="#4a7fb5" stroke-width="0.5"/>`);
    } else {
      t.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" `
        + `stroke="#ffffff" stroke-width="1.6"/>`);
      t.push(`<path d="M${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)}" `
        + `stroke="#222" stroke-width="0.4" stroke-dasharray="1,0.8" fill="none"/>`);
    }
  }

  /* Nordpfeil */
  const nx = BLATT.breite - 20, ny = 34, g = b.nord_grad || 0;
  t.push(`<g transform="translate(${nx},${ny}) rotate(${g})">`
    + `<path d="M0,-7 L3,4 L0,1.6 L-3,4 Z" fill="#222"/>`
    + `<text x="0" y="9.5" font-size="3" text-anchor="middle">N</text></g>`);

  /* Massstabsbalken — nur bei vermessener Quelle. */
  if (b.massstab) {
    const meter = 5, laenge = meter * mmProM;
    const bx = 12, by = BLATT.hoehe - 16;
    t.push(`<g><line x1="${bx}" y1="${by}" x2="${bx + laenge}" y2="${by}" stroke="#222" stroke-width="0.6"/>`
      + `<line x1="${bx}" y1="${by - 1.4}" x2="${bx}" y2="${by + 1.4}" stroke="#222" stroke-width="0.6"/>`
      + `<line x1="${bx + laenge}" y1="${by - 1.4}" x2="${bx + laenge}" y2="${by + 1.4}" stroke="#222" stroke-width="0.6"/>`
      + `<text x="${bx + laenge / 2}" y="${by - 2.4}" font-size="2.6" text-anchor="middle">${meter} m</text></g>`);
  }

  /* Legende rechts unten */
  let ly = BLATT.hoehe - 16 - Math.max(0, einheiten.length - 1) * 5;
  t.push(`<text x="${BLATT.breite - 60}" y="${ly - 5}" font-size="3" font-weight="bold">Einheiten</text>`);
  for (const e of einheiten) {
    t.push(`<rect x="${BLATT.breite - 60}" y="${ly - 3}" width="4" height="3.2" fill="${farbe(e)}" stroke="#222" stroke-width="0.3"/>`);
    t.push(`<text x="${BLATT.breite - 54}" y="${ly}" font-size="2.8">${esc(e)} — `
      + `${zahl(flaecheJeEinheit.get(e) || 0)} m²</text>`);
    ly += 5;
  }
  if (b.raeume.some(r => !r.einheit)) {
    t.push(`<rect x="${BLATT.breite - 60}" y="${ly - 3}" width="4" height="3.2" fill="${GEMEINSCHAFT_FARBE}" stroke="#222" stroke-width="0.3"/>`);
    t.push(`<text x="${BLATT.breite - 54}" y="${ly}" font-size="2.8">Gemeinschaftsfläche</text>`);
  }

  t.push('</svg>');
  return { svg: t.join('\n'), warnungen };
}

/**
 * sekretariat/kurz — sprechende Kurzbezeichnungen für Vorgänge.
 *
 * Owner-Anweisung 03.11.2026 21:53: Die Kennung `v-fa6baea5` sagt dem Owner
 * nichts. Jeder Vorgang trägt deshalb eine stabile Kurzbezeichnung nach dem
 * Schema `<Objekt>-<Thema>-<Gegenüber>`, ohne Umlaute und Leerzeichen, höchstens
 * 40 Zeichen, eindeutig (bei einer Kollision mit Zähler `-2`, `-3` …).
 * Stammt sie von der KI, wird sie nur geglättet; fehlt sie, wird sie aus Objekt
 * und Titel gebildet. Einmal vergeben, bleibt sie — auch wenn sich der Titel
 * später ändert.
 *
 * Die Freigabe `Freigabe Vorgang <Bezeichnung …>` nimmt die Kurzbezeichnung
 * (bevorzugt) und weiterhin die Kennung, mehrere durch Leerzeichen getrennt,
 * unabhängig von Groß-/Kleinschreibung und Umlautschreibweise.
 */

export const KURZ_MAX = 40;

const UMLAUT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };

/** Umlaute ausschreiben, Akzente entfernen. */
export function ohneUmlaute(s: string): string {
  return s.replace(/[äöüÄÖÜß]/g, (c) => UMLAUT[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Vergleichsschlüssel: ohne Umlaute, klein, nur Buchstaben und Ziffern. */
export function vergleichsSchluessel(s: string): string {
  return ohneUmlaute(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Freien Text in die Form `Teil-Teil-Teil` bringen (ohne Kürzen). */
function glaette(s: string): string {
  return ohneUmlaute(s).replace(/&/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
}

/** Auf höchstens `max` Zeichen kürzen, an einer Bindestrich-Grenze. */
function kuerze(s: string, max = KURZ_MAX): string {
  if (s.length <= max) return s;
  const teile = s.split('-');
  let out = teile[0].slice(0, max);
  for (const t of teile.slice(1)) {
    if (out.length + 1 + t.length > max) break;
    out += '-' + t;
  }
  return out;
}

const FUELLWOERTER = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'und', 'oder', 'fuer', 'zu', 'zum', 'zur', 'vom', 'von', 'mit', 'im', 'in',
  'an', 'am', 'auf', 'bei', 'ab', 'bis', 'aus', 'ein', 'eine', 'einer', 'privat', 'stand', 'fa', 'nr',
]);

/** Objektteil: Kürzel groß (MG24), „privat" → „Privat", sonst nichts. */
function objektTeil(objekt: string | null | undefined): string {
  const o = (objekt ?? '').trim();
  if (!o) return '';
  if (/^privat$/i.test(o)) return 'Privat';
  return glaette(o.split(/[\/,\s]/)[0]).toUpperCase();
}

/**
 * Kurzbezeichnung aus Objekt und Titel bilden (Rückfall, wenn die KI keine
 * liefert). Nimmt das Objekt und die ersten bedeutungstragenden Wörter des
 * Titels; Klammerzusätze fallen weg.
 */
export function kurzAusTitel(titel: string, objekt: string | null | undefined): string {
  const obj = objektTeil(objekt);
  const objSchluessel = vergleichsSchluessel(obj);
  const woerter = ohneUmlaute(titel.replace(/\([^)]*\)/g, ' ').replace(/&/g, '')).split(/[^A-Za-z0-9]+/).filter(Boolean)
    .filter((w) => !FUELLWOERTER.has(w.toLowerCase()))
    .filter((w) => vergleichsSchluessel(w) !== objSchluessel)
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w));
  const roh = [obj, ...woerter.slice(0, 4)].filter(Boolean).join('-');
  return kuerze(glaette(roh)) || 'Vorgang';
}

/** Vorschlag der KI glätten; leer oder unbrauchbar → null. */
export function kurzGeglaettet(vorschlag: string | null | undefined): string | null {
  if (!vorschlag || typeof vorschlag !== 'string') return null;
  const g = kuerze(glaette(vorschlag));
  return g.length >= 3 ? g : null;
}

/** Eindeutig machen gegen die schon vergebenen (Vergleich ohne Groß-/Kleinschreibung und Umlaute). */
export function eindeutigeKurz(basis: string, vergeben: Iterable<string>): string {
  const belegt = new Set([...vergeben].map(vergleichsSchluessel));
  if (!belegt.has(vergleichsSchluessel(basis))) return basis;
  for (let n = 2; ; n++) {
    const zusatz = `-${n}`;
    const kandidat = kuerze(basis, KURZ_MAX - zusatz.length) + zusatz;
    if (!belegt.has(vergleichsSchluessel(kandidat))) return kandidat;
  }
}

interface MitKurz { kennung: string; titel: string; objekt: string | null; kurz?: string; status?: string }

/** Kurzbezeichnung für einen neuen Vorgang: KI-Vorschlag oder Rückfall, eindeutig gegen alle bestehenden. */
export function vergibKurz(v: Pick<MitKurz, 'titel' | 'objekt'>, kiVorschlag: string | null | undefined, alle: MitKurz[]): string {
  const basis = kurzGeglaettet(kiVorschlag) ?? kurzAusTitel(v.titel, v.objekt);
  return eindeutigeKurz(basis, alle.map((x) => x.kurz).filter((x): x is string => !!x));
}

/** Anzeige: Kurzbezeichnung, sonst die Kennung (alte Vorgänge ohne `kurz`). */
export function anzeigeName(v: Pick<MitKurz, 'kennung' | 'kurz'>): string {
  return v.kurz || v.kennung;
}

// ── Freigabe-Parser ─────────────────────────────────────────────────────────

export interface FreigabeErgebnis {
  /** Aufgelöste Vorgänge in der Reihenfolge der Eingabe (ohne Doppelte). */
  treffer: Array<{ eingabe: string; kennung: string; kurz: string | null; titel: string }>;
  /** Unbekannte Bezeichnungen mit den drei ähnlichsten Vorgängen. */
  unbekannt: Array<{ eingabe: string; aehnlich: Array<{ kennung: string; kurz: string | null; titel: string }> }>;
}

/** Levenshtein-Abstand (klein genug für ~100 Vorgänge × wenige Eingaben). */
function abstand(a: string, b: string): number {
  if (a === b) return 0;
  let vorher = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const jetzt = [i];
    for (let j = 1; j <= b.length; j++) {
      jetzt[j] = Math.min(vorher[j] + 1, jetzt[j - 1] + 1, vorher[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    vorher = jetzt;
  }
  return vorher[b.length];
}

/** Ähnlichkeit 0…1 zwischen Eingabe und Vorgang (Kurzbezeichnung, Titel, Wortüberdeckung). */
function aehnlichkeit(eingabe: string, v: MitKurz): number {
  const e = vergleichsSchluessel(eingabe);
  if (!e) return 0;
  const k = vergleichsSchluessel(v.kurz ?? '');
  const lev = k ? 1 - abstand(e, k) / Math.max(e.length, k.length) : 0;
  const teile = ohneUmlaute(eingabe).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  const heu = vergleichsSchluessel(`${v.kurz ?? ''} ${v.titel} ${v.objekt ?? ''}`);
  const wort = teile.length ? teile.filter((t) => heu.includes(t)).length / teile.length : 0;
  return Math.max(lev, wort * 0.95);
}

/**
 * Eine Freigabezeile auflösen. Nimmt die ganze Zeile („Freigabe Vorgang A B")
 * oder nur die Bezeichnungen; mehrere Zeilen sind erlaubt. Komma und Semikolon
 * gelten wie Leerzeichen, Backticks werden ignoriert.
 */
export function loeseFreigabe(text: string, vorgaenge: MitKurz[]): FreigabeErgebnis {
  const woerter = text.split('\n').flatMap((zeile) => {
    const ohne = zeile.replace(/[`*]/g, ' ').replace(/^\s*[-•]?\s*freigabe\s+(vorgang|vorgaenge|vorgänge)?\s*/i, '');
    return ohne.split(/[\s,;]+/).map((w) => w.replace(/^[„"'(]+|[“"'.):]+$/g, '')).filter(Boolean);
  });
  const nachKurz = new Map<string, MitKurz>();
  for (const v of vorgaenge) if (v.kurz) nachKurz.set(vergleichsSchluessel(v.kurz), v);
  const ergebnis: FreigabeErgebnis = { treffer: [], unbekannt: [] };
  const gesehen = new Set<string>();
  for (const w of woerter) {
    if (/^(und|sowie|freigabe|vorgang)$/i.test(w)) continue;
    const perKennung = /^v-[0-9a-f]{8}$/i.test(w) ? vorgaenge.find((v) => v.kennung === w.toLowerCase()) : undefined;
    const v = perKennung ?? nachKurz.get(vergleichsSchluessel(w));
    if (v) {
      if (!gesehen.has(v.kennung)) ergebnis.treffer.push({ eingabe: w, kennung: v.kennung, kurz: v.kurz ?? null, titel: v.titel });
      gesehen.add(v.kennung);
      continue;
    }
    const kandidaten = vorgaenge.filter((x) => x.status !== 'abgelegt')
      .map((x) => ({ x, s: aehnlichkeit(w, x) }))
      .sort((a, b) => b.s - a.s || (a.x.kurz ?? a.x.kennung).localeCompare(b.x.kurz ?? b.x.kennung))
      .slice(0, 3)
      .map(({ x }) => ({ kennung: x.kennung, kurz: x.kurz ?? null, titel: x.titel }));
    ergebnis.unbekannt.push({ eingabe: w, aehnlich: kandidaten });
  }
  return ergebnis;
}

/** Rückmeldung in Klartext für Chat oder Telegram. */
export function freigabeRueckmeldung(e: FreigabeErgebnis): string[] {
  const out = e.treffer.map((t) => `✅ ${t.kurz ?? t.kennung} — ${t.titel} (${t.kennung})`);
  for (const u of e.unbekannt) {
    out.push(`❓ „${u.eingabe}" ist kein bekannter Vorgang. Ähnlich: `
      + (u.aehnlich.length ? u.aehnlich.map((a) => `${a.kurz ?? a.kennung} (${a.titel})`).join(' · ') : 'keine'));
  }
  return out;
}

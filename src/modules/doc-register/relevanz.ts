/**
 * doc-register/relevanz — welche neue Datei ist ein Dokument mit Handlungsbedarf?
 *
 * Dieselbe Regeldatei wie das Mail-Register (`relevanz.json`), dort im Block
 * `dokumente`. Fehlt der Block, gilt die Vorgabe aus diesem Modul und wird
 * beim ersten Lauf in die Datei ergaenzt — die uebrigen Bloecke bleiben
 * unberuehrt. Objekte kommen aus dem gemeinsamen Block `objekte`.
 *
 * Reihenfolge:
 *   1. System- und temporaere Dateien             → nein
 *   2. eigener Kanal, cc-Ablagen (Pfadregeln)     → nein
 *   3. Kopie einer Datei aus einer anderen Ablage → nein
 *   4. Dateityp nicht in der Liste                → nein
 *   5. Bild: im Fotoordner nein; sonst nur mit Stichwort oder Objekt im Namen
 *   6. Stichwort oder Objekt in Name/Pfad, bei PDF auch auf Seite 1 → ja
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { KATALOG, type Regelwerk, type VorschlagCode } from '../mail-register/relevanz.js';
import { ausschluss as inventarAusschluss } from '../mail/index.js';
import type { DokDatei } from './quellen.js';

export interface DokRegeln {
  /** Dateiendungen, die als Dokument gelten (Regex ohne Punkt). */
  typen: string;
  /** Bildendungen — Scans nur mit Merkmal im Namen. */
  bildTypen: string;
  /** Pfade (klein geschrieben, Regex), die nie relevant sind. */
  ausschlussPfade: string[];
  /** Ordner mit reinen Fotos. */
  fotoOrdner: string;
  /** System- und temporaere Dateien (Dateiname). */
  systemMuster: string;
  /** Erste passende Zeile bestimmt den Vorschlag. */
  stichworte: Array<{ muster: string; vorschlag: Exclude<VorschlagCode, 'offen'>; thema: string }>;
}

export const STANDARD_DOK_REGELN: DokRegeln = {
  typen: '^(pdf|docx?|xlsx?|odt|ods|jpe?g|png|heic|tiff?)$',
  bildTypen: '^(jpe?g|png|heic|tiff?)$',
  ausschlussPfade: [
    '^/apps/bikosoc-reports/',
    '^/austausch/(reisen/(done|vorlage|belege)/|docs/|profil/|mail-[^/]+/|l19/enthaertung/)',
    '/report-[^/]*$',
    '^/(apps|anwendungen|microsoft teams-chatdateien|microsoft teams chat files|recordings|aufnahmen|whiteboards|notizbücher|notebooks)/',
  ],
  fotoOrdner: '(^|/)(camera uploads|kamera-uploads|fotos|photos|bilder|pictures|screenshots|bildschirmfotos)(/|$)',
  systemMuster: '^(~\\$|\\.~lock|\\._)|\\.(tmp|temp|lnk|ini|ds_store|part|crdownload)$|^(thumbs\\.db|desktop\\.ini|\\.ds_store)$',
  stichworte: [
    { muster: 'z(ä|ae)hlerst|ablesung|protokoll|(ü|ue)bergabe|rapport|servicebericht', vorschlag: 'b', thema: 'Fakten/Protokoll' },
    { muster: 'mahnung|zahlungserinnerung|widerspruch|reklamation', vorschlag: 'e', thema: 'Mahnung/Reklamation' },
    { muster: 'rechnung|faktura|invoice|gutschrift|abrechnung|quittung|lieferschein|(^|[ _-])re[ _-]?\\d', vorschlag: 'a', thema: 'Beleg' },
    { muster: 'bescheid|frist|k(ü|ue)ndigung|genehmigung', vorschlag: 'd', thema: 'Frist/Bescheid' },
    { muster: 'vertrag|vertr(ä|ae)ge|police|versicherungsschein|(^|[ _-])wv[ _-]|nachtrag|vereinbarung', vorschlag: 'b', thema: 'Vertrag/Police' },
    { muster: 'angebot', vorschlag: 'c', thema: 'Angebot' },
  ],
};

/** Block `dokumente` aus relevanz.json, mit Vorgabe fuer Fehlendes und Kaputtes. */
export function ladeDokRegeln(pfad: string): { regeln: DokRegeln; warnungen: string[] } {
  const warnungen: string[] = [];
  let roh: any = null;
  try { roh = JSON.parse(fs.readFileSync(pfad, 'utf-8'))?.dokumente ?? null; } catch { /* Vorgabe */ }
  if (!roh) return { regeln: STANDARD_DOK_REGELN, warnungen };
  const ok = (s: unknown) => { try { new RegExp(String(s), 'i'); return typeof s === 'string'; } catch { return false; } };
  const r: DokRegeln = { ...STANDARD_DOK_REGELN };
  for (const k of ['typen', 'bildTypen', 'fotoOrdner', 'systemMuster'] as const) {
    if (roh[k] === undefined) continue;
    if (ok(roh[k])) r[k] = roh[k]; else warnungen.push(`dokumente.${k} ungültig — Vorgabe gilt`);
  }
  if (Array.isArray(roh.ausschlussPfade)) {
    r.ausschlussPfade = roh.ausschlussPfade.filter((p: unknown) => {
      const g = ok(p); if (!g) warnungen.push(`dokumente.ausschlussPfade „${p}" ungültig — übergangen`); return g;
    });
  }
  if (Array.isArray(roh.stichworte)) {
    r.stichworte = roh.stichworte.filter((s: any) => {
      const g = ok(s?.muster) && s.vorschlag in KATALOG && s.vorschlag !== 'offen';
      if (!g) warnungen.push(`dokumente.stichworte „${s?.muster}" ungültig — übergangen`);
      return g;
    });
  }
  return { regeln: r, warnungen };
}

/**
 * Den Block `dokumente` in eine bestehende relevanz.json eintragen, wenn er
 * fehlt. Alle anderen Bloecke bleiben, wie der Owner sie geschrieben hat.
 */
export function dokRegelnErgaenzen(pfad: string): boolean {
  let roh: any;
  try { roh = JSON.parse(fs.readFileSync(pfad, 'utf-8')); } catch { return false; }
  if (!roh || typeof roh !== 'object' || roh.dokumente) return false;
  roh.dokumente = STANDARD_DOK_REGELN;
  fs.writeFileSync(pfad, JSON.stringify(roh, null, 2) + '\n', 'utf-8');
  return true;
}

export interface DokBewertung {
  relevant: boolean;
  grund: string;
  objekt?: string;
  thema?: string;
  vorschlag: VorschlagCode;
  /** Wurde die erste Seite gebraucht? */
  textGenutzt: boolean;
}

const re = (s: string) => new RegExp(s, 'i');
/** Private Kranken- und Pflegeversicherer, Arzt- und Apothekenpost. */
const GESUNDHEIT_TEXT = /\b(lkh|dkv|debeka|signal iduna|hallesche|barmenia|beihilfe|krankenversicherung|krankenkasse|pflegeversicherung|patient(in)?|diagnose|rezept|apotheke)\b/i;
export const endung = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

/** Ausschluss ohne Inhalt. Liefert den Grund oder null. */
export function dokAusschluss(d: Pick<DokDatei, 'name' | 'pfad'>, r: DokRegeln, kopie = false): string | null {
  const pfad = d.pfad.toLowerCase();
  if (re(r.systemMuster).test(d.name)) return 'System/temporär';
  if (r.ausschlussPfade.some((p) => re(p).test(pfad))) return 'eigener Kanal/cc-Ablage';
  if (kopie) return 'Kopie aus anderer Ablage';
  if (!re(r.typen).test(endung(d.name))) return 'Dateityp';
  if (re(r.bildTypen).test(endung(d.name)) && re(r.fotoOrdner).test(pfad)) return 'Foto';
  return null;
}

/** Braucht die Bewertung die erste Seite? Nur PDF ohne Stichwort im Namen. */
export function brauchtText(d: Pick<DokDatei, 'name' | 'pfad'>, _r?: DokRegeln): boolean {
  /* Auch mit Stichwort im Namen: Seite 1 kann Gesundheitspost verraten. */
  return endung(d.name) === 'pdf';
}

export function bewerteDok(
  d: Pick<DokDatei, 'name' | 'pfad'>, regeln: Regelwerk, r: DokRegeln,
  opts: { kopie?: boolean; text?: string } = {},
): DokBewertung {
  const nein = (grund: string): DokBewertung => ({ relevant: false, grund, vorschlag: 'offen', textGenutzt: false });
  const aus = dokAusschluss(d, r, opts.kopie);
  if (aus) return nein(aus);

  /* Unterstriche trennen in Dateinamen Woerter („2026-10-20_ZZ5_Rechnung");
     fuer \b sind sie aber Wortzeichen. Darum vor dem Vergleich als Leerzeichen. */
  const namePfad = d.pfad.replace(/_/g, ' ');
  const name = d.name.replace(/_/g, ' ');
  const text = (opts.text ?? '').slice(0, 4000);
  /* Gesundheitspost bleibt draussen wie im Mail-Register — Name, Pfad oder Seite 1. */
  /* Im Seitentext nur eng: „Labor" oder „Praxis" stehen auch in Serviceberichten. */
  if (inventarAusschluss({ betreff: namePfad, adresse: '', name: '' }) === 'gesundheit'
    || GESUNDHEIT_TEXT.test(`${namePfad} ${text.slice(0, 1500)}`)) {
    return nein('Gesundheit');
  }
  /* Kuerzel (MG24, D4 …) zaehlen im Dateinamen und Pfad wie im Mailbetreff;
     im Seitentext nur die ausgeschriebenen Adressen. */
  const objekt = regeln.objekte.find((o) => re(o.muster).test(namePfad))?.kuerzel
    ?? (text ? regeln.objekte.find((o) => o.text && re(o.text).test(text))?.kuerzel : undefined);
  const stichName = r.stichworte.find((s) => re(s.muster).test(name));
  const stich = stichName ?? (text ? r.stichworte.find((s) => re(s.muster).test(text)) : undefined);
  const textGenutzt = !stichName && !!stich;

  if (re(r.bildTypen).test(endung(d.name)) && !stichName
    && !regeln.objekte.some((o) => re(o.muster).test(name))) {
    return nein('Foto ohne Dokumentcharakter');
  }
  if (!stich && !objekt) return { ...nein('kein Merkmal'), textGenutzt: !!text };

  return {
    relevant: true,
    grund: [stich ? `Stichwort ${stich.thema}${textGenutzt ? ' (Seite 1)' : ''}` : '', objekt ? `Objekt ${objekt}` : '']
      .filter(Boolean).join(', '),
    objekt, thema: stich?.thema, vorschlag: stich?.vorschlag ?? 'offen', textGenutzt,
  };
}

/** Kennung fuer die Freigabezeile: je Datei UND Version. */
export function dokKennung(d: Pick<DokDatei, 'quelle' | 'id' | 'hash'>): string {
  return 'd-' + crypto.createHash('sha1').update(`${d.quelle}|${d.id}|${d.hash}`).digest('hex').slice(0, 8);
}

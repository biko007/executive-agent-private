/**
 * sekretariat/schema — was die KI je Neuheit liefert, und die Prüfung dazu.
 *
 * Spec Neuheiten-Sekretariat v1 (Owner-Freigabe 27.10.2026, 12:11), Stufe 2
 * „Verstehen": relevant ja/nein mit Begründung, Objekt, Vorgang (bestehend
 * oder neu), Art, Fakten, was erwartet wird und bis wann, Vorschlag a–f mit
 * nächstem Schritt. Jede Antwort wird gegen dieses Schema geprüft; eine
 * ungültige Antwort zählt als Fehler und wird nicht verwendet.
 */

export const ARTEN = [
  'rechnung', 'mahnung', 'bescheid', 'anfrage', 'antwort', 'vertrag', 'kuendigung',
  'angebot', 'auftragsbestaetigung', 'lieferschein', 'zaehlerstand', 'protokoll',
  'information', 'termin', 'sonstiges',
] as const;
export type Art = typeof ARTEN[number];

export const VORSCHLAEGE = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
export type Vorschlag = typeof VORSCHLAEGE[number];

export const VORSCHLAG_TEXT: Record<Vorschlag, string> = {
  a: 'Beleg ablegen + Buchungsvorschlag',
  b: 'Fakten in bikosoc einarbeiten',
  c: 'Antwortentwurf',
  d: 'Frist/Termin anlegen',
  e: 'Reklamation/Widerspruch',
  f: 'nur zur Kenntnis',
};

export interface Bewertung {
  relevant: boolean;
  /** Ein Satz, warum. */
  begruendung: string;
  /** Objektkürzel (MG24, N24 …), „privat" oder null. */
  objekt: string | null;
  vorgang: {
    /** Kennung eines bestehenden Vorgangs (v-…) oder null für neu. */
    bestehend: string | null;
    /** Titel, kurz: „MG24 EWärmeG-Erfüllungsnachweis". */
    titel: string;
  };
  art: Art;
  fakten: {
    betraege: Array<{ betrag: number; bezeichnung: string }>;
    nummern: string[];
    fristen: Array<{ datum: string; was: string }>;
    zaehlerstaende: Array<{ zaehler: string; stand: number; datum: string | null }>;
  };
  /** Was der Absender bzw. das Dokument vom Owner erwartet, oder null. */
  erwartet: string | null;
  /** Bis wann (YYYY-MM-DD) oder null. */
  bis: string | null;
  vorschlag: Vorschlag;
  /** Konkreter nächster Schritt, ein bis drei Sätze. */
  naechsterSchritt: string;
}

const istDatum = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const text = (s: unknown, max = 2000) => typeof s === 'string' ? s.trim().slice(0, max) : '';

/**
 * Antwort prüfen und in Form bringen. Liefert die Bewertung oder eine Liste
 * von Fehlern. Kleinigkeiten (fehlende Listen, Leerzeichen) werden geglättet,
 * Fehlendes in Pflichtfeldern nicht.
 */
export function pruefeBewertung(roh: unknown): { ok: true; wert: Bewertung } | { ok: false; fehler: string[] } {
  const f: string[] = [];
  const o: any = roh;
  if (!o || typeof o !== 'object') return { ok: false, fehler: ['keine Objektantwort'] };
  if (typeof o.relevant !== 'boolean') f.push('relevant fehlt oder ist kein Wahrheitswert');
  if (!text(o.begruendung)) f.push('begruendung fehlt');
  if (o.objekt !== null && o.objekt !== undefined && typeof o.objekt !== 'string') f.push('objekt muss Text oder null sein');
  if (!o.vorgang || typeof o.vorgang !== 'object' || !text(o.vorgang.titel)) f.push('vorgang.titel fehlt');
  if (o.vorgang && o.vorgang.bestehend !== null && o.vorgang.bestehend !== undefined
    && !(typeof o.vorgang.bestehend === 'string' && /^v-[0-9a-f]{8}$/.test(o.vorgang.bestehend))) {
    f.push('vorgang.bestehend muss v-xxxxxxxx oder null sein');
  }
  if (!ARTEN.includes(o.art)) f.push(`art unbekannt (${o.art})`);
  if (!VORSCHLAEGE.includes(o.vorschlag)) f.push(`vorschlag muss a–f sein (${o.vorschlag})`);
  if (!text(o.naechsterSchritt)) f.push('naechsterSchritt fehlt');
  if (o.bis !== null && o.bis !== undefined && !istDatum(o.bis)) f.push('bis muss YYYY-MM-DD oder null sein');
  const fk = o.fakten ?? {};
  const liste = (x: unknown) => Array.isArray(x) ? x : [];
  const fristen = liste(fk.fristen).filter((x: any) => istDatum(x?.datum));
  if (f.length) return { ok: false, fehler: f };
  return {
    ok: true,
    wert: {
      relevant: o.relevant,
      begruendung: text(o.begruendung, 400),
      objekt: o.objekt ? text(o.objekt, 40) : null,
      vorgang: { bestehend: o.vorgang.bestehend ?? null, titel: text(o.vorgang.titel, 120) },
      art: o.art,
      fakten: {
        betraege: liste(fk.betraege).filter((x: any) => typeof x?.betrag === 'number')
          .map((x: any) => ({ betrag: x.betrag, bezeichnung: text(x.bezeichnung, 120) })),
        nummern: liste(fk.nummern).filter((x: any) => typeof x === 'string').map((x: string) => x.slice(0, 60)).slice(0, 20),
        fristen: fristen.map((x: any) => ({ datum: x.datum, was: text(x.was, 160) })),
        zaehlerstaende: liste(fk.zaehlerstaende).filter((x: any) => typeof x?.stand === 'number')
          .map((x: any) => ({ zaehler: text(x.zaehler, 40), stand: x.stand, datum: istDatum(x.datum) ? x.datum : null })),
      },
      erwartet: o.erwartet ? text(o.erwartet, 400) : null,
      bis: o.bis ?? null,
      vorschlag: o.vorschlag,
      naechsterSchritt: text(o.naechsterSchritt, 1500),
    },
  };
}

/** Das JSON-Muster, das dem Modell im Prompt gezeigt wird. */
export const SCHEMA_TEXT = `{
  "relevant": true | false,
  "begruendung": "ein Satz, warum relevant oder nicht",
  "objekt": "Kürzel aus der Objektliste (z. B. MG24) | \\"privat\\" | null",
  "vorgang": { "bestehend": "v-xxxxxxxx aus der Liste offener Vorgänge | null", "titel": "<Objekt> <Thema>, kurz" },
  "art": "${ARTEN.join(' | ')}",
  "fakten": {
    "betraege": [ { "betrag": 123.45, "bezeichnung": "…" } ],
    "nummern": [ "Rechnungs-, Kunden-, Akten-, Auftragsnummern" ],
    "fristen": [ { "datum": "YYYY-MM-DD", "was": "…" } ],
    "zaehlerstaende": [ { "zaehler": "…", "stand": 123.4, "datum": "YYYY-MM-DD | null" } ]
  },
  "erwartet": "was vom Owner erwartet wird | null",
  "bis": "YYYY-MM-DD | null",
  "vorschlag": "a | b | c | d | e | f",
  "naechsterSchritt": "konkret: bei c der Antworttext in Stichpunkten, bei a Objekt/Kostenart/Betrag, bei d Datum und Quelle"
}`;

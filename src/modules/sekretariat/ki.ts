/**
 * sekretariat/ki — Kontext aus bikosoc, Prompt und Aufruf des Modells.
 *
 * Modell: der bereits konfigurierte Anbieter Anthropic mit ANTHROPIC_MODEL
 * (claude-sonnet-4-6, wie Reise-Anreicherung und Trading). Kein neuer Anbieter.
 * Gesundheitspost erreicht diese Datei nie — der Vorfilter nimmt sie vorher
 * heraus, und `bewerteMitKi` prüft das noch einmal selbst.
 */

import { ANTHROPIC_MODEL, fetchWithTimeout } from '../../shared/utils/index.js';
import { SCHEMA_TEXT, pruefeBewertung, type Bewertung } from './schema.js';
import { gesundheitImText, type Element } from './element.js';
import { maskiere, maskiere as maskiereIban } from '../mail-register/relevanz.js';

export interface Kontext {
  objekte: Array<{ kuerzel: string; adresse: string }>;
  /** „Name — Rolle (Objekt)" */
  kontakte: string[];
  /** „YYYY-MM-DD Objekt: was" */
  fristen: string[];
  /** Offene Vorgänge der letzten 90 Tage: „v-… | Titel | Objekt | letzte Elemente" */
  vorgaenge: string[];
  /** Owner-Vorgaben, die die KI kennen muss (Privatkäufe, Vereine, Eltern …). */
  vorgaben: string[];
}

export interface KiAntwort {
  bewertung: Bewertung | null;
  fehler: string | null;
  tokensEin: number;
  tokensAus: number;
  /** API-Aufrufe (1 oder 2) — zählt für den Deckel. */
  aufrufe: number;
}

export type KiClient = (system: string, nutzer: string) => Promise<{ text: string; tokensEin: number; tokensAus: number }>;

/** Anthropic Messages API, wie in travel/enrichment.ts. */
export function anthropicClient(apiKey: string, model = ANTHROPIC_MODEL): KiClient {
  return async (system, nutzer) => {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      /* System-Prompt (Kontext) mit Prompt-Caching: innerhalb eines Laufs fast
         gleich, also nur einmal voll bezahlt. */
      body: JSON.stringify({ model, max_tokens: 1500,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: nutzer }] }),
    }, 60_000);
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const d: any = await res.json();
    const u = d?.usage ?? {};
    return {
      text: String(d?.content?.[0]?.text ?? ''),
      tokensEin: Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0),
      tokensAus: Number(u.output_tokens ?? 0),
    };
  };
}

export function systemPrompt(k: Kontext): string {
  return [
    'Du bist das Sekretariat von Jürgen Bickel (Owner). Er besitzt und vermietet Immobilien (Objekte unten) und führt Firmen.',
    'Du bewertest EINE neue Mail oder EIN neues Dokument: Ist es für den Owner relevant, zu welchem Objekt und Vorgang gehört es, was wird erwartet, bis wann, und was ist der konkrete nächste Schritt.',
    'Relevant ist, was eine Handlung, Entscheidung, Zahlung, Frist oder Ablage verlangt oder Fakten zu Objekten, Verträgen, Behörden, Banken, Versicherungen enthält. Nicht relevant: Werbung, Newsletter, reine Information ohne Bezug, Privates ohne Handlungsbedarf.',
    'Ordne einem BESTEHENDEN Vorgang zu, wenn Objekt und Thema passen (auch bei anderem Absender, z. B. Behörde und Handwerker zum selben Nachweis). Sonst neuer Vorgang mit kurzem Titel „<Objekt> <Thema>".',
    'Vorschlag: a Beleg ablegen + Buchungsvorschlag (Objekt, Kostenart, Betrag) · b Fakten in bikosoc einarbeiten (Zählerstände, Vertragsdaten) · c Antwortentwurf (Kernpunkte des Textes) · d Frist/Termin anlegen (Datum, Quelle) · e Reklamation/Widerspruch · f nur zur Kenntnis.',
    'Gib nie Passwörter, PINs oder andere Zugangsdaten wieder — schreibe stattdessen „Zugangsdaten liegen in der Mail".',
    'Erfinde nichts: Fakten nur, wenn sie im Text stehen. Datum immer YYYY-MM-DD. Antworte NUR mit JSON nach diesem Schema, ohne Erklärtext:',
    SCHEMA_TEXT,
    '',
    '## Objekte',
    ...k.objekte.map((o) => `- ${o.kuerzel}: ${o.adresse}`),
    '',
    '## Kontakte',
    ...k.kontakte.slice(0, 300).map((c) => `- ${c}`),
    '',
    '## Laufende Fristen',
    ...(k.fristen.length ? k.fristen.slice(0, 40).map((f) => `- ${f}`) : ['- keine']),
    '',
    '## Offene Vorgänge (letzte 90 Tage)',
    ...(k.vorgaenge.length ? k.vorgaenge.slice(0, 120).map((v) => `- ${v}`) : ['- keine']),
    '',
    '## Owner-Vorgaben',
    ...k.vorgaben.map((v) => `- ${v}`),
  ].join('\n');
}

export function nutzerPrompt(e: Element): string {
  return [
    `Art: ${e.typ === 'mail' ? 'Mail' : 'Dokument'} (${e.quelle})`,
    `Datum: ${e.datum.slice(0, 16).replace('T', ' ')} UTC`,
    e.typ === 'mail' ? `Absender: ${e.vonName ? `${e.vonName} <${e.von}>` : e.von}` : `Ablageort: ${e.von}`,
    `${e.typ === 'mail' ? 'Betreff' : 'Dateiname'}: ${ohneZugangsdaten(maskiere(e.titel))}`,
    e.anhaenge?.length ? `Anhänge: ${e.anhaenge.join(', ')}` : '',
    '',
    /* IBAN und Kontonummern verlassen den Server nicht (C5). */
    e.text ? `Text (gekürzt):\n${ohneZugangsdaten(maskiere(e.text.slice(0, 3000)))}` : 'Text: (keiner lesbar)',
  ].filter((z) => z !== '').join('\n');
}

/** Eine Neuheit bewerten. Ungültiges JSON → ein zweiter Versuch mit Hinweis. */
export async function bewerteMitKi(e: Element, k: Kontext, client: KiClient): Promise<KiAntwort> {
  if (gesundheitImText(e)) throw new Error('Gesundheitspost darf nicht an das Modell');
  const system = systemPrompt(k);
  let nutzer = nutzerPrompt(e);
  let ein = 0; let aus = 0; let letzterFehler = ''; let aufrufe = 0;
  for (let versuch = 0; versuch < 2; versuch++) {
    aufrufe++;
    const r = await client(system, nutzer);
    ein += r.tokensEin; aus += r.tokensAus;
    const m = r.text.match(/\{[\s\S]*\}/);
    let roh: unknown = null;
    try { roh = m ? JSON.parse(m[0]) : null; } catch (x: any) { letzterFehler = `JSON: ${x.message}`; }
    if (roh) {
      const p = pruefeBewertung(roh);
      if (p.ok) return { bewertung: maskiereBewertung(p.wert), fehler: null, tokensEin: ein, tokensAus: aus, aufrufe };
      letzterFehler = p.fehler.join('; ');
    } else if (!letzterFehler) letzterFehler = 'kein JSON in der Antwort';
    nutzer = `${nutzerPrompt(e)}\n\nDeine letzte Antwort war ungültig (${letzterFehler}). Antworte nur mit gültigem JSON nach Schema.`;
  }
  return { bewertung: null, fehler: letzterFehler, tokensEin: ein, tokensAus: aus, aufrufe };
}

/**
 * Zugangsdaten (Passwort, PIN, Kennwort …) verlassen den Server nicht und
 * stehen in keinem Report (C5). Nachlauf 27.10.2026: Ein weitergeleitetes
 * Portal-Passwort stand im Vorschlag. Ersetzt wird der Wert hinter dem Stichwort.
 */
const ZUGANG = /\b(pw|passwort|kennwort|password|passcode|pin|zugangscode|freischaltcode|tan)(\s*[:=]\s*|\s+(?:lautet|ist)\s+)("[^"]*"|'[^']*'|[^\s,;)]+)/gi;
export function ohneZugangsdaten(t: string): string {
  return t.replace(ZUGANG, (_m, wort, trenn) => `${wort}${trenn}[entfernt]`);
}

/** Alles, was das Modell schreibt, geht in Report, Dropbox und Telegram — ohne volle IBAN (C5). */
export function maskiereBewertung(b: Bewertung): Bewertung {
  const maskiere = (t: string) => ohneZugangsdaten(maskiereIban(t));
  return {
    ...b,
    begruendung: maskiere(b.begruendung),
    vorgang: { ...b.vorgang, titel: maskiere(b.vorgang.titel) },
    fakten: { ...b.fakten, nummern: b.fakten.nummern.map(maskiere), betraege: b.fakten.betraege.map((x) => ({ ...x, bezeichnung: maskiere(x.bezeichnung) })) },
    erwartet: b.erwartet ? maskiere(b.erwartet) : null,
    naechsterSchritt: maskiere(b.naechsterSchritt),
  };
}

/** Geschätzte Kosten (Listenpreis claude-sonnet-4-6: 3 $ / 15 $ je Mio. Tokens). */
export function kostenUsd(ein: number, aus: number): number {
  return Math.round(((ein * 3 + aus * 15) / 1_000_000) * 10000) / 10000;
}

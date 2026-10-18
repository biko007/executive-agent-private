/**
 * reise-import — eine Reisedatei des Reiseassistenten pruefen und uebernehmen.
 *
 * Der Reiseassistent (Claude-Projekt „Reisen") arbeitet in einer Cloud-Sitzung
 * mit Dropbox-Connector und hat keinen Zugriff auf den VPS. Er legt je Reise
 * eine JSON-Datei in Dropbox ab; dieses Modul prueft sie und formt daraus die
 * Reisedatei, die das Dashboard liest.
 *
 * **Ein Ort fuer Owner und Assistent: `/Austausch/reisen/`.** Dort liegen
 * ohnehin das lebende Reisedokument und die Original-PDFs, und nur der Owner
 * kann Binaerdateien ablegen. Erreichbar ist der Ordner ueber den
 * Vollzugriff-Adapter (`dropboxVollzugang`, App „BikosOpenClawFA", Basis
 * leer, also Kontowurzel). Der App-Ordner-Token sieht `/Austausch` nicht —
 * daher der frueher angenommene, falsche Schluss, der Server koenne den
 * Ordner ueberhaupt nicht lesen (Korrektur 18.10.2026).
 *
 * `transfer/reisen/` im App-Ordner bleibt als **alter** zweiter Weg lesbar,
 * damit bereits abgelegte Dateien nicht liegenbleiben.
 *
 * Grundsaetze:
 *
 *   - **Pflicht ist wenig:** Kennung, Titel, Zeitraum. Alles andere darf
 *     fehlen und wird dann im Dashboard nicht gezeigt.
 *   - **Keine Pass- und Kartennummern.** Felder mit solchen Namen werden
 *     abgewiesen, nicht stillschweigend uebernommen.
 *   - **Version entscheidet:** Eine Datei mit gleicher oder kleinerer
 *     Versionsnummer ersetzt eine vorhandene Reise nicht. So kann der
 *     Assistent dieselbe Datei zweimal ablegen, ohne Schaden anzurichten.
 */

import path from 'node:path';
import { SCHEMA } from './types.js';
import type {
  ReiseDatei, Pruefbefund, Dokument, Flug, Frist,
} from './types.js';

export * from './types.js';

/**
 * Der Ordner, in dem Owner und Reiseassistent arbeiten. Pfad ab der
 * Kontowurzel — nur ueber den Vollzugriff-Adapter erreichbar.
 */
export const DROPBOX_AUSTAUSCH = '/Austausch/reisen';
export const DROPBOX_AUSTAUSCH_DOKUMENTE = `${DROPBOX_AUSTAUSCH}/dokumente`;
export const DROPBOX_AUSTAUSCH_DONE = `${DROPBOX_AUSTAUSCH}/done`;

/** Alter Weg im Dropbox-App-Ordner. Wird weiter gelesen, aber nicht beworben. */
export const DROPBOX_REISEN = '/bikosoc-reports/transfer/reisen';
export const DROPBOX_REISEN_DOKUMENTE = `${DROPBOX_REISEN}/dokumente`;
export const DROPBOX_REISEN_DONE = `${DROPBOX_REISEN}/done`;

/** Unterordner in der Dokumentenablage des Dashboards. */
export const DOKUMENTE_KATEGORIE = 'reise';

/** Feldnamen, die niemals in einer Reisedatei stehen duerfen. */
const VERBOTEN = /(pass(nummer|nr|port)|ausweisnummer|kartennummer|card_?number|iban|cvv|pin)/i;

const ISO_DATUM = /^\d{4}-\d{2}-\d{2}$/;
const KENNUNG = /^\d{6}-trip-[a-z0-9-]{2,30}$/;

/** Rekursiv nach verbotenen Feldnamen suchen. */
export function verboteneFelder(wert: unknown, pfad = ''): string[] {
  if (Array.isArray(wert)) {
    return wert.flatMap((w, i) => verboteneFelder(w, `${pfad}[${i}]`));
  }
  if (wert && typeof wert === 'object') {
    const raus: string[] = [];
    for (const [k, v] of Object.entries(wert as Record<string, unknown>)) {
      const hier = pfad ? `${pfad}.${k}` : k;
      if (VERBOTEN.test(k)) raus.push(hier);
      raus.push(...verboteneFelder(v, hier));
    }
    return raus;
  }
  return [];
}

/**
 * Eine Reisedatei pruefen.
 *
 * Fehler verhindern die Uebernahme, Warnungen nicht — eine Reise ohne Fluege
 * ist in der Planungsphase normal.
 */
export function pruefeReise(roh: unknown): Pruefbefund {
  const fehler: string[] = [];
  const warnungen: string[] = [];

  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) {
    return { ok: false, fehler: ['Die Datei enthält kein Objekt.'], warnungen };
  }
  const r = roh as Partial<ReiseDatei>;

  if (r.schema !== SCHEMA) {
    fehler.push(`Feld "schema" muss "${SCHEMA}" sein (gefunden: ${JSON.stringify(r.schema)}).`);
  }
  if (!r.id || !KENNUNG.test(String(r.id))) {
    fehler.push('Feld "id" fehlt oder folgt nicht der Form JJMMTT-trip-<ort>, '
      + 'etwa 261107-trip-winnipeg.');
  }
  if (!r.titel || String(r.titel).trim().length < 3) {
    fehler.push('Feld "titel" fehlt.');
  }
  for (const feld of ['von', 'bis'] as const) {
    if (!r[feld] || !ISO_DATUM.test(String(r[feld]))) {
      fehler.push(`Feld "${feld}" fehlt oder ist kein Datum der Form JJJJ-MM-TT.`);
    }
  }
  if (r.von && r.bis && ISO_DATUM.test(String(r.von)) && ISO_DATUM.test(String(r.bis))
      && String(r.bis) < String(r.von)) {
    fehler.push('"bis" liegt vor "von".');
  }
  if (r.version !== undefined && (!Number.isInteger(r.version) || Number(r.version) < 1)) {
    fehler.push('Feld "version" muss eine ganze Zahl ab 1 sein.');
  }

  const verboten = verboteneFelder(roh);
  if (verboten.length) {
    fehler.push('Felder mit Ausweis-, Karten- oder Kontodaten sind nicht erlaubt: '
      + verboten.join(', '));
  }

  for (const [i, f] of (r.fluege ?? []).entries()) {
    if (!f?.datum || !ISO_DATUM.test(String(f.datum))) {
      fehler.push(`fluege[${i}]: "datum" fehlt oder ist kein Datum der Form JJJJ-MM-TT.`);
    }
    if (!f?.flugnummer) fehler.push(`fluege[${i}]: "flugnummer" fehlt.`);
    if (!f?.von || !f?.nach) fehler.push(`fluege[${i}]: "von" und "nach" sind Pflicht.`);
  }
  for (const [i, d] of (r.dokumente ?? []).entries()) {
    if (!d?.titel) fehler.push(`dokumente[${i}]: "titel" fehlt.`);
    if (d?.datei && path.basename(String(d.datei)) !== String(d.datei)) {
      fehler.push(`dokumente[${i}]: "datei" darf nur ein Dateiname sein, kein Pfad.`);
    }
  }
  for (const [i, f] of (r.fristen ?? []).entries()) {
    if (!f?.faellig || !ISO_DATUM.test(String(f.faellig))) {
      fehler.push(`fristen[${i}]: "faellig" fehlt oder ist kein Datum der Form JJJJ-MM-TT.`);
    }
    if (!f?.titel) fehler.push(`fristen[${i}]: "titel" fehlt.`);
  }

  if (!(r.fluege ?? []).length) warnungen.push('Keine Flüge angegeben.');
  if (!(r.dokumente ?? []).length) warnungen.push('Keine Dokumente angegeben.');
  if (r.meilen && !r.meilen.quelle) {
    warnungen.push('Meilen ohne "quelle" — im Dashboard steht dann „Quelle offen".');
  }

  return { ok: fehler.length === 0, fehler, warnungen };
}

// ── Abbildung auf die Reisedatei des Dashboards ────────────────────────────

/** Klima des Dashboards; unbekannte Angaben werden zu `temperate`. */
const KLIMA = ['tropical', 'temperate', 'cold', 'desert', 'mixed'];
const ZWECK = ['business', 'leisure', 'outdoor', 'beach', 'city'];

/** Ein Flug als Segment, damit der Kalenderabgleich unverändert arbeitet. */
export function flugAlsSegment(f: Flug, nummer: number): Record<string, unknown> {
  return {
    id: `flug-${nummer}`,
    type: 'flight',
    datetime_local: f.ab_ortszeit ? `${f.datum} ${f.ab_ortszeit}` : f.datum,
    datetime_utc: '',
    timezone: '',
    title: `${f.flugnummer} ${f.von} → ${f.nach}`,
    notes: [f.betrieben_von && `Betrieben von ${f.betrieben_von}`, f.notiz]
      .filter(Boolean).join(' · ') || undefined,
    /* Die Felder darunter sind neu und nur fuer die Anzeige. Der
       Kalenderabgleich liest sie nicht. */
    flug: f,
  };
}

/**
 * Aus der Austauschdatei die Reisedatei des Dashboards bauen.
 *
 * `vorhanden` ist die bisherige Fassung, falls es eine gibt — Erstellungsdatum
 * und Kalenderkennungen bleiben dadurch erhalten.
 *
 * `uebernommeneDateien` sind die Dateinamen der PDFs, die tatsaechlich in der
 * Dokumentenablage liegen. Nur diese bekommen ein Feld `pfad`; das Dashboard
 * zeigt den Knopf „PDF oeffnen" genau dann, wenn dieses Feld gesetzt ist. Wird
 * der Parameter weggelassen, gilt jede genannte Datei als vorhanden.
 */
export function nachTrip(
  r: ReiseDatei, vorhanden: Record<string, unknown> | null, jetztIso: string,
  uebernommeneDateien?: string[],
): Record<string, unknown> {
  const segmente = (r.fluege ?? []).map((f, i) => flugAlsSegment(f, i + 1));
  /* Kalenderkennungen der bisherigen Segmente uebernehmen, soweit Titel und
     Zeit gleich geblieben sind — sonst entstehen beim Abgleich Doppel. */
  const alt = (vorhanden?.segments as Array<Record<string, unknown>> | undefined) ?? [];
  for (const s of segmente) {
    const treffer = alt.find((a) => a.title === s.title && a.datetime_local === s.datetime_local);
    if (treffer?.calendarEventId) {
      s.calendarEventId = treffer.calendarEventId;
      s.calendarWebLink = treffer.calendarWebLink;
    }
  }

  return {
    ...(vorhanden ?? {}),
    id: r.id,
    name: r.titel,
    destination: r.ziel ?? '',
    country_code: r.land ?? '',
    start_date: r.von,
    end_date: r.bis,
    climate: KLIMA.includes(String(r.klima)) ? r.klima : 'temperate',
    activities: (r.zweck ?? []).filter((z) => ZWECK.includes(z)).length
      ? (r.zweck ?? []).filter((z) => ZWECK.includes(z))
      : ['business'],
    segments: segmente,
    calendar_event_ids: (vorhanden?.calendar_event_ids as string[] | undefined) ?? [],
    created_at: (vorhanden?.created_at as string | undefined) ?? jetztIso,
    updated_at: jetztIso,
    /* Der Reiseblock: alles, was der Reisen-Tab zusaetzlich zeigt. In einem
       eigenen Feld, damit die bestehenden Felder unberuehrt bleiben. */
    reise: {
      schema: SCHEMA,
      version: r.version ?? 1,
      chips: r.chips ?? [],
      buchungen: r.buchungen ?? [],
      fluege: r.fluege ?? [],
      umstiege: r.umstiege ?? [],
      dokumente: dokumenteMitPfad(r, uebernommeneDateien),
      fristen: sortiereFristen(r.fristen ?? []),
      einreise: r.einreise ?? [],
      kontakte: r.kontakte ?? [],
      meilen: r.meilen ?? null,
      offen: r.offen ?? [],
      notiz: r.notiz ?? '',
      quelle_md: r.quelle_md ?? '',
      importiert_am: jetztIso,
    },
  };
}

/**
 * Dokumente um das Feld `pfad` ergaenzen — den Pfad in der Dokumentenablage
 * des Dashboards, relativ zu `DOCS_DIR`. Der Pfad steht nur dort, wo die Datei
 * wirklich liegt, damit die Oberflaeche keinen toten Knopf zeigt.
 */
export function dokumenteMitPfad(r: ReiseDatei, uebernommene?: string[]): Dokument[] {
  return (r.dokumente ?? []).map((d) => {
    if (!d.datei) return d;
    if (uebernommene && !uebernommene.includes(String(d.datei))) return d;
    return { ...d, pfad: dokumentZiel(r.id, String(d.datei)) };
  });
}

export function sortiereFristen(fristen: Frist[]): Frist[] {
  return [...fristen].sort((a, b) => a.faellig.localeCompare(b.faellig));
}

/**
 * Soll die vorhandene Reise ersetzt werden?
 *
 * Nur bei hoeherer Version. Fehlt die Version auf einer Seite, gilt 1.
 */
export function ersetzen(
  neu: ReiseDatei, vorhanden: Record<string, unknown> | null,
): { ersetzen: boolean; grund: string } {
  if (!vorhanden) return { ersetzen: true, grund: 'neue Reise' };
  const alteVersion = Number(
    (vorhanden.reise as Record<string, unknown> | undefined)?.version ?? 1);
  const neueVersion = Number(neu.version ?? 1);
  if (neueVersion > alteVersion) {
    return { ersetzen: true, grund: `Version ${alteVersion} → ${neueVersion}` };
  }
  return {
    ersetzen: false,
    grund: `Version ${neueVersion} ist nicht höher als die vorhandene ${alteVersion}`,
  };
}

/** Zielname eines Dokuments in der Dokumentenablage des Dashboards. */
export function dokumentZiel(reiseId: string, datei: string): string {
  const sauber = path.basename(datei).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(DOKUMENTE_KATEGORIE, `${reiseId}__${sauber}`);
}

/** Dokumente, die eine Datei mitbringen — nur die werden uebernommen. */
export function dokumenteMitDatei(r: ReiseDatei): Dokument[] {
  return (r.dokumente ?? []).filter((d) => Boolean(d.datei));
}

/** Kurzfassung eines Laufs fuer Protokoll und Report. */
export interface ImportErgebnis {
  datei: string;
  /** Aus welchem Ordner die Datei kam — fuer Protokoll und Report. */
  quelle?: string;
  id?: string;
  uebernommen: boolean;
  grund: string;
  fehler: string[];
  warnungen: string[];
  dokumente: Array<{ datei: string; ziel: string; bytes: number }>;
  fehlendeDokumente: string[];
}

export function ergebnisText(e: ImportErgebnis): string {
  if (!e.uebernommen) {
    return `${e.datei}: nicht übernommen — ${e.grund}`
      + (e.fehler.length ? ` (${e.fehler.join('; ')})` : '');
  }
  return `${e.datei}: ${e.id} übernommen (${e.grund})`
    + `, ${e.dokumente.length} Dokument(e)`
    + e.fehlendeDokumente.map((d) => `, PDF fehlt: ${d}`).join('');
}

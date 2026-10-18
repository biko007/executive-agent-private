import { describe, expect, test } from 'bun:test';
import {
  SCHEMA, verboteneFelder, pruefeReise, flugAlsSegment, nachTrip, sortiereFristen,
  ersetzen, dokumentZiel, dokumenteMitDatei, dokumenteMitPfad, ergebnisText,
  DROPBOX_REISEN, DROPBOX_REISEN_DOKUMENTE, DROPBOX_REISEN_DONE, DOKUMENTE_KATEGORIE,
  type ReiseDatei, type ImportErgebnis,
} from '../index.js';

/** Kleinste Reise, die durch die Pruefung kommt. */
function minimal(): ReiseDatei {
  return {
    schema: SCHEMA, id: '261107-trip-winnipeg', titel: 'Winnipeg',
    von: '2026-11-07', bis: '2026-11-25',
  };
}

// ── Pflichtfelder ──────────────────────────────────────────────────────────

describe('pruefeReise — Pflichtfelder', () => {
  test('die kleinste Reise genuegt', () => {
    const b = pruefeReise(minimal());
    expect(b.ok).toBe(true);
    expect(b.fehler).toEqual([]);
  });

  test('fehlende Pflichtfelder werden einzeln genannt', () => {
    const b = pruefeReise({ schema: SCHEMA });
    expect(b.ok).toBe(false);
    expect(b.fehler.some((f) => f.includes('"id"'))).toBe(true);
    expect(b.fehler.some((f) => f.includes('"titel"'))).toBe(true);
    expect(b.fehler.some((f) => f.includes('"von"'))).toBe(true);
    expect(b.fehler.some((f) => f.includes('"bis"'))).toBe(true);
  });

  test('falsches Schema wird abgewiesen', () => {
    expect(pruefeReise({ ...minimal(), schema: 'bikosoc.reise/9' }).ok).toBe(false);
  });

  test('Kennung muss der Form JJMMTT-trip-<ort> folgen', () => {
    expect(pruefeReise({ ...minimal(), id: 'winnipeg' }).ok).toBe(false);
    expect(pruefeReise({ ...minimal(), id: '2611-trip-winnipeg' }).ok).toBe(false);
    expect(pruefeReise({ ...minimal(), id: '261107-trip-ab' }).ok).toBe(true);
  });

  test('"bis" vor "von" ist ein Fehler', () => {
    const b = pruefeReise({ ...minimal(), von: '2026-11-25', bis: '2026-11-07' });
    expect(b.ok).toBe(false);
    expect(b.fehler.join(' ')).toContain('liegt vor');
  });

  test('kein Objekt, kein Import', () => {
    expect(pruefeReise('text').ok).toBe(false);
    expect(pruefeReise([]).ok).toBe(false);
    expect(pruefeReise(null).ok).toBe(false);
  });

  test('Version muss eine ganze Zahl ab 1 sein', () => {
    expect(pruefeReise({ ...minimal(), version: 0 }).ok).toBe(false);
    expect(pruefeReise({ ...minimal(), version: 1.5 }).ok).toBe(false);
    expect(pruefeReise({ ...minimal(), version: 3 }).ok).toBe(true);
  });
});

// ── Ausweis- und Kartendaten ───────────────────────────────────────────────

describe('verbotene Felder', () => {
  test('findet Passnummer in der Tiefe', () => {
    const treffer = verboteneFelder({ a: { b: [{ passnummer: 'X' }] } });
    expect(treffer).toEqual(['a.b[0].passnummer']);
  });

  test('erkennt die weiteren Schreibweisen', () => {
    const treffer = verboteneFelder({
      passport: 1, ausweisnummer: 2, kartennummer: 3, card_number: 4, iban: 5, cvv: 6,
    });
    expect(treffer.length).toBe(6);
  });

  test('harmlose Felder bleiben unberuehrt', () => {
    expect(verboteneFelder({ ticket: 'x', code: 'y', karte_letzte4: '3542' })).toEqual([]);
  });

  test('eine Reise mit Passnummer wird nicht uebernommen', () => {
    const b = pruefeReise({ ...minimal(), reisende: [{ passnummer: 'C01X00T47' }] });
    expect(b.ok).toBe(false);
    expect(b.fehler.join(' ')).toContain('Ausweis-, Karten- oder Kontodaten');
  });
});

// ── Teilstrukturen ─────────────────────────────────────────────────────────

describe('pruefeReise — Fluege, Dokumente, Fristen', () => {
  test('Flug ohne Flugnummer oder Strecke ist ein Fehler', () => {
    const b = pruefeReise({
      ...minimal(),
      fluege: [{ datum: '2026-11-07', von: 'ZRH' }],
    });
    expect(b.ok).toBe(false);
    expect(b.fehler.join(' ')).toContain('fluege[0]');
  });

  test('"datei" darf kein Pfad sein', () => {
    const b = pruefeReise({
      ...minimal(),
      dokumente: [{ art: 'esta', titel: 'ESTA', datei: 'unterordner/esta.pdf' }],
    });
    expect(b.ok).toBe(false);
    expect(b.fehler.join(' ')).toContain('nur ein Dateiname');
  });

  test('Frist ohne ISO-Datum ist ein Fehler', () => {
    const b = pruefeReise({ ...minimal(), fristen: [{ faellig: '31.10.2026', titel: 'x' }] });
    expect(b.ok).toBe(false);
  });

  test('fehlende Fluege und Dokumente sind nur Hinweise', () => {
    const b = pruefeReise(minimal());
    expect(b.ok).toBe(true);
    expect(b.warnungen.length).toBe(2);
  });

  test('Meilen ohne Quelle geben einen Hinweis, keinen Fehler', () => {
    const b = pruefeReise({ ...minimal(), meilen: { programm: 'Miles & More' } });
    expect(b.ok).toBe(true);
    expect(b.warnungen.join(' ')).toContain('quelle');
  });
});

// ── Abbildung auf die Reisedatei des Dashboards ────────────────────────────

describe('nachTrip', () => {
  const reise: ReiseDatei = {
    ...minimal(),
    ziel: 'Winnipeg', land: 'CA', klima: 'cold', zweck: ['business'],
    fluege: [
      { datum: '2026-11-07', flugnummer: 'LX4640', von: 'ZRH', nach: 'YYZ',
        ab_ortszeit: '13:20', betrieben_von: 'Air Canada (AC881)' },
      { datum: '2026-11-24', flugnummer: 'LX41', von: 'LAX', nach: 'ZRH' },
    ],
    dokumente: [
      { art: 'esta', titel: 'ESTA USA', datei: '2026-07-16_ESTA_USA.pdf' },
      { art: 'sonstiges', titel: 'ohne Datei' },
    ],
    fristen: [
      { faellig: '2026-11-07', titel: 'Abfahrt' },
      { faellig: '2026-10-31', titel: 'LX41 pruefen' },
    ],
  };

  test('Flug wird zum Segment mit sprechendem Titel', () => {
    const s = flugAlsSegment(reise.fluege![0], 1);
    expect(s.id).toBe('flug-1');
    expect(s.type).toBe('flight');
    expect(s.title).toBe('LX4640 ZRH → YYZ');
    expect(s.datetime_local).toBe('2026-11-07 13:20');
    expect(s.notes).toContain('Air Canada');
  });

  test('ohne Abflugzeit bleibt nur das Datum stehen', () => {
    expect(flugAlsSegment(reise.fluege![1], 2).datetime_local).toBe('2026-11-24');
  });

  test('Kernfelder und Reiseblock werden gesetzt', () => {
    const t = nachTrip(reise, null, '2026-10-18T19:00:00.000Z');
    expect(t.id).toBe('261107-trip-winnipeg');
    expect(t.name).toBe('Winnipeg');
    expect(t.start_date).toBe('2026-11-07');
    expect((t.segments as unknown[]).length).toBe(2);
    expect((t.reise as Record<string, unknown>).schema).toBe(SCHEMA);
    expect(t.created_at).toBe('2026-10-18T19:00:00.000Z');
  });

  test('unbekanntes Klima faellt auf temperate zurueck', () => {
    const t = nachTrip({ ...reise, klima: 'eisig' }, null, 'jetzt');
    expect(t.climate).toBe('temperate');
  });

  test('Fristen werden nach Datum sortiert', () => {
    const t = nachTrip(reise, null, 'jetzt');
    const fristen = (t.reise as any).fristen;
    expect(fristen.map((f: any) => f.faellig)).toEqual(['2026-10-31', '2026-11-07']);
  });

  test('Erstellungsdatum und Kalenderkennung bleiben erhalten', () => {
    const alt = {
      created_at: '2026-01-01T00:00:00.000Z',
      calendar_event_ids: ['abc'],
      segments: [{ title: 'LX4640 ZRH → YYZ', datetime_local: '2026-11-07 13:20',
        calendarEventId: 'ev-1', calendarWebLink: 'https://kalender/ev-1' }],
    };
    const t = nachTrip(reise, alt, 'jetzt');
    expect(t.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(t.calendar_event_ids).toEqual(['abc']);
    expect((t.segments as any[])[0].calendarEventId).toBe('ev-1');
    expect((t.segments as any[])[1].calendarEventId).toBeUndefined();
  });

  test('nur uebernommene Dateien bekommen einen Pfad', () => {
    const t = nachTrip(reise, null, 'jetzt', ['2026-07-16_ESTA_USA.pdf']);
    const dok = (t.reise as any).dokumente;
    expect(dok[0].pfad).toBe('reise/261107-trip-winnipeg__2026-07-16_ESTA_USA.pdf');
    expect(dok[1].pfad).toBeUndefined();
  });

  test('eine fehlende Datei bekommt keinen Pfad', () => {
    const dok = dokumenteMitPfad(reise, []);
    expect(dok[0].pfad).toBeUndefined();
  });

  test('ohne Angabe gilt jede genannte Datei als vorhanden', () => {
    const dok = dokumenteMitPfad(reise);
    expect(dok[0].pfad).toContain('261107-trip-winnipeg__');
  });
});

describe('sortiereFristen', () => {
  test('veraendert die Vorlage nicht', () => {
    const eingabe = [{ faellig: '2026-12-01', titel: 'b' }, { faellig: '2026-01-01', titel: 'a' }];
    const raus = sortiereFristen(eingabe);
    expect(raus[0].titel).toBe('a');
    expect(eingabe[0].titel).toBe('b');
  });
});

// ── Versionsregel ──────────────────────────────────────────────────────────

describe('ersetzen', () => {
  test('eine neue Reise wird immer uebernommen', () => {
    expect(ersetzen(minimal(), null).ersetzen).toBe(true);
  });

  test('gleiche Version ersetzt nicht', () => {
    const e = ersetzen({ ...minimal(), version: 1 }, { reise: { version: 1 } });
    expect(e.ersetzen).toBe(false);
    expect(e.grund).toContain('nicht höher');
  });

  test('kleinere Version ersetzt nicht', () => {
    expect(ersetzen({ ...minimal(), version: 2 }, { reise: { version: 5 } }).ersetzen).toBe(false);
  });

  test('hoehere Version ersetzt', () => {
    const e = ersetzen({ ...minimal(), version: 2 }, { reise: { version: 1 } });
    expect(e.ersetzen).toBe(true);
    expect(e.grund).toBe('Version 1 → 2');
  });

  test('fehlende Version gilt als 1', () => {
    expect(ersetzen(minimal(), { reise: {} }).ersetzen).toBe(false);
    expect(ersetzen({ ...minimal(), version: 2 }, {}).ersetzen).toBe(true);
  });
});

// ── Dokumentenablage ───────────────────────────────────────────────────────

describe('dokumentZiel', () => {
  test('Kennung und Dateiname ergeben einen eindeutigen Namen', () => {
    expect(dokumentZiel('261107-trip-winnipeg', 'esta.pdf'))
      .toBe('reise/261107-trip-winnipeg__esta.pdf');
  });

  test('Pfadanteile werden abgeschnitten', () => {
    expect(dokumentZiel('261107-trip-winnipeg', '../../etc/passwd'))
      .toBe('reise/261107-trip-winnipeg__passwd');
  });

  test('Sonderzeichen werden ersetzt', () => {
    expect(dokumentZiel('261107-trip-winnipeg', 'eTA Kanada (neu).pdf'))
      .toBe('reise/261107-trip-winnipeg__eTA_Kanada__neu_.pdf');
  });

  test('nur Dokumente mit Datei werden uebernommen', () => {
    const r: ReiseDatei = {
      ...minimal(),
      dokumente: [{ art: 'esta', titel: 'a', datei: 'a.pdf' }, { art: 'esta', titel: 'b' }],
    };
    expect(dokumenteMitDatei(r).length).toBe(1);
  });
});

// ── Pfade und Protokoll ────────────────────────────────────────────────────

describe('Pfade und Protokoll', () => {
  test('die Dropbox-Pfade liegen im App-Ordner', () => {
    expect(DROPBOX_REISEN).toBe('/bikosoc-reports/transfer/reisen');
    expect(DROPBOX_REISEN_DOKUMENTE).toBe('/bikosoc-reports/transfer/reisen/dokumente');
    expect(DROPBOX_REISEN_DONE).toBe('/bikosoc-reports/transfer/reisen/done');
    expect(DOKUMENTE_KATEGORIE).toBe('reise');
  });

  test('Erfolgsmeldung nennt Kennung und Dokumentenzahl', () => {
    const e: ImportErgebnis = {
      datei: 'x.json', id: '261107-trip-winnipeg', uebernommen: true, grund: 'neue Reise',
      fehler: [], warnungen: [], fehlendeDokumente: [],
      dokumente: [{ datei: 'a.pdf', ziel: 'reise/a.pdf', bytes: 10 }],
    };
    expect(ergebnisText(e)).toBe(
      'x.json: 261107-trip-winnipeg übernommen (neue Reise), 1 Dokument(e)');
  });

  test('fehlende Dokumente stehen in der Meldung', () => {
    const e: ImportErgebnis = {
      datei: 'x.json', id: '261107-trip-winnipeg', uebernommen: true, grund: 'neue Reise',
      fehler: [], warnungen: [], dokumente: [], fehlendeDokumente: ['esta.pdf'],
    };
    expect(ergebnisText(e)).toContain('fehlend: esta.pdf');
  });

  test('Misserfolg nennt Grund und Fehler', () => {
    const e: ImportErgebnis = {
      datei: 'x.json', uebernommen: false, grund: 'Prüfung fehlgeschlagen',
      fehler: ['Feld "titel" fehlt.'], warnungen: [], dokumente: [], fehlendeDokumente: [],
    };
    expect(ergebnisText(e)).toContain('nicht übernommen — Prüfung fehlgeschlagen');
    expect(ergebnisText(e)).toContain('Feld "titel" fehlt.');
  });
});

/**
 * Hinweise zu wiederkehrenden Eingaengen ohne Mietvertrag.
 *
 * Anlass: Marktgasse 22 hat drei Garagen; zwei nutzt die bikolino GmbH selbst,
 * eine ist an die Stadt Tuttlingen vermietet. Solange der Owner die Zuordnung
 * nicht entschieden hat, darf keiner dieser Eingaenge als Mietrueckstand
 * gelten — in der Umsatzanzeige steht stattdessen der hinterlegte Hinweis.
 */
import { describe, test, expect } from 'bun:test';
import { hinweisFuer, type Zuordnungshinweis } from '../store.js';

const HINWEISE: Record<string, Zuordnungshinweis> = {
  'garage-marktgasse-22': {
    label: 'Garage Marktgasse 22 – Vertrag nicht angelegt',
    muster: { zweck: ['garage'], name: ['kleiner', 'stadt tuttlingen'] },
  },
  'kein-mietvertrag-in-bikosoc': {
    label: 'kein Mietvertrag in bikosoc',
    muster: { name: ['weinhold'] },
  },
  'take-off-gewerbepark-28': {
    label: 'privat (abc-raum), kein Mietobjekt',
    muster: { zweck: ['take off gewerbepark 28'] },
  },
  'nur-text-kein-muster': { },
};

describe('Zuordnungshinweis', () => {
  test('trifft beide Garagenzahler der Marktgasse 22', () => {
    expect(hinweisFuer(HINWEISE, 'Stadt Tuttlingen', '/MIETE GARAGE Miete Garage Marktg.22 f. NW'))
      .toBe('Garage Marktgasse 22 – Vertrag nicht angelegt');
    expect(hinweisFuer(HINWEISE, 'Klaus Kleiner und Iris Kleiner', 'Miete GarageMarktgasse'))
      .toBe('Garage Marktgasse 22 – Vertrag nicht angelegt');
  });
  test('trifft nicht die Garage im Mietvertrag L19 W1', () => {
    /* Andre Deiss zahlt 1.645,00 EUR mit „Miete 1220 + Kueche 50 + Garage 75
       + NK 300". Das ist eine Miete und gehoert zum Vertrag — kein Hinweis. */
    expect(hinweisFuer(HINWEISE, 'Andre Deiß', 'Miete 1220 + Küche 50 + Garage 75 +NK 300'))
      .toBeNull();
  });
  test('trifft nicht andere Zahlungen derselben Gegenseite', () => {
    expect(hinweisFuer(HINWEISE, 'Stadt Tuttlingen', '501000041156/Grundsteuer B 2026')).toBeNull();
  });
  test('Muster nur ueber den Namen genuegt', () => {
    expect(hinweisFuer(HINWEISE, 'H.-J. Weinhold GmbH Chirurgie- und', 'Miete'))
      .toBe('kein Mietvertrag in bikosoc');
  });
  test('Muster nur ueber den Zweck genuegt, Punkte und Umlaute stoeren nicht', () => {
    expect(hinweisFuer(HINWEISE, 'Stadtwerke Tuttlingen GmbH',
      '7844 DTAUS Rechnung 37135/Take-Off Gewerbepark 28, 78579 Neuhausen ob Eck'))
      .toBe('privat (abc-raum), kein Mietobjekt');
  });
  test('ohne Muster oder Label kein Hinweis', () => {
    expect(hinweisFuer(HINWEISE, 'Elena Lazic', 'Miete Elena Lazic')).toBeNull();
    expect(hinweisFuer({}, 'Stadt Tuttlingen', 'Miete Garage Marktg.22')).toBeNull();
  });
});

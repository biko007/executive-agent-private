/**
 * Reise-Etappen als M365-Termine (Vorschlag 4c, Stufe 2; Owner-Freigabe 07.11.2026).
 * Kalender ist eine Attrappe — kein Netz.
 */
import { describe, test, expect } from 'bun:test';
import {
  planeTermine, kalenderAbgleich, kalenderEntfernen, ortszeitNachUtc, zoneVonFlughafen,
  markerAus, graphTermin, idsUebernehmen, type KalenderApi, type ReiseFuerKalender,
} from '../index.js';

function reise(version = 16): ReiseFuerKalender {
  return {
    id: '261107-trip-winnipeg', start_date: '2026-11-07', end_date: '2026-11-25',
    reise: {
      version,
      fluege: [
        { datum: '2026-11-07', flugnummer: 'LX4640', von: 'ZRH', ab_ortszeit: '13:20', nach: 'YYZ', nach_terminal: 'T1', an_ortszeit: '16:15' },
        { datum: '2026-11-07', flugnummer: 'AC269', von: 'YYZ', von_terminal: 'T1', ab_ortszeit: '19:25', nach: 'YWG', an_ortszeit: '22:14' },
        { datum: '2026-11-24', flugnummer: 'LX41', von: 'LAX', ab_ortszeit: '19:30', nach: 'ZRH', an_ortszeit: '15:35', an_datum: '2026-11-25' },
      ],
      umstiege: [{ flughafen: 'YYZ Toronto', dauer: '3 h 10', backup: 'Porter PD427' }],
      buchungen: [
        { code: 'YV6ZJL', anbieter: 'SWISS', art: 'flug', notiz: 'Business Flex auf allen drei Segmenten' },
        { code: 'SF2026', anbieter: 'QCon Training A', art: 'termin', ort: 'San Francisco', von: '2026-11-19', zeit_von: '09:00', zeit_bis: '12:00' },
        { code: 'AGI', anbieter: 'AGI Summit Tag 1', art: 'termin', ort: 'Santa Clara', von: '2026-11-21', zeit_von: '09:00' },
        { code: 'H1', anbieter: 'Hyatt', art: 'hotel', von: '2026-11-15', bis: '2026-11-19' },
      ],
      fristen: [
        { faellig: '2026-11-09', titel: 'Online-Check-in Air Canada öffnet', art: 'termin', status: 'offen' },
        { faellig: '2026-11-10', titel: 'Hotel buchen', art: 'aufgabe', status: 'offen' },
        { faellig: '2026-11-06', titel: 'vor der Reise', art: 'termin', status: 'offen' },
        { faellig: '2026-11-21', titel: 'erledigter Termin', art: 'termin', status: 'erledigt' },
      ],
    },
  };
}

/** Kalender-Attrappe: zählt Schreibzugriffe. */
function attrappe(vorher: Array<{ id: string; text: string; betreff?: string }> = []) {
  const termine = new Map(vorher.map(t => [t.id, { ...t }]));
  let n = 0;
  const log: string[] = [];
  const api: KalenderApi = {
    imZeitraum: async () => [...termine.values()],
    lies: async (id) => termine.get(id) ?? null,
    anlegen: async (p: any) => { const id = `neu-${++n}`; termine.set(id, { id, text: p.body.content, betreff: p.subject }); log.push(`anlegen ${p.subject}`); return id; },
    aendern: async (id, p: any) => { termine.set(id, { id, text: p.body.content, betreff: p.subject }); log.push(`aendern ${p.subject}`); },
    loeschen: async (id) => { termine.delete(id); log.push(`loeschen ${id}`); },
  };
  return { api, termine, log };
}

describe('Zeitzonen', () => {
  test('Flughafen → IANA', () => {
    for (const [iata, zone] of [['ZRH', 'Europe/Zurich'], ['YYZ', 'America/Toronto'], ['YWG', 'America/Winnipeg'], ['YVR', 'America/Vancouver'],
      ['YYJ', 'America/Vancouver'], ['SFO', 'America/Los_Angeles'], ['SJC', 'America/Los_Angeles'], ['LAX', 'America/Los_Angeles']]) {
      expect(zoneVonFlughafen(iata)).toBe(zone);
    }
    expect(zoneVonFlughafen('XYZ')).toBeNull();
  });
  test('Ortszeit → UTC, auch über Mitternacht und Winterzeit', () => {
    expect(ortszeitNachUtc('2026-11-07', '13:20', 'Europe/Zurich')).toBe('2026-11-07T12:20:00Z');
    expect(ortszeitNachUtc('2026-11-07', '16:15', 'America/Toronto')).toBe('2026-11-07T21:15:00Z');
    // Manitoba ab 01.11.2026 dauerhaft UTC−5 (tzdata 2026e); vorher hier fälschlich −6 erwartet
    expect(ortszeitNachUtc('2026-11-07', '22:14', 'America/Winnipeg')).toBe('2026-11-08T03:14:00Z');
    expect(ortszeitNachUtc('2026-11-24', '19:30', 'America/Los_Angeles')).toBe('2026-11-25T03:30:00Z');
    expect(ortszeitNachUtc('2026-07-01', '12:00', 'Europe/Zurich')).toBe('2026-07-01T10:00:00Z');
  });
});

describe('Planung', () => {
  const p = planeTermine(reise());
  const nach = (e: string) => p.find(t => t.etappe.startsWith(e))!;
  test('Flüge mit Abflug/Ankunft in Ortszeit, Betreff, Buchungscode', () => {
    const lx = nach('flug-lx4640');
    expect(lx.betreff).toBe('✈ LX4640 ZRH → YYZ');
    expect(lx.startUtc).toBe('2026-11-07T12:20:00Z');
    expect(lx.endeUtc).toBe('2026-11-07T21:15:00Z');
    expect(lx.ort).toBe('Flughafen Zürich (ZRH)');
    expect(lx.text).toContain('Buchungscode: YV6ZJL');
    expect(lx.text).toContain('Ankunft: YYZ T1 16:15');
    expect(nach('flug-lx41').endeUtc).toBe('2026-11-25T14:35:00Z');
  });
  test('Umstieg zwischen Ankunft und Weiterflug', () => {
    const u = nach('umstieg-yyz');
    expect(u.startUtc).toBe('2026-11-07T21:15:00Z');
    expect(u.endeUtc).toBe('2026-11-08T00:25:00Z');
  });
  test('Termine: mit Ende zeitlich, ohne Ende ganztägig (keine erfundene Dauer)', () => {
    const q = nach('termin-sf2026');
    expect(q.ganztags).toBe(false);
    expect(q.startUtc).toBe('2026-11-19T17:00:00Z');
    const agi = nach('termin-agi');
    expect(agi.ganztags).toBe(true);
    expect(agi.betreff).toBe('AGI Summit Tag 1 (ab 09:00)');
    expect(agi.tagVon).toBe('2026-11-21');
    expect(agi.tagBis).toBe('2026-11-22');
  });
  test('ganztägige Fristen in der Zone des Aufenthaltsorts (Anreisetag = Ausgangsort)', () => {
    const r = reise();
    r.reise!.fristen!.push({ faellig: '2026-11-07', titel: 'Abfahrt Tuttlingen', art: 'termin', status: 'offen' });
    const ts = planeTermine(r);
    expect(ts.find(t => t.betreff === 'Abfahrt Tuttlingen')!.zone).toBe('Europe/Zurich');
    expect(ts.find(t => t.betreff.startsWith('Online-Check-in'))!.zone).toBe('America/Winnipeg');
  });
  test('nur offene Fristen der Art termin im Reisezeitraum; keine Hotels, keine Aufgaben', () => {
    expect(p.filter(t => t.etappe.startsWith('frist-')).map(t => t.betreff)).toEqual(['Online-Check-in Air Canada öffnet']);
    expect(p.some(t => t.betreff.includes('Hyatt'))).toBe(false);
    expect(p.length).toBe(3 + 1 + 2 + 1);
  });
  test('unbekannter Flughafen → ganztägig mit Hinweis', () => {
    const r = reise();
    r.reise!.fluege!.push({ datum: '2026-11-15', flugnummer: 'XX1', von: 'YYJ', ab_ortszeit: '10:00', nach: 'QQQ', an_ortszeit: '12:00' });
    const t = planeTermine(r).find(x => x.etappe.startsWith('flug-xx1'))!;
    expect(t.ganztags).toBe(true);
    expect(t.hinweis).toContain('QQQ');
  });
  test('Graph-Nutzlast: UTC, Marker im Text', () => {
    const g: any = graphTermin('261107-trip-winnipeg', nach('flug-lx4640'));
    expect(g.start).toEqual({ dateTime: '2026-11-07T12:20:00', timeZone: 'UTC' });
    expect(markerAus(g.body.content)).toEqual({ reise: '261107-trip-winnipeg', etappe: 'flug-lx4640-2026-11-07', pruefwert: nach('flug-lx4640').pruefwert });
  });
});

describe('Abgleich mit dem Kalender', () => {
  test('erster Lauf legt alles an, zweiter ändert nichts (Idempotenz)', async () => {
    const k = attrappe();
    const erst = await kalenderAbgleich(reise(), k.api, { schreiben: true });
    expect(erst.plan.anlegen.length).toBe(7);
    expect(k.log.length).toBe(7);
    k.log.length = 0;
    const r2 = { ...reise(), calendar_event_ids: Object.values(erst.ids) };
    const zweit = await kalenderAbgleich(r2, k.api, { schreiben: true });
    expect(zweit.plan.anlegen.length + zweit.plan.aendern.length + zweit.plan.loeschen.length).toBe(0);
    expect(zweit.plan.gleich.length).toBe(7);
    expect(k.log).toEqual([]);
  });
  test('neue Version: geänderte Zeit wird geändert, entfallene Etappe gelöscht', async () => {
    const k = attrappe();
    const erst = await kalenderAbgleich(reise(), k.api, { schreiben: true });
    const neu = reise(17);
    neu.reise!.fluege = neu.reise!.fluege!.filter(f => f.flugnummer !== 'LX41');
    neu.calendar_event_ids = Object.values(erst.ids);
    k.log.length = 0;
    const e = await kalenderAbgleich(neu, k.api, { schreiben: true });
    expect(e.plan.loeschen.map(l => l.etappe)).toEqual(['flug-lx41-2026-11-24']);
    // Version steht im Text → übrige Termine werden aktualisiert, nicht neu angelegt
    expect(e.plan.anlegen.length).toBe(0);
    expect(k.log.filter(z => z.startsWith('loeschen')).length).toBe(1);
  });
  test('fremde Termine bleiben unberührt, auch beim Entfernen', async () => {
    const k = attrappe([
      { id: 'fremd-1', text: 'Zahnarzt', betreff: 'Zahnarzt' },
      { id: 'fremd-2', text: 'bikosoc:reise:261001-trip-andere:flug-x-2026-10-01 h=12345678', betreff: 'andere Reise' },
    ]);
    const e = await kalenderAbgleich(reise(), k.api, { schreiben: true });
    expect(e.plan.loeschen).toEqual([]);
    const weg = await kalenderEntfernen(reise(), k.api, { schreiben: true });
    expect(weg.geloescht.length).toBe(7);
    expect([...k.termine.keys()].sort()).toEqual(['fremd-1', 'fremd-2']);
  });
  test('Probe schreibt nichts', async () => {
    const k = attrappe();
    const e = await kalenderAbgleich(reise(), k.api, { schreiben: false });
    expect(e.plan.anlegen.length).toBe(7);
    expect(k.log).toEqual([]);
  });
  test('IDs landen in der Reisedatei', () => {
    const trip = { segments: [{ id: 'flug-1', flug: { datum: '2026-11-07', flugnummer: 'LX4640' }, calendarEventId: 'alt' }, { id: 'x' }], calendar_event_ids: ['alt'] };
    const t = idsUebernehmen(trip, { 'flug-lx4640-2026-11-07': 'neu-1', 'umstieg-yyz-2026-11-07': 'neu-2' });
    expect(t.segments[0].calendarEventId).toBe('neu-1');
    expect(t.calendar_event_ids).toEqual(['neu-1', 'neu-2']);
  });
});

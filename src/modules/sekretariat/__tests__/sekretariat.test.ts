import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pruefeBewertung, vorfilter, zweitesNetz, bewerteMitKi, verarbeite, ladeSpeicher, vorgangsZeilen,
  stundenReportSekretariat, telegramZeilen, mieterErsetzer, ohneZugangsdaten, vorgangsTabelle, wendeAn, speichereKorrektur,
  ladeKorrekturen, korrekturZeilen, type Element, type KiClient, type Bewertung,
} from '../index.js';
import { STANDARD_REGELN } from '../../mail-register/relevanz.js';
import { STANDARD_DOK_REGELN } from '../../doc-register/relevanz.js';

const R = STANDARD_REGELN;
const D = STANDARD_DOK_REGELN;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sek-'));

function bew(teil: Partial<Bewertung> = {}): Bewertung {
  return {
    relevant: true, begruendung: 'Stadt fordert Nachweis', objekt: 'MG24',
    vorgang: { bestehend: null, titel: 'MG24 EWärmeG-Erfüllungsnachweis' }, art: 'anfrage',
    fakten: { betraege: [], nummern: [], fristen: [], zaehlerstaende: [] },
    erwartet: 'Nachweis einreichen', bis: '2026-11-30', vorschlag: 'c', naechsterSchritt: 'Antwort mit Nachweis an die Stadt', ...teil,
  };
}

function mail(teil: Partial<Element> = {}): Element {
  return {
    typ: 'mail', kennung: 'm-00000001', quelle: 'm365', datum: '2026-10-21T07:19:00Z',
    titel: 'WG: Erfüllungsnachweis EWaermeG Marktgasse24', von: 'marcel.binefeld@tuttlingen.de', vonName: 'Binefeld',
    text: 'Bitte reichen Sie den Erfüllungsnachweis bis 30.11.2026 ein.', messageId: '<a@x>', threadIds: [], ordner: 'Posteingang', kopf: {},
    ...teil,
  };
}

/** Falscher KI-Client: Antworten der Reihe nach, Aufrufe gezählt. */
function fakeKi(antworten: Array<Bewertung | string>): KiClient & { aufrufe: string[] } {
  const aufrufe: string[] = [];
  let i = 0;
  const f: any = async (_s: string, nutzer: string) => {
    aufrufe.push(nutzer);
    const a = antworten[Math.min(i++, antworten.length - 1)];
    return { text: typeof a === 'string' ? a : JSON.stringify(a), tokensEin: 1000, tokensAus: 200 };
  };
  f.aufrufe = aufrufe;
  return f;
}

const kontext = { objekte: [{ kuerzel: 'MG24', adresse: 'Marktgasse 24, 78532 Tuttlingen' }], kontakte: [], fristen: [], vorgaben: [] };
const deps = (zustand: string, ki: KiClient, extra: Record<string, unknown> = {}) =>
  ({ zustand, regeln: R, dokRegeln: D, ki, kontext, deckelProStunde: null as number | null, jetzt: new Date('2026-10-27T12:00:00Z'), ...extra });

describe('Schema', () => {
  test('gültige Antwort wird übernommen und geglättet', () => {
    const p = pruefeBewertung({ ...bew(), begruendung: '  x  ', fakten: undefined });
    expect(p.ok).toBe(true);
    if (p.ok) { expect(p.wert.begruendung).toBe('x'); expect(p.wert.fakten.nummern).toEqual([]); }
  });
  test('Pflichtfelder und Formate werden geprüft', () => {
    for (const kaputt of [{ ...bew(), relevant: 'ja' }, { ...bew(), vorschlag: 'g' }, { ...bew(), bis: '30.11.2026' },
      { ...bew(), vorgang: { bestehend: 'v-1', titel: 'x' } }, { ...bew(), art: 'unbekannt' }, { ...bew(), naechsterSchritt: '' }]) {
      expect(pruefeBewertung(kaputt).ok).toBe(false);
    }
  });
  test('„nicht relevant" ohne Vorgangstitel und Schritt ist gültig, „relevant" nicht', () => {
    expect(pruefeBewertung({ ...bew({ relevant: false }), vorgang: null, naechsterSchritt: '' }).ok).toBe(true);
    expect(pruefeBewertung({ ...bew(), vorgang: { bestehend: null, titel: '' } }).ok).toBe(false);
  });

  test('Fristen mit falschem Datum werden verworfen, nicht erfunden', () => {
    const p = pruefeBewertung({ ...bew(), fakten: { fristen: [{ datum: 'bald', was: 'x' }, { datum: '2026-11-30', was: 'Nachweis' }] } });
    expect(p.ok && p.wert.fakten.fristen).toEqual([{ datum: '2026-11-30', was: 'Nachweis' }]);
  });
});

describe('Vorfilter — nur Offensichtliches', () => {
  test('Newsletter, Paketstatus, Systemmeldung, Social, eigene Mail', () => {
    expect(vorfilter(mail({ von: 'x@shop.de', titel: 'Angebote', kopf: { 'list-unsubscribe': '<x>' } }), R, D)).toBe('Newsletter');
    expect(vorfilter(mail({ von: 'zustellung@dhl.de', titel: 'Ihre Sendung kommt', text: '' }), R, D)).toBe('Paketstatus');
    expect(vorfilter(mail({ von: 'noreply@clockin.de', titel: 'Neue Projektnotiz', text: '' }), R, D)).toBe('Systemmeldung');
    expect(vorfilter(mail({ von: 'messages-noreply@linkedin.com', titel: 'x', text: '' }), R, D)).toBe('Social');
    expect(vorfilter(mail({ von: 'juergen.bickel@bikolino.com', titel: 'Abendbriefing', text: '' }), R, D)).toBe('eigene Mail');
  });
  test('Ermessensfragen gehen an die KI: Bewerbung, Verein, Werbeordner, Privatkauf', () => {
    expect(vorfilter(mail({ von: 'x@o-vivi.com', titel: 'Projektmanager-Elektroingenieur - Parin Gandhi', text: '' }), R, D)).toBeNull();
    expect(vorfilter(mail({ von: 'verein@historische-fahrraeder.de', titel: 'Der Vorstand informiert', text: '' }), R, D)).toBeNull();
    expect(vorfilter(mail({ von: 'order@hailo-shop.de', titel: 'Rechnung zur Bestellung 354258', text: '', ordner: 'Angebote' }), R, D)).toBeNull();
  });
  test('Gesundheitspost raus bei eindeutigem Absender, Betreff oder Anhang', () => {
    expect(vorfilter(mail({ von: 'info@email-zavamed.com', titel: 'Folgerezept' }), R, D)).toBe('Gesundheit');
    expect(vorfilter(mail({ von: 'service@lkh.de', titel: 'Ihre Erstattung', text: '' }), R, D)).toBe('Gesundheit');
    expect(vorfilter(mail({ von: 'info@praxis-dr-muster.de', titel: 'Termin', text: '' }), R, D)).toBe('Gesundheit');
    expect(vorfilter(mail({ von: 'a@b.de', titel: 'Ihr Arztbrief', text: '' }), R, D)).toBe('Gesundheit');
    expect(vorfilter(mail({ von: 'a@b.de', titel: 'Unterlagen', text: '', anhaenge: ['Laborbefund_2026.pdf'] }), R, D)).toBe('Gesundheit');
    expect(vorfilter({ typ: 'dokument', kennung: 'd-1', quelle: 'sharepoint', datum: '2026-10-27T00:00:00Z', titel: 'Krankenkasse Bescheid.pdf',
      von: '/Scans', pfad: '/Scans/Krankenkasse Bescheid.pdf', text: '' }, R, D)).toBe('Gesundheit');
  });
  test('„Befund" im Text einer Objektmail filtert nicht (Chat-Review 27.10.: Zähler-Mails Bauser)', () => {
    const e = mail({ von: 'matthias.bauser@bikolino.com', titel: 'AW: Zählerfragen MG24 und N24 – bitte prüfen',
      text: 'W3 (E3) Süd/West Befund: 165 kWh Wärme bei 0 m³ Warmwasser. Diagnose der Leittechnik folgt.' });
    expect(vorfilter(e, R, D)).toBeNull();
  });
  test('Dokumente: eigener Kanal, Eltern, Dateityp', () => {
    const dok = (pfad: string): Element => ({ typ: 'dokument', kennung: 'd-2', quelle: 'dropbox', datum: '2026-10-27T00:00:00Z', titel: pfad.split('/').pop()!, von: '/', pfad, text: '' });
    expect(vorfilter(dok('/Apps/bikosoc-reports/x/Rechnung.pdf'), R, D)).toBe('eigener Kanal/cc-Ablage');
    expect(vorfilter(dok('/Papa/Rechnung Hunzinger.pdf'), R, D)).toBe('Privat (Eltern)');
    expect(vorfilter(dok('/Austausch/daten.csv'), R, D)).toBe('Dateityp');
    expect(vorfilter(dok('/Austausch/2026-10-19_MG24 Erfuellungsnachweis EWaermeG.pdf'), R, D)).toBeNull();
  });
});

describe('Zweites Netz — deterministisch', () => {
  test('Frist mit Aufforderung', () => { expect(zweitesNetz(mail()).map((n) => n.grund)).toContain('Frist/Datum mit Aufforderung'); });
  test('Betrag mit Rechnung', () => {
    expect(zweitesNetz(mail({ von: 'x@y.de', titel: 'Ihre Rechnung', text: 'Betrag 1.234,56 € fällig' })).map((n) => n.grund)).toContain('Betrag mit Rechnung/Mahnung');
  });
  test('Behördenabsender', () => { expect(zweitesNetz(mail({ text: '' })).map((n) => n.grund)).toContain('Behördenabsender'); });
  test('Vertrag/Kündigung', () => {
    expect(zweitesNetz(mail({ von: 'kontakt@enbw.com', titel: 'Die Kündigung Ihres Wärmestromvertrags', text: '' })).map((n) => n.grund)).toContain('Vertrag/Kündigung');
  });
  test('Bank/Versicherung über Absender', () => {
    expect(zweitesNetz(mail({ von: 'noreply@ksk-tut.de', titel: 'Neue Nachricht', text: '' }), /@ksk-tut\.de$/).map((n) => n.grund)).toContain('Bank/Versicherung');
  });
  test('harmlose Mail: kein Treffer', () => {
    expect(zweitesNetz(mail({ von: 'freund@web.de', titel: 'Grüße', text: 'Schönes Wochenende!' }))).toEqual([]);
  });
});

describe('KI-Aufruf', () => {
  test('Gesundheitspost erreicht das Modell nie', async () => {
    const ki = fakeKi([bew()]);
    await expect(bewerteMitKi(mail({ titel: 'Ihr Rezept liegt in der Apotheke' }), { ...kontext, vorgaenge: [] }, ki)).rejects.toThrow('Gesundheit');
    await expect(bewerteMitKi(mail({ von: 'praxis@arztpraxis-muster.de', titel: 'Termin' }), { ...kontext, vorgaenge: [] }, ki)).rejects.toThrow('Gesundheit');
    expect(ki.aufrufe).toHaveLength(0);
  });
  test('ungültiges JSON → ein zweiter Versuch, dann Fehler', async () => {
    const ki = fakeKi(['kein json', '{"relevant": "vielleicht"}']);
    const a = await bewerteMitKi(mail(), { ...kontext, vorgaenge: [] }, ki);
    expect(a.bewertung).toBeNull();
    expect(ki.aufrufe).toHaveLength(2);
    expect(a.tokensEin).toBe(2000);
  });
});

describe('Verarbeiten: Vorgänge, Netz, Ablage, Deckel, Statuskette', () => {
  test('Thread-ID ordnet hart zu, auch wenn die KI einen anderen Titel nennt', async () => {
    const z = tmp();
    const ki = fakeKi([bew(), bew({ vorgang: { bestehend: null, titel: 'Etwas ganz anderes' } })]);
    const a = mail({ kennung: 'm-a', messageId: '<a@x>' });
    const b = mail({ kennung: 'm-b', messageId: '<b@x>', datum: '2026-10-22T08:00:00Z', titel: 'AW: Erfüllungsnachweis', threadIds: ['<a@x>'] });
    const e = await verarbeite([a, b], deps(z, ki));
    const s = ladeSpeicher(z);
    expect(s.vorgaenge).toHaveLength(1);
    expect(s.vorgaenge[0].elemente).toEqual(['m-a', 'm-b']);
    expect(e.zaehler.vorschlag).toBe(2);
  });

  test('Dokument zu bestehendem Vorgang über die KI-Kennung; Mail einer anderen Person ebenso', async () => {
    const z = tmp();
    await verarbeite([mail({ kennung: 'm-a' })], deps(z, fakeKi([bew()])));
    const v = ladeSpeicher(z).vorgaenge[0].kennung;
    const dok: Element = { typ: 'dokument', kennung: 'd-1', quelle: 'dropbox', datum: '2026-10-19T17:57:00Z',
      titel: '2026-10-19_MG24 Erfuellungsnachweis EWaermeG.pdf', von: '/Austausch', pfad: '/Austausch/2026-10-19_MG24 Erfuellungsnachweis EWaermeG.pdf', text: 'Erfüllungsnachweis' };
    await verarbeite([dok], deps(z, fakeKi([bew({ vorgang: { bestehend: v, titel: 'egal' }, vorschlag: 'b' })])));
    const s = ladeSpeicher(z);
    expect(s.vorgaenge).toHaveLength(1);
    expect(s.vorgaenge[0].elemente).toEqual(['m-a', 'd-1']);
    /* Das jüngste Element (Mail 21.10.) bestimmt den Schritt, nicht das ältere Dokument. */
    expect(s.vorgaenge[0].vorschlag).toBe('c');
    expect(s.vorgaenge[0].frist).toBe('2026-11-30');
  });

  test('gleicher Titel und Objekt ohne Kennung → derselbe Vorgang', async () => {
    const z = tmp();
    await verarbeite([mail({ kennung: 'm-a' }), mail({ kennung: 'm-c', messageId: '<c@x>', datum: '2026-10-23T00:00:00Z' })], deps(z, fakeKi([bew()])));
    expect(ladeSpeicher(z).vorgaenge).toHaveLength(1);
  });

  test('KI „nicht relevant", Netz schlägt an → Einzelzeile, immer gemeldet', async () => {
    const z = tmp();
    const e = await verarbeite([mail()], deps(z, fakeKi([bew({ relevant: false, begruendung: 'nur Information' })])));
    expect(e.einzeln.map((x) => x.kennung)).toEqual(['m-00000001']);
    expect(e.zaehler.netzEinzeln).toBe(1);
    expect(ladeSpeicher(z).vorgaenge).toHaveLength(0);
  });

  test('KI und Netz „unwichtig" → Ablage mit Begründung und Beleg', async () => {
    const z = tmp();
    const harmlos = mail({ von: 'freund@web.de', titel: 'Grüße', text: 'Schönes Wochenende!' });
    await verarbeite([harmlos], deps(z, fakeKi([bew({ relevant: false, begruendung: 'privater Gruß' })])));
    const abl = fs.readFileSync(path.join(z, 'nicht-relevant.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(abl[0].grund).toBe('KI: privater Gruß');
    expect(abl[0].beleg).toContain('m-00000001');
  });

  test('Gesundheitspost: vorgefiltert, Modell nie gefragt', async () => {
    const z = tmp();
    const ki = fakeKi([bew()]);
    const e = await verarbeite([mail({ von: 'info@email-zavamed.com', titel: 'Folgerezept' })], deps(z, ki));
    expect(e.zaehler.vorgefiltert).toBe(1);
    expect(ki.aufrufe).toHaveLength(0);
  });

  test('Deckel: über dem Limit wird gewartet, später nachgeholt', async () => {
    const z = tmp();
    const vier = [1, 2, 3, 4].map((i) => mail({ kennung: `m-${i}`, messageId: `<${i}@x>`, datum: `2026-10-2${i}T00:00:00Z` }));
    const e1 = await verarbeite(vier, deps(z, fakeKi([bew()]), { deckelProStunde: 2 }));
    expect([e1.zaehler.bewertet, e1.zaehler.wartet]).toEqual([2, 2]);
    const e2 = await verarbeite([], deps(z, fakeKi([bew()]), { deckelProStunde: 2, jetzt: new Date('2026-10-27T12:30:00Z') }));
    expect(e2.zaehler.wartet).toBe(2);
    const e3 = await verarbeite([], deps(z, fakeKi([bew()]), { deckelProStunde: 2, jetzt: new Date('2026-10-27T13:30:00Z') }));
    expect(e3.zaehler.bewertet).toBe(2);
    expect(Object.values(ladeSpeicher(z).elemente).every((x) => x.status === 'vorschlag')).toBe(true);
  });

  test('KI-Fehler → Alarm, Element wartet und wird im nächsten Lauf wiederholt', async () => {
    const z = tmp();
    const e1 = await verarbeite([mail()], deps(z, fakeKi(['kaputt'])));
    expect(e1.zaehler.fehler).toBe(1);
    expect(e1.alarm.join(' ')).toContain('fehlgeschlagen');
    const e2 = await verarbeite([], deps(z, fakeKi([bew()])));
    expect(e2.zaehler.vorschlag).toBe(1);
    expect(e2.alarm).toEqual([]);
  });

  test('Statuskette: jede Neuheit genau ein Ausgang; zweiter Lauf fragt das Modell nicht erneut', async () => {
    const z = tmp();
    const ki = fakeKi([bew()]);
    const el = [mail({ kennung: 'm-1' }), mail({ kennung: 'm-2', von: 'zustellung@dhl.de', titel: 'Sendung', text: '' })];
    const e = await verarbeite(el, deps(z, ki));
    expect(e.alarm).toEqual([]);
    expect(e.zaehler.erfasst).toBe(2);
    const laeufe = fs.readFileSync(path.join(z, 'laeufe.jsonl'), 'utf-8').trim().split('\n');
    expect(laeufe).toHaveLength(1);
    await verarbeite(el, deps(z, ki));
    expect(ki.aufrufe).toHaveLength(1);
  });

  test('Kosten werden protokolliert', async () => {
    const z = tmp();
    await verarbeite([mail()], deps(z, fakeKi([bew()])));
    const k = JSON.parse(fs.readFileSync(path.join(z, 'kosten.jsonl'), 'utf-8').trim());
    expect([k.aufrufe, k.tokensEin, k.tokensAus, k.modell]).toEqual([1, 1000, 200, 'claude-sonnet-4-6']);
    expect(k.kostenUsd).toBeCloseTo(0.006, 5);
  });

  test('Abbruchfest: jede Neuheit liegt als „erfasst" mit Inhalt im Speicher, bevor das Modell gefragt wird', async () => {
    const z = tmp();
    let gesehen: any = null;
    const ki: KiClient = async () => {
      gesehen ??= JSON.parse(fs.readFileSync(path.join(z, 'elemente.json'), 'utf-8'));
      return { text: JSON.stringify(bew()), tokensEin: 10, tokensAus: 5 };
    };
    await verarbeite([mail({ kennung: 'm-1' }), mail({ kennung: 'm-2', messageId: '<b@x>' })], deps(z, ki));
    expect(gesehen['m-1'].status).toBe('erfasst');
    expect(gesehen['m-2'].status).toBe('erfasst');
    expect(gesehen['m-2'].wartend.text).toContain('Erfüllungsnachweis');
    const s = ladeSpeicher(z);
    expect(s.elemente['m-2'].wartend).toBeUndefined();
  });

  test('„erfasst" aus einem abgebrochenen Lauf wird im nächsten Lauf bewertet', async () => {
    const z = tmp();
    const e = mail({ kennung: 'm-x' });
    fs.writeFileSync(path.join(z, 'elemente.json'), JSON.stringify({ 'm-x': { kennung: 'm-x', typ: 'mail', quelle: 'm365', datum: e.datum,
      titel: e.titel, von: e.von, status: 'erfasst', kette: { erfasst: '2026-10-27T11:00:00Z' }, netz: [], begruendung: '', beleg: 'm-x', wartend: e } }));
    const r = await verarbeite([], deps(z, fakeKi([bew()])));
    expect(r.zaehler.vorschlag).toBe(1);
  });

  test('nach drei Fehlversuchen: Einzelmeldung statt endloser Wiederholung', async () => {
    const z = tmp();
    const ki = fakeKi(['kaputt']);
    await verarbeite([mail()], deps(z, ki));
    await verarbeite([], deps(z, ki));
    const r3 = await verarbeite([], deps(z, ki));
    expect(r3.einzeln.map((x) => x.kennung)).toEqual(['m-00000001']);
    expect(r3.alarm.join(' ')).toContain('3× fehlgeschlagen');
    expect(ladeSpeicher(z).elemente['m-00000001'].status).toBe('netz');
    const vorher = ki.aufrufe.length;
    await verarbeite([], deps(z, ki));
    expect(ki.aufrufe.length).toBe(vorher);
  });

  test('Thread-Treffer schlägt die Relevanz: Antwort kommt in den Vorgang, Schritt bleibt', async () => {
    const z = tmp();
    const a = mail({ kennung: 'm-a', messageId: '<a@x>' });
    const b = mail({ kennung: 'm-b', messageId: '<b@x>', datum: '2026-10-22T08:00:00Z', titel: 'AW: danke', text: 'Danke, erledigt.', threadIds: ['<a@x>'], von: 'kopf@maurer.de' });
    await verarbeite([a, b], deps(z, fakeKi([bew(), bew({ relevant: false, begruendung: 'nur Dank', vorschlag: 'f', naechsterSchritt: 'nichts' })])));
    const v = ladeSpeicher(z).vorgaenge[0];
    expect(v.elemente).toEqual(['m-a', 'm-b']);
    expect(v.naechsterSchritt).toBe('Antwort mit Nachweis an die Stadt');
  });

  test('gemeinsame References-Kette ohne direkten Verweis führt nicht zusammen (Ticketsysteme)', async () => {
    const z = tmp();
    const a = mail({ kennung: 'm-a', messageId: '<a@x>', threadIds: ['<ticket@sys>'] });
    const b = mail({ kennung: 'm-b', messageId: '<b@x>', threadIds: ['<ticket@sys>'], titel: 'Anderes Thema' });
    await verarbeite([a, b], deps(z, fakeKi([bew(), bew({ objekt: 'N24', vorgang: { bestehend: null, titel: 'N24 Anderes' } })])));
    expect(ladeSpeicher(z).vorgaenge).toHaveLength(2);
  });

  test('Deckel zählt API-Aufrufe, nicht Elemente; kaputte Kostenzeilen öffnen ihn nicht', async () => {
    const z = tmp();
    const r = await verarbeite([mail({ kennung: 'm-1' }), mail({ kennung: 'm-2', messageId: '<b@x>' })], deps(z, fakeKi(['kaputt']), { deckelProStunde: 2 }));
    expect(r.zaehler.fehler).toBe(1);
    expect(r.zaehler.wartet).toBe(1);
    const z2 = tmp();
    fs.writeFileSync(path.join(z2, 'kosten.jsonl'), '{kaputt\n' + JSON.stringify({ zeit: '2026-10-27T11:30:00Z', aufrufe: 5 }) + '\n');
    const r2 = await verarbeite([mail()], deps(z2, fakeKi([bew()]), { deckelProStunde: 5 }));
    expect(r2.zaehler.wartet).toBe(1);
  });

  test('IBAN verlässt den Server nicht und steht nicht in der Bewertung', async () => {
    const z = tmp();
    const ki = fakeKi([bew({ begruendung: 'Zahlung an DE89 3704 0044 0532 0130 00' })]);
    await verarbeite([mail({ text: 'Bitte überweisen Sie auf DE89370400440532013000 bis 30.11.2026.' })], deps(z, ki));
    expect(ki.aufrufe[0]).not.toContain('DE89370400440532013000');
    expect(JSON.stringify(ladeSpeicher(z).elemente['m-00000001'].bewertung)).not.toMatch(/0532\s?0130/);
  });

  test('Probe schreibt nichts', async () => {
    const z = tmp();
    await verarbeite([mail()], deps(z, fakeKi([bew()]), { probe: true }));
    expect(fs.readdirSync(z)).toEqual([]);
  });
});

describe('Bericht je Vorgang', () => {
  test('eine Zeile je Vorgang mit Freigabe; f nur als Zähler', async () => {
    const z = tmp();
    const e = await verarbeite([mail({ kennung: 'm-a' }),
      mail({ kennung: 'm-k', messageId: '<k@x>', von: 'info@firma.de', titel: 'Info', text: '' })],
    deps(z, fakeKi([bew(), bew({ vorschlag: 'f', vorgang: { bestehend: null, titel: 'Info Firma' }, objekt: null })])));
    const s = ladeSpeicher(z);
    expect(vorgangsZeilen(e.vorgaenge, s.elemente).kenntnis).toBe(1);
    const r = stundenReportSekretariat({ ergebnis: e, elemente: s.elemente, jetzt: new Date('2026-10-27T12:07:00Z'), hinweise: [] });
    expect(r).toContain(`Freigabe Vorgang ${s.vorgaenge[0].kennung}`);
    expect(r).toContain('+ 1 zur Kenntnis');
    expect(r).not.toContain('Info Firma');
    const t = telegramZeilen({ ergebnis: e, elemente: s.elemente });
    expect(t.titel).toBe('Neu: 1 Vorgang/Vorgänge');
  });
});

describe('Mieternamen', () => {
  test('voller Name und Nachname; Owner, Behörde, Orte und Lieferanten bleiben', () => {
    const weg = mieterErsetzer(['Erika Musterfrau — Mieter N24 W3', 'Koch Brennstoffe — Dienstleister/Lieferant (MG24)',
      'Beispiel GmbH — Mieter MG24 G1', 'Jürgen Bickel — Mieter L19 W3', 'Anna Bickel — Mieter N24 W5', 'Stadt Tuttlingen — Mieter MG22 G3',
      'Paul Koch — Mieter S28 W1'], ['Tuttlingen']);
    expect(weg('Erika Musterfrau fragt; Musterfrau zahlt; Beispiel GmbH zahlt; WHG W3 Musterfrau')).toBe('Mieter N24 W3 fragt; Mieter N24 W3 zahlt; Mieter MG24 G1 zahlt; WHG W3 Mieter N24 W3');
    expect(weg('Musterfrauenverein')).toBe('Musterfrauenverein');
    expect(weg('Storz&Bickel GmbH, Herr Jürgen Bickel, Anna Bickel')).toBe('Storz&Bickel GmbH, Herr Jürgen Bickel, Mieter N24 W5');
    expect(weg('Nachweis der Stadt Tuttlingen, 78532 Tuttlingen')).toBe('Nachweis der Stadt Tuttlingen, 78532 Tuttlingen');
    expect(weg('Rechnung Koch Brennstoffe; Paul Koch zahlt')).toBe('Rechnung Koch Brennstoffe; Mieter S28 W1 zahlt');
  });
});

describe('Zugangsdaten', () => {
  test('Passwort, PIN, Kennwort werden entfernt — im Prompt und in der Bewertung', async () => {
    expect(ohneZugangsdaten('User: m.b@x.de, PW: Geheim&28; PIN 1234, Kennwort lautet abc')).toBe('User: m.b@x.de, PW: [entfernt]; PIN 1234, Kennwort lautet [entfernt]');
    const z = tmp();
    const ki = fakeKi([bew({ naechsterSchritt: 'Zugang eintragen (User: a, PW: Geheim&28)' })]);
    await verarbeite([mail({ text: 'Zugang: Passwort: Geheim&28 bitte bis 30.11.2026 eintragen' })], deps(z, ki));
    expect(ki.aufrufe[0]).not.toContain('Geheim&28');
    expect(JSON.stringify(ladeSpeicher(z).elemente)).not.toContain('Geheim&28');
  });
});

describe('Fristen, Wartestatus, Netz-Ablage, Korrekturen (Chat-Review 27.10.2026)', () => {
  test('vergangene Frist ist keine Vorgangsfrist, sondern „abgelaufen – prüfen"', async () => {
    const z = tmp();
    await verarbeite([mail({ kennung: 'm-alt' })], deps(z, fakeKi([bew({ bis: '2024-12-31', fakten: { betraege: [], nummern: [], zaehlerstaende: [], fristen: [{ datum: '2025-09-24', was: 'Ablesung' }] } })])));
    const v = ladeSpeicher(z).vorgaenge[0];
    expect([v.frist, v.fristAbgelaufen]).toEqual([null, '2025-09-24']);
    const s = ladeSpeicher(z);
    expect(vorgangsTabelle(vorgangsZeilen(s.vorgaenge, s.elemente, new Date('2026-10-27T12:00:00Z')).zeilen).join('\n')).toContain('abgelaufen 24.09.2025 – prüfen');
  });
  test('künftige Frist gewinnt vor vergangener; am Folgetag wird sie zur abgelaufenen', async () => {
    const z = tmp();
    await verarbeite([mail()], deps(z, fakeKi([bew({ bis: '2026-10-28', fakten: { betraege: [], nummern: [], zaehlerstaende: [], fristen: [{ datum: '2026-10-01', was: 'alt' }] } })])));
    const s = ladeSpeicher(z);
    expect(s.vorgaenge[0].frist).toBe('2026-10-28');
    const morgen = vorgangsZeilen(s.vorgaenge, s.elemente, new Date('2026-10-29T08:00:00Z')).zeilen[0].v;
    expect([morgen.frist, morgen.fristAbgelaufen]).toEqual([null, '2026-10-28']);
  });
  test('wartet auf Owner: Kennzeichen in der Tabelle, keine Freigabezeile; erledigt: nicht mehr gelistet', async () => {
    const z = tmp();
    await verarbeite([mail({ kennung: 'm-1' }), mail({ kennung: 'm-2', messageId: '<b@x>', titel: 'Anderes', text: 'x' })],
      deps(z, fakeKi([bew(), bew({ objekt: 'N24', vorgang: { bestehend: null, titel: 'N24 Anderes' } })])));
    const s = ladeSpeicher(z);
    const [a, b] = s.vorgaenge;
    wendeAn(s.vorgaenge as any, { zeit: '', quelle: 't', art: 'fehler', bezug: [a.kennung], befund: '', aenderung: { vorgang: a.kennung, status: 'wartet', wartetAuf: 'Bauser-Termin 27.10.' } }, '2026-10-27T13:00:00Z');
    wendeAn(s.vorgaenge as any, { zeit: '', quelle: 't', art: 'fehler', bezug: [b.kennung], befund: '', aenderung: { vorgang: b.kennung, status: 'erledigt', verweis: 'Auftrag 20261027-1425' } }, '2026-10-27T13:00:00Z');
    const r = stundenReportSekretariat({ ergebnis: { zaehler: { erfasst: 0, vorgefiltert: 0, bewertet: 0, abgelegtKi: 0, vorschlag: 0, netzEinzeln: 0, wartet: 0, fehler: 0 },
      vorgaenge: s.vorgaenge, einzeln: [], tokensEin: 0, tokensAus: 0, kostenUsd: 0, alarm: [], elemente: [] }, elemente: s.elemente, jetzt: new Date('2026-10-27T14:00:00Z'), hinweise: [] });
    expect(r).toContain('⏸ wartet auf Owner (Bauser-Termin 27.10.)');
    expect(r).not.toContain(`Freigabe Vorgang ${a.kennung}`);
    expect(r).not.toContain(b.kennung);
  });
  test('Netz-Treffer mit KI „nicht relevant" liegen auch in der Nicht-relevant-Ablage, mit Netz-Vermerk', async () => {
    const z = tmp();
    await verarbeite([mail({ von: 'info@imkerverein.de', titel: 'Rechnung Jahresbeitrag', text: 'Rechnung 25,00 € zahlbar bis 30.11.2026' })],
      deps(z, fakeKi([bew({ relevant: false, begruendung: 'Vereinspost', vorschlag: 'f' })])));
    const nr = JSON.parse(fs.readFileSync(path.join(z, 'nicht-relevant.jsonl'), 'utf-8').trim());
    expect(nr.netz.length).toBeGreaterThan(0);
    expect(ladeSpeicher(z).elemente['m-00000001'].status).toBe('netz');
  });
  test('Korrekturen werden Regeln und Beispiele für das Modell', () => {
    const z = tmp();
    speichereKorrektur(z, { zeit: 'x', quelle: 'Chat', art: 'fehler', bezug: ['v-1'], befund: 'Passwort', regel: 'Zugangsdaten nie speichern.' });
    speichereKorrektur(z, { zeit: 'x', quelle: 'Chat', art: 'bestaetigt', bezug: ['v-2'], befund: 'MG24 EWärmeG: Stadt + Handwerker + PDF ein Vorgang' });
    fs.appendFileSync(path.join(z, 'korrekturen.jsonl'), '{kaputt\n');
    expect(korrekturZeilen(ladeKorrekturen(z))).toEqual(['Korrektur des Owners: Zugangsdaten nie speichern.', 'Richtig bewertet (Beispiel): MG24 EWärmeG: Stadt + Handwerker + PDF ein Vorgang']);
  });
});

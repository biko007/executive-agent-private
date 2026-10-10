/**
 * meter-import — Parser, Zuordnung und Plausibilitätsprüfungen.
 *
 * Ohne Datenbank: geprüft werden die reinen Funktionen. Das Schreiben selbst
 * geht über dieselbe Einfügestrecke wie die Bulk-Route und ist dort abgedeckt.
 */
import { describe, it, expect } from 'bun:test';
import * as XLSX from 'xlsx';
import { leseBericht, monatsStaende, ebeneAus, einheitFuer } from '../parser.js';
import {
  findeObjekt, schwellenFuer, istBekannt, MAPPING_MG24, SCHWELLEN_VORGABE,
} from '../config.js';
import {
  pruefeMonotonie, pruefeBilanz, pruefeSprung, pruefeFehlenderBericht,
  type ZaehlerStand,
} from '../pruefung.js';

/** Baut einen Bericht im Format der Gebäudeautomation. */
function berichtDatei(ueberschrift: string, gruppen: { name: string; zeilen: [string, number][] }[]): Buffer {
  const matrix: any[][] = [[ueberschrift]];
  const kopf1: any[] = [];
  const kopf2: any[] = [];
  gruppen.forEach((g, i) => {
    const c = i * 4;
    kopf1[c] = g.name; kopf1[c + 1] = ''; kopf1[c + 2] = ''; kopf1[c + 3] = '';
    kopf2[c] = 'Zeitstempel'; kopf2[c + 1] = 'Zählerstand aktuell'; kopf2[c + 2] = 'Verbrauch Vormonat'; kopf2[c + 3] = '';
  });
  matrix.push(kopf1, kopf2);
  const maxZeilen = Math.max(...gruppen.map(g => g.zeilen.length));
  for (let r = 0; r < maxZeilen; r++) {
    const zeile: any[] = [];
    gruppen.forEach((g, i) => {
      const c = i * 4;
      const eintrag = g.zeilen[r];
      zeile[c] = eintrag ? `${eintrag[0]} +1H` : '';
      zeile[c + 1] = eintrag ? String(eintrag[1]) : '';
      zeile[c + 2] = ''; zeile[c + 3] = '';
    });
    matrix.push(zeile);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), 'Tabelle1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

function stand(p: Partial<ZaehlerStand>): ZaehlerStand {
  return {
    meterNumber: 'MG24-W1-KW', medium: 'cold_water', istHauptzaehler: false,
    gehoertZuEinheit: true, monat: '2026-02', wert: 10, ...p,
  };
}

describe('Parser', () => {
  it('liest Überschrift, Ebene und absolute Stände', () => {
    const datei = berichtDatei('Badhaus Tuttlingen - Report Zähler Wohnung E1', [
      { name: 'Kaltwasserzähler', zeilen: [['2026-02-01 07:11', 40.1], ['2026-02-27 19:11', 42.5]] },
      { name: 'Wärmemengenzähler Süd/West', zeilen: [['2026-02-28 07:50', 13000000]] },
    ]);
    const b = leseBericht(datei);

    expect(b.ueberschrift).toContain('Badhaus Tuttlingen');
    expect(b.ebene).toBe('E1');
    expect(b.staende).toHaveLength(3);
    expect(b.staende.some(s => s.gruppe === 'kaltwasserzähler' && s.wert === 42.5)).toBe(true);
  });

  it('nimmt je Monat den LETZTEN Stand, nicht die Verbrauchsspalte', () => {
    /* Der Grund fuer das ganze Modul: Die Spalte "Verbrauch Vormonat" deckt
       nur das protokollierte Fenster ab und ist als Monatsverbrauch falsch. */
    const datei = berichtDatei('Badhaus Tuttlingen - Report Zähler Wohnung E2', [
      { name: 'Kaltwasserzähler', zeilen: [
        ['2026-01-28 10:00', 30], ['2026-02-02 10:00', 31], ['2026-02-26 10:00', 35],
      ] },
    ]);
    const m = monatsStaende(leseBericht(datei).staende);
    const reihe = m.get('kaltwasserzähler')!;
    expect(reihe).toHaveLength(2);
    expect(reihe[0]).toMatchObject({ zeitpunkt: '2026-01-28 10:00', wert: 30 });
    expect(reihe[1]).toMatchObject({ zeitpunkt: '2026-02-26 10:00', wert: 35 });
  });

  it('überspringt das Summenblatt und erkennt Ebenen', () => {
    expect(ebeneAus('Badhaus Tuttlingen - Report Zähler Allgemein E0')).toBe('E0');
    expect(ebeneAus('Report ohne Ebene')).toBeNull();
  });

  it('rechnet Wärmemengen auf kWh, Wasser bleibt in m³', () => {
    expect(einheitFuer('MG24-W1-WMZ-SW')).toEqual({ einheit: 'kWh', teiler: 1000 });
    expect(einheitFuer('MG24-W1-KW')).toEqual({ einheit: 'm³', teiler: 1 });
  });
});

describe('Zuordnung', () => {
  it('findet das Objekt über die Berichtsüberschrift', () => {
    const t = findeObjekt(MAPPING_MG24, 'Badhaus Tuttlingen - Report Zähler Wohnung E3');
    expect(t?.zuordnung.property).toBe('mg24');
    expect(t?.zuordnung.ebenen.E3['wärmemengenzähler nord/ost']).toBe('MG24-W3-WMZ-NO');
  });

  it('liefert nichts für ein unbekanntes Objekt — statt zu raten', () => {
    expect(findeObjekt(MAPPING_MG24, 'Irgendein anderes Haus - Report E1')).toBeNull();
  });

  it('legt objekteigene Schwellen über die Vorgabe', () => {
    const s = schwellenFuer({ property: 'x', ebenen: {}, schwellen: { sprungFaktor: 9 } } as any);
    expect(s.sprungFaktor).toBe(9);
    expect(s.wasserToleranzProzent).toBe(SCHWELLEN_VORGABE.wasserToleranzProzent);
  });

  it('kennt die abgehakte Wasserbilanz von MG24 und lässt sie bis zum Stichtag ruhen', () => {
    const z = MAPPING_MG24['badhaus tuttlingen'];
    expect(istBekannt(z, 'wasserbilanz', new Date('2026-11-01'))).toContain('Hausanschluss');
    expect(istBekannt(z, 'wasserbilanz', new Date('2027-06-01'))).toBeNull();
    expect(istBekannt(z, 'sprung', new Date('2026-11-01'))).toBeNull();
  });
});

describe('Plausibilität', () => {
  it('meldet einen sinkenden Zählerstand', () => {
    const a = pruefeMonotonie([stand({ wert: 8, vorher: { monat: '2026-01', wert: 10 } })]);
    expect(a).toHaveLength(1);
    expect(a[0].pruefung).toBe('monotonie');
  });

  it('lässt einen steigenden Stand durch', () => {
    expect(pruefeMonotonie([stand({ wert: 12, vorher: { monat: '2026-01', wert: 10 } })])).toHaveLength(0);
  });

  it('meldet, wenn die Wohnungszähler höher stehen als der Hauptzähler', () => {
    /* Der echte Fall bei MG24: Wohnungszähler zusammen 347 m³, Hausanschluss
       148,5 m³. Warmwasser zählt mit — es kommt aus demselben Anschluss. */
    const s = [
      stand({ meterNumber: 'MG24-KW-HAUSANSCHLUSS', istHauptzaehler: true, gehoertZuEinheit: false, wert: 148.5 }),
      stand({ meterNumber: 'MG24-W1-KW', wert: 46.8 }),
      stand({ meterNumber: 'MG24-W1-WW', medium: 'warm_water', wert: 18.0 }),
      stand({ meterNumber: 'MG24-W3-KW', wert: 282.2 }),
    ];
    const a = pruefeBilanz(s, SCHWELLEN_VORGABE);
    expect(a).toHaveLength(1);
    expect(a[0].pruefung).toBe('wasserbilanz');
    expect(a[0].text).toContain('148.50');
  });

  it('lässt eine stimmige Wasserbilanz durch', () => {
    const s = [
      stand({ meterNumber: 'MG24-KW-HAUSANSCHLUSS', istHauptzaehler: true, gehoertZuEinheit: false, wert: 100 }),
      stand({ meterNumber: 'MG24-W1-KW', wert: 40 }),
      stand({ meterNumber: 'MG24-W2-KW', wert: 55 }),
    ];
    expect(pruefeBilanz(s, SCHWELLEN_VORGABE)).toHaveLength(0);
  });

  it('erlaubt bei Wärme den größeren Verteilverlust', () => {
    /* Echte Werte MG24: Hauptzähler 76.717 kWh, Wohnungszähler zusammen
       49.720 kWh — der Hauptzähler steht höher, das ist der Normalfall. */
    const s = [
      stand({ meterNumber: 'MG24-WMZ-HEIZUNG-GESAMT', medium: 'heat', istHauptzaehler: true,
              gehoertZuEinheit: false, wert: 76717 }),
      stand({ meterNumber: 'MG24-W1-WMZ-SW', medium: 'heat', wert: 13730 }),
      stand({ meterNumber: 'MG24-W2-WMZ-NO', medium: 'heat', wert: 13975 }),
    ];
    expect(pruefeBilanz(s, SCHWELLEN_VORGABE)).toHaveLength(0);
  });

  it('meldet keinen saisonalen Sprung bei der Heizung', () => {
    /* Zwei Kilowattstunden im August, zweihundertsechzig im Oktober — der
       Normalfall. Eine Meldung darüber wäre Lärm. */
    const a = pruefeSprung(
      [stand({ meterNumber: 'MG24-W1-WMZ-NO', medium: 'heat', wert: 262,
               vorher: { monat: '2026-04', wert: 2 }, vormonatsVerbrauch: 2 })],
      SCHWELLEN_VORGABE,
    );
    expect(a).toHaveLength(0);
  });

  it('meldet einen Verbrauchssprung über dem Faktor', () => {
    const a = pruefeSprung(
      [stand({ wert: 60, vorher: { monat: '2026-01', wert: 10 }, vormonatsVerbrauch: 10 })],
      SCHWELLEN_VORGABE,
    );
    expect(a).toHaveLength(1);
    expect(a[0].pruefung).toBe('sprung');
  });

  it('meldet keinen Sprung bei normalem Anstieg', () => {
    const a = pruefeSprung(
      [stand({ wert: 22, vorher: { monat: '2026-01', wert: 10 }, vormonatsVerbrauch: 10 })],
      SCHWELLEN_VORGABE,
    );
    expect(a).toHaveLength(0);
  });

  it('meldet einen fehlenden Monatsbericht erst ab dem Stichtag', () => {
    const frueh = pruefeFehlenderBericht('2026-01', new Date('2026-03-05T12:00:00Z'), SCHWELLEN_VORGABE);
    expect(frueh).toHaveLength(0);
    const spaet = pruefeFehlenderBericht('2026-01', new Date('2026-03-15T12:00:00Z'), SCHWELLEN_VORGABE);
    expect(spaet).toHaveLength(1);
    expect(spaet[0].text).toContain('2026-02');
  });

  it('meldet nichts, wenn der Vormonatsbericht da ist', () => {
    expect(pruefeFehlenderBericht('2026-02', new Date('2026-03-15T12:00:00Z'), SCHWELLEN_VORGABE)).toHaveLength(0);
  });
});

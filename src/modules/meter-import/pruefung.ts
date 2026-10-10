/**
 * meter-import/pruefung — Plausibilität der eingelesenen Zählerstände.
 *
 * Grundsatz: Eine Abweichung verhindert den Import NICHT. Der Stand wird
 * geschrieben und die Abweichung gemeldet. Andernfalls entstünden Lücken in
 * der Zeitreihe, die später niemand mehr schließt — und eine Lücke ist für die
 * Abrechnung schlimmer als ein auffälliger Wert, den jemand gesehen hat.
 */
import type { Schwellen } from './config.js';

export interface Abweichung {
  pruefung: string;
  zaehler?: string;
  text: string;
}

export interface ZaehlerStand {
  meterNumber: string;
  medium: string;
  istHauptzaehler: boolean;
  gehoertZuEinheit: boolean;
  monat: string;
  wert: number;
  /** Letzter bekannter Stand vor diesem Monat, falls vorhanden. */
  vorher?: { monat: string; wert: number };
  /** Verbrauch des Vormonats, falls aus zwei früheren Ständen ableitbar. */
  vormonatsVerbrauch?: number;
}

/** 1. Ein Zählerstand darf nicht sinken. */
export function pruefeMonotonie(staende: ZaehlerStand[]): Abweichung[] {
  const out: Abweichung[] = [];
  for (const s of staende) {
    if (s.vorher && s.wert < s.vorher.wert) {
      out.push({
        pruefung: 'monotonie',
        zaehler: s.meterNumber,
        text: `Zähler ${s.meterNumber}: Stand sinkt von ${s.vorher.wert} (${s.vorher.monat}) `
          + `auf ${s.wert} (${s.monat}). Zählertausch, Rücksetzung oder Übertragungsfehler.`,
      });
    }
  }
  return out;
}

/**
 * 2. Die Summe der Wohnungszähler darf den Hauptzähler nicht übersteigen.
 *
 * Verglichen werden KUMULIERTE Zählerstände, nicht Monatsdifferenzen. Grund:
 * Die Berichte protokollieren je Zähler unterschiedlich weit in den Monat
 * hinein; in der Heizperiode machen zwei Tage Unterschied mehrere hundert
 * Kilowattstunden aus und eine Monatsbilanz schlüge dauernd grundlos an. Über
 * den gesamten Zählerstand mitteln sich diese Randeffekte heraus.
 *
 * Beim Wasser zählt auch das Warmwasser mit — es kommt aus demselben
 * Hausanschluss. Bei der Wärme ist ein Überhang des Hauptzählers normal
 * (Verteilverluste, bei MG24 gemessen 21 %); gemeldet wird nur der Fall, dass
 * die Unterzähler MEHR messen als der Hauptzähler.
 */
export function pruefeBilanz(
  staende: ZaehlerStand[], schwellen: Schwellen,
): Abweichung[] {
  const out: Abweichung[] = [];
  const gruppen: { name: string; haupt: string[]; unter: string[]; toleranz: number }[] = [
    { name: 'wasserbilanz', haupt: ['cold_water'], unter: ['cold_water', 'warm_water'],
      toleranz: schwellen.wasserToleranzProzent },
    { name: 'waermebilanz', haupt: ['heat'], unter: ['heat'],
      toleranz: schwellen.waermeToleranzProzent },
  ];

  for (const g of gruppen) {
    const haupt = staende.find(s => s.istHauptzaehler && g.haupt.includes(s.medium));
    if (!haupt || haupt.wert <= 0) continue;
    const unter = staende.filter(s => s.gehoertZuEinheit && g.unter.includes(s.medium));
    if (unter.length === 0) continue;

    const summeUnter = unter.reduce((n, s) => n + s.wert, 0);
    if (summeUnter <= 0) continue;

    const grenze = haupt.wert * (1 + g.toleranz / 100);
    if (summeUnter > grenze) {
      out.push({
        pruefung: g.name,
        text: `${g.name === 'wasserbilanz' ? 'Wasser' : 'Wärme'}: Die Wohnungszähler stehen zusammen bei `
          + `${summeUnter.toFixed(2)}, der Hauptzähler ${haupt.meterNumber} nur bei ${haupt.wert.toFixed(2)} `
          + `(zulässig bis ${grenze.toFixed(2)}, Toleranz ${g.toleranz} %).`,
      });
    }
  }
  return out;
}

/**
 * 3. Ein Monatsverbrauch um ein Vielfaches über dem Vormonat.
 *
 * Nur für Wasser. Heizung ist von Natur aus saisonal: Der Sprung von zwei
 * Kilowattstunden im August auf zweihundertsechzig im Oktober ist der
 * Normalfall und keine Abweichung. Eine Schwelle, die darauf anschlägt,
 * meldet jeden Herbst dasselbe und wird deshalb bald ignoriert — genau das
 * soll die Meldungsdisziplin verhindern.
 */
export function pruefeSprung(staende: ZaehlerStand[], schwellen: Schwellen): Abweichung[] {
  const out: Abweichung[] = [];
  for (const s of staende) {
    if (s.medium === 'heat') continue;
    if (!s.vorher || s.vormonatsVerbrauch === undefined) continue;
    if (s.vormonatsVerbrauch <= 0) continue;
    const jetzt = s.wert - s.vorher.wert;
    if (jetzt > s.vormonatsVerbrauch * schwellen.sprungFaktor) {
      out.push({
        pruefung: 'sprung',
        zaehler: s.meterNumber,
        text: `Zähler ${s.meterNumber}: Verbrauch ${s.monat} ist ${jetzt.toFixed(2)} gegenüber `
          + `${s.vormonatsVerbrauch.toFixed(2)} im Vormonat — mehr als das `
          + `${schwellen.sprungFaktor}-fache.`,
      });
    }
  }
  return out;
}

/**
 * 4. Fehlt der Monatsbericht? Geprüft wird ab dem im Objekt hinterlegten Tag
 * des Folgemonats — vorher ist Verspätung normal.
 */
export function pruefeFehlenderBericht(
  letzterMonat: string | null, heute: Date, schwellen: Schwellen,
): Abweichung[] {
  if (heute.getUTCDate() < schwellen.berichtFaelligTag) return [];
  const vormonat = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth() - 1, 1))
    .toISOString().slice(0, 7);
  if (letzterMonat && letzterMonat >= vormonat) return [];
  return [{
    pruefung: 'bericht_fehlt',
    text: `Für ${vormonat} liegt kein Monatsbericht vor (zuletzt: ${letzterMonat || 'keiner'}). `
      + `Fällig war er bis zum ${schwellen.berichtFaelligTag}. des Folgemonats.`,
  }];
}

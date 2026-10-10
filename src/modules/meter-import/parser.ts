/**
 * meter-import/parser — Monatsbericht der Gebäudeautomation lesen.
 *
 * Aufbau eines Berichts: Zeile 1 trägt Objekt und Ebene
 * („Badhaus Tuttlingen - Report Zähler Wohnung E1"), darunter steht je Zähler
 * eine Spaltengruppe aus Zeitstempel, Zählerstand und „Verbrauch Vormonat".
 *
 * WICHTIG: Die Spalte „Verbrauch Vormonat" ist unbrauchbar. Jeder Bericht
 * enthält nur die letzten rund hundert Protokollzeilen; bei einem Zähler, der
 * sich stündlich meldet, deckt das wenige Tage ab. Für MG24 nachgerechnet:
 * Die Berichtsspalten summieren sich für Juni bis Dezember 2025 auf 3.700 kWh,
 * tatsächlich waren es rund 17.300 kWh. Gelesen werden deshalb ausschließlich
 * die absoluten Zählerstände.
 */
import * as XLSX from 'xlsx';

export interface Stand {
  /** Spaltenüberschrift des Zählers, klein geschrieben. */
  gruppe: string;
  /** Zeitstempel des Protokolleintrags, ISO-nah: "2026-02-28 07:50". */
  zeitpunkt: string;
  wert: number;
}

export interface Bericht {
  /** Erste Zeile des Blattes, Grundlage der Objektzuordnung. */
  ueberschrift: string;
  /** "E0".."E3" — aus der Überschrift. */
  ebene: string | null;
  /** Alle gelesenen Stände, chronologisch. */
  staende: Stand[];
}

const ZEITSTEMPEL = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/;

/** Erkennt "E0".."E9" in der Überschrift. */
export function ebeneAus(ueberschrift: string): string | null {
  const m = String(ueberschrift || '').match(/\bE(\d)\b/);
  return m ? `E${m[1]}` : null;
}

/**
 * Liest eine XLSX-Anlage. Mehrere Blätter werden zusammengeführt — die
 * Jahresauswertungen tragen ein Blatt je Monat.
 */
export function leseBericht(datei: Buffer): Bericht {
  const wb = XLSX.read(datei, { type: 'buffer' });
  let ueberschrift = '';
  const staende: Stand[] = [];

  for (const blattName of wb.SheetNames) {
    if (blattName.toLowerCase() === 'summe') continue; // Zusammenfassung, keine Stände
    const zeilen: string[][] = XLSX.utils.sheet_to_json(wb.Sheets[blattName], {
      header: 1, raw: false, defval: '',
    }) as string[][];
    if (zeilen.length === 0) continue;

    if (!ueberschrift) {
      ueberschrift = (zeilen[0] || []).map(c => String(c)).join(' ').trim();
    }

    /* Gruppenüberschriften stehen in einer der ersten vier Zeilen, jeweils in
       der ERSTEN Spalte einer Vierergruppe (Zeitstempel, Stand, Verbrauch,
       Leerspalte). Die Reihenfolge der Gruppen wechselt zwischen Berichten,
       deshalb wird sie Spalte für Spalte bestimmt statt vorausgesetzt. */
    const gruppen: Record<number, string> = {};
    for (let i = 0; i < Math.min(4, zeilen.length); i++) {
      (zeilen[i] || []).forEach((zelle, idx) => {
        const text = String(zelle).trim();
        if (idx % 4 === 0 && /zähler/i.test(text)) gruppen[idx] = text.toLowerCase();
      });
    }

    for (const [spalteStr, gruppe] of Object.entries(gruppen)) {
      const spalte = Number(spalteStr);
      for (let i = 1; i < zeilen.length; i++) {
        const zeile = zeilen[i] || [];
        const ts = String(zeile[spalte] ?? '').trim();
        const roh = String(zeile[spalte + 1] ?? '').trim();
        const m = ts.match(ZEITSTEMPEL);
        if (!m || !roh) continue;
        const wert = Number(roh);
        if (!Number.isFinite(wert)) continue;
        staende.push({ gruppe, zeitpunkt: `${m[1]} ${m[2]}`, wert });
      }
    }
  }

  staende.sort((a, b) => a.zeitpunkt.localeCompare(b.zeitpunkt));
  return { ueberschrift, ebene: ebeneAus(ueberschrift), staende };
}

/**
 * Je Zähler und Kalendermonat der LETZTE protokollierte Stand. Das ist der
 * Wert, der in die Abrechnung geht — Monatsendstände, keine Tagesreihe.
 */
export function monatsStaende(staende: Stand[]): Map<string, Stand[]> {
  const jeGruppe = new Map<string, Map<string, Stand>>();
  for (const s of staende) {
    const monat = s.zeitpunkt.slice(0, 7);
    if (!jeGruppe.has(s.gruppe)) jeGruppe.set(s.gruppe, new Map());
    const bisher = jeGruppe.get(s.gruppe)!.get(monat);
    if (!bisher || s.zeitpunkt > bisher.zeitpunkt) jeGruppe.get(s.gruppe)!.set(monat, s);
  }
  const ergebnis = new Map<string, Stand[]>();
  for (const [gruppe, proMonat] of jeGruppe) {
    ergebnis.set(gruppe, [...proMonat.values()].sort((a, b) => a.zeitpunkt.localeCompare(b.zeitpunkt)));
  }
  return ergebnis;
}

/**
 * Wärmemengen stehen in den Berichten in Wh, die Leittechnik zeigt kWh.
 * Gespeichert wird kWh, damit beide Quellen vergleichbar bleiben.
 */
export function einheitFuer(meterNumber: string): { einheit: string; teiler: number } {
  return meterNumber.includes('WMZ')
    ? { einheit: 'kWh', teiler: 1000 }
    : { einheit: 'm³', teiler: 1 };
}

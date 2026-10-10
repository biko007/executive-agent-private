/**
 * meter-import/config — Zuordnung Bericht → Zähler, als Daten statt im Code.
 *
 * Die Monatsberichte der Gebäudeautomation nennen keine Zählernummern, nur
 * Spaltenüberschriften („Wärmemengenzähler Süd/West") und eine Ebene („E1").
 * Welche davon zu welchem Zähler der Datenbank gehört, steht deshalb in
 * `system_settings` unter dem Schlüssel `meter_import_mapping` — ein weiteres
 * Objekt braucht dort einen Block und sonst nichts.
 *
 * Fehlt die Zuordnung, wird NICHT geraten: Der Import meldet das einmal und
 * lässt den Bericht liegen.
 */
import { getSetting, setSetting } from '../../shared/settings/index.js';

export const MAPPING_KEY = 'meter_import_mapping';

/** Schwellen der Plausibilitätsprüfungen. Alle Angaben überschreibbar. */
export interface Schwellen {
  /** Zulässiger Überhang der Wohnungszähler über den Hauptzähler, Wasser. */
  wasserToleranzProzent: number;
  /** Dasselbe für Wärme — Verteilverluste sind hier normal. */
  waermeToleranzProzent: number;
  /** Ab welchem Vielfachen des Vormonats ein Sprung gemeldet wird. */
  sprungFaktor: number;
  /** Bis zu welchem Tag des Folgemonats ein Bericht da sein muss. */
  berichtFaelligTag: number;
}

export const SCHWELLEN_VORGABE: Schwellen = {
  wasserToleranzProzent: 5,
  waermeToleranzProzent: 35,
  sprungFaktor: 3,
  berichtFaelligTag: 10,
};

export interface ObjektZuordnung {
  /** property.code, z. B. "mg24". */
  property: string;
  /** Ebene → { Spaltenüberschrift → meter_number }. */
  ebenen: Record<string, Record<string, string>>;
  /** Abweichende Schwellen für dieses Objekt. */
  schwellen?: Partial<Schwellen>;
  /**
   * Bekannte, bereits gemeldete Abweichungen. Solange das Datum in der
   * Zukunft liegt, wandert die Prüfung in die Wochenzeile statt jedes Mal
   * eine Meldung auszulösen — sonst erzeugt ein offener Befund monatelang
   * dieselbe Nachricht.
   */
  bekannteAbweichungen?: { pruefung: string; bis: string; grund: string }[];
}

export type Mapping = Record<string, ObjektZuordnung>;

/**
 * Erstbefüllung für MG24. Wird nur angelegt, wenn unter dem Schlüssel noch
 * nichts steht — eine vorhandene Zuordnung wird nie überschrieben.
 */
export const MAPPING_MG24: Mapping = {
  'badhaus tuttlingen': {
    property: 'mg24',
    ebenen: {
      E0: {
        'kaltwasserzähler hausanschluss': 'MG24-KW-HAUSANSCHLUSS',
        'wärmemengenzähler heizung gesamt': 'MG24-WMZ-HEIZUNG-GESAMT',
        'wärmemengenzähler warmwasser gesamt': 'MG24-WMZ-WARMWASSER-GESAMT',
      },
      E1: {
        'kaltwasserzähler': 'MG24-W1-KW',
        'warmwasserzähler': 'MG24-W1-WW',
        'wärmemengenzähler süd/west': 'MG24-W1-WMZ-SW',
        'wärmemengenzähler nord/ost': 'MG24-W1-WMZ-NO',
      },
      E2: {
        'kaltwasserzähler': 'MG24-W2-KW',
        'warmwasserzähler': 'MG24-W2-WW',
        'wärmemengenzähler süd/west': 'MG24-W2-WMZ-SW',
        'wärmemengenzähler nord/ost': 'MG24-W2-WMZ-NO',
      },
      E3: {
        'kaltwasserzähler': 'MG24-W3-KW',
        'warmwasserzähler': 'MG24-W3-WW',
        'wärmemengenzähler süd/west': 'MG24-W3-WMZ-SW',
        'wärmemengenzähler nord/ost': 'MG24-W3-WMZ-NO',
      },
    },
    bekannteAbweichungen: [
      {
        pruefung: 'wasserbilanz',
        bis: '2027-01-01',
        grund: 'Der Kaltwasserzähler am Hausanschluss zählt um ein Vielfaches zu wenig — '
          + 'die Stadtwerke berechnen für 2025 437 m³, die Leittechnik weist 38,5 m³ aus. '
          + 'Klärung mit Fa. Fiehn läuft; bis dahin keine Einzelmeldung je Lauf.',
      },
    ],
  },
};

/** Zuordnung lesen; legt beim ersten Aufruf die MG24-Vorbelegung an. */
export async function ladeMapping(): Promise<Mapping> {
  const vorhanden = await getSetting<Mapping>(MAPPING_KEY);
  if (vorhanden && Object.keys(vorhanden).length > 0) return vorhanden;
  await setSetting(MAPPING_KEY, MAPPING_MG24);
  return MAPPING_MG24;
}

/** Welches Objekt gehört zu dieser Berichtsüberschrift? */
export function findeObjekt(mapping: Mapping, ueberschrift: string): { schluessel: string; zuordnung: ObjektZuordnung } | null {
  const h = String(ueberschrift || '').toLowerCase();
  for (const [schluessel, zuordnung] of Object.entries(mapping)) {
    if (h.includes(schluessel)) return { schluessel, zuordnung };
  }
  return null;
}

/** Schwellen des Objekts über die Vorgabewerte gelegt. */
export function schwellenFuer(zuordnung: ObjektZuordnung): Schwellen {
  return { ...SCHWELLEN_VORGABE, ...(zuordnung.schwellen || {}) };
}

/** Ist diese Prüfung für das Objekt derzeit als bekannt abgehakt? */
export function istBekannt(zuordnung: ObjektZuordnung, pruefung: string, heute = new Date()): string | null {
  for (const b of zuordnung.bekannteAbweichungen || []) {
    if (b.pruefung !== pruefung) continue;
    if (new Date(b.bis) > heute) return b.grund;
  }
  return null;
}

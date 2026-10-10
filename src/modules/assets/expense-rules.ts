/**
 * assets/expense-rules — Regeln, die aus einem Bankumsatz einen
 * Buchungsvorschlag machen.
 *
 * Die Regeln liegen als JSON in `system_settings` unter dem Schlüssel
 * `expense_rules` und nicht im Code. Grund: Eine neue Gegenpartei, eine
 * geänderte Vertragsnummer oder ein neues Objekt sind laufende Pflege und
 * dürfen kein Deployment kosten. Der Startbestand unten wird nur verwendet,
 * solange in `system_settings` nichts steht.
 *
 * Was eine Regel NICHT tut: buchen. Sie erzeugt einen Vorschlag, den der Owner
 * bestätigt oder verwirft. Deshalb ist eine Regel mit mittlerer Sicherheit
 * nützlich und keine Gefahr — sie legt dem Owner eine begründete Vermutung vor,
 * statt den Umsatz unbeachtet zu lassen.
 */
import { query as dbQuery } from '../../shared/db/index.js';

export const REGEL_KEY = 'expense_rules';

export type Leistungszeitraum =
  | 'kalenderjahr'       // 01.01.–31.12. des Buchungsjahres
  | 'jahresabrechnung'   // Abrechnungsjahr aus dem Verwendungszweck, sonst Vorjahr
  | 'rechnungsmonat'     // Monat der Buchung (Abschlagszahlungen)
  | 'referenzzeitraum'   // zwei Datumsangaben im Verwendungszweck
  | 'lieferdatum';       // Buchungstag (einmalige Lieferung)

export interface AusgabenRegel {
  id: string;
  /** `properties.code`, z. B. 'mg24'. */
  property: string;
  match: {
    /** Regulärer Ausdruck gegen die Gegenpartei. Immer ohne Rücksicht auf Groß-/Kleinschreibung. */
    counterparty?: string;
    /** Regulärer Ausdruck gegen den Verwendungszweck. */
    reference?: string;
    /** Grenzen auf den Betrag, verglichen wird der Absolutwert. */
    amount_min?: number;
    amount_max?: number;
    amount_exact?: number;
    /**
     * Grenzen auf das Buchungsdatum (ISO). Damit laesst sich eine Regel auf die
     * Betriebsphase eines Objekts begrenzen: Zahlungen fuer dasselbe
     * Versorgungskonto sind vor der Schlussabnahme Herstellungsaufwand und
     * danach umlagefaehige Betriebskosten. Ohne diese Grenze wuerde die Regel
     * Baukosten als Nebenkosten vorschlagen.
     */
    date_min?: string;
    date_max?: string;
  };
  /** `cost_categories.code`. */
  cost_category: string;
  umlagefaehig: boolean;
  service_period: Leistungszeitraum;
  /** Anteil des Objekts am Zahlbetrag; 1 = ganz. */
  anteil: number;
  sicherheit: 'hoch' | 'mittel' | 'niedrig';
  hinweis?: string;
  aktiv?: boolean;
}

/**
 * Startbestand aus Paket 1 und 2 — jede Regel steht auf einem Beleg oder auf
 * einer im Bestand nachgewiesenen Gegenpartei.
 *
 * Bewusst NICHT enthalten: Gegenparteien, deren Objektzuordnung ungeklärt ist.
 * Die drei Abfall-Buchungszeichen 28635, 42348 und 48030 im Bestand gehören
 * nicht zu MG24 — MG24 trägt laut Änderungsbescheid 73 058 488/001. Eine Regel
 * auf eine fremde Objektnummer würde Kosten dem falschen Haus zuordnen, und das
 * fällt in einer fertigen Abrechnung niemandem mehr auf.
 *
 * Alle MG24-Betriebskostenregeln beginnen am 05.11.2024, dem Tag nach der
 * Schlussabnahme (K8). Zahlungen auf dieselben Versorgungskonten davor sind
 * Herstellungsaufwand und werden bewusst NICHT vorgeschlagen: Sie gehören
 * einzeln beurteilt und nicht über eine Dauerregel in die Nebenkosten.
 */
export const REGELN_START: AusgabenRegel[] = [
  {
    id: 'mg24-swt-wasser-307008',
    property: 'mg24',
    // amount_max grenzt gegen die Jahresabrechnung ab: Ohne diese Grenze
    // träfen beide Wasserregeln denselben Umsatz und erzeugten zwei Vorschläge.
    match: { counterparty: 'stadtwerke', reference: '307008', amount_max: 499.99, date_min: '2024-11-05' },
    cost_category: 'wasser',
    umlagefaehig: true,
    service_period: 'rechnungsmonat',
    anteil: 1,
    sicherheit: 'hoch',
    hinweis: 'SWT Kd 133224, Vertrag 307008 (Wasser/Abwasser) Marktgasse 24. '
      + 'Monatliche Abschläge; die Jahresabrechnung kommt über die Regel mg24-swt-wasser-jahr.',
  },
  {
    id: 'mg24-swt-wasser-jahr',
    property: 'mg24',
    match: { counterparty: 'stadtwerke', reference: '307008', amount_min: 500, date_min: '2024-11-05' },
    cost_category: 'wasser',
    umlagefaehig: true,
    service_period: 'jahresabrechnung',
    anteil: 1,
    sicherheit: 'hoch',
    hinweis: 'SWT Jahresabrechnung Wasser. Ab 500 Euro ist es keine Abschlagszahlung mehr; '
      + 'der Leistungszeitraum ist das abgerechnete Jahr, nicht der Zahlungsmonat.',
  },
  {
    id: 'mg24-swt-strom-348661',
    property: 'mg24',
    match: { counterparty: 'stadtwerke', reference: '348661', date_min: '2024-11-05' },
    cost_category: 'sonstige_betrkv',
    umlagefaehig: false,
    service_period: 'rechnungsmonat',
    anteil: 1,
    sicherheit: 'niedrig',
    hinweis: 'SWT Vertrag 348661 (Allgemeinstrom), Belieferung endete 02.09.2025. '
      + 'Umlagefähigkeit bewusst auf nein voreingestellt: Der Anteil für Bauphase bis zur '
      + 'Schlussabnahme 04.11.2024 und für Leerstand ist ohne Schlussrechnung nicht abgrenzbar. '
      + 'Beim Bestätigen prüfen und gegebenenfalls umstellen.',
  },
  {
    id: 'mg24-swt-387849',
    property: 'mg24',
    match: { counterparty: 'stadtwerke', reference: '387849', date_min: '2024-11-05' },
    cost_category: 'sonstige_betrkv',
    umlagefaehig: false,
    service_period: 'rechnungsmonat',
    anteil: 1,
    sicherheit: 'niedrig',
    hinweis: 'SWT Vertrag 387849 Marktgasse 24 — Zweck des Vertrags ist nicht belegt '
      + '(Kleinbeträge 9 bis 15 Euro monatlich). Kostenart vor dem Bestätigen prüfen.',
  },
  {
    id: 'mg24-swt-baustrom-328879',
    property: 'mg24',
    // Getrennt von der Jahresrechnung, weil ein monatlicher Abschlag den Monat
    // abdeckt, in dem er bezahlt wird — nicht ein Abrechnungsjahr.
    match: { counterparty: 'stadtwerke', reference: '328879', amount_max: 499.99 },
    cost_category: 'modernisierung',
    umlagefaehig: false,
    service_period: 'rechnungsmonat',
    anteil: 1,
    sicherheit: 'hoch',
    hinweis: 'SWT Kd 492014, Vertrag 328879 = Baustrom, monatlicher Abschlag. Gehört zur '
      + 'Bauphase vor der Schlussabnahme am 04.11.2024 und ist damit Herstellungsaufwand '
      + '(K8), nicht umlagefähig.',
  },
  {
    id: 'mg24-swt-baustrom-328879-jahr',
    property: 'mg24',
    match: { counterparty: 'stadtwerke', reference: '328879', amount_min: 500 },
    cost_category: 'modernisierung',
    umlagefaehig: false,
    service_period: 'jahresabrechnung',
    anteil: 1,
    sicherheit: 'hoch',
    hinweis: 'SWT Baustrom-Jahresrechnung (3.042,69 Euro am 21.03.2025 für 2024). '
      + 'Herstellungsaufwand nach K8, nicht umlagefähig.',
  },
  {
    id: 'mg24-new-allgemeinstrom',
    property: 'mg24',
    match: { counterparty: 'NEW ?Niederr', reference: '204659575', date_min: '2024-11-05' },
    cost_category: 'sonstige_betrkv',
    umlagefaehig: true,
    service_period: 'rechnungsmonat',
    anteil: 1,
    sicherheit: 'hoch',
    hinweis: 'NEW Vertragskonto 204659575, Allgemeinstrom Marktgasse 24 — Nachfolger des '
      + 'SWT-Vertrags 348661 ab 09/2025. Ab hier reiner Betrieb, daher umlagefähig.',
  },
  {
    id: 'mg24-vohrer-gebaeudeversicherung',
    property: 'mg24',
    match: { counterparty: 'vohrer', reference: '130010036764411036', date_min: '2024-11-05' },
    cost_category: 'versicherung',
    umlagefaehig: true,
    service_period: 'referenzzeitraum',
    anteil: 0.982,
    sicherheit: 'hoch',
    hinweis: 'Police Vohrer/Helvetia 26.02.2025, Vertrag 130010036764411036 für '
      + '"Wohngebaeude Marktgasse 22 + 24". Anteil MG24 = 98,2001 % aus den '
      + 'Versicherungssummen Wert 1914 (185.500 von 188.900 M); die restlichen 1,8 % '
      + 'sind die drei Garagen Marktgasse 22.',
  },
  {
    id: 'mg24-energiekonzept-waerme',
    property: 'mg24',
    match: { counterparty: 'energiekonzept', reference: '11142', amount_min: 100, date_min: '2024-11-05' },
    cost_category: 'heizung',
    umlagefaehig: true,
    service_period: 'jahresabrechnung',
    anteil: 1,
    sicherheit: 'mittel',
    hinweis: 'Energiekonzept Ortenau, KNr 11142, Vertrag 390-A01-001. Sicherheit mittel, '
      + 'weil die benachbarte Kundennummer 11042 zu N24 gehört — Kundennummer vor dem '
      + 'Bestätigen gegen die Rechnung halten. Einmalige Einrichtungsgebühren sind '
      + 'Herstellungsaufwand und gehören nicht hierher. Das Abrechnungsjahr wird aus dem '
      + 'Verwendungszweck gelesen; steht dort nur ein zweistelliges Datum, gilt bei Zahlung '
      + 'im ersten Halbjahr das Vorjahr — bei einer laufenden Rechnung statt einer '
      + 'Jahresabrechnung ist der Zeitraum deshalb zu prüfen.',
  },
  {
    id: 'mg24-landkreis-abfall',
    property: 'mg24',
    match: { counterparty: 'landkreis', reference: '73[ ]?058[ ]?488|00730-58488', date_min: '2024-11-05' },
    cost_category: 'strassenreinigung_muell',
    umlagefaehig: true,
    service_period: 'jahresabrechnung',
    anteil: 1,
    sicherheit: 'hoch',
    hinweis: 'Landkreis Tuttlingen, Buchungszeichen 73 058 488/001, Objekt 001 Marktgasse 24 '
      + '(Änderungsbescheid 16.05.2025: 1x Bio 240 l + 3x Rest 360 l). Die übrigen '
      + 'Abfall-Buchungszeichen im Bestand gehören zu anderen Objekten.',
  },
  {
    id: 'mg24-pellets',
    property: 'mg24',
    match: { counterparty: 'koch|brennstoff|pellet', amount_min: 200, date_min: '2024-11-05' },
    cost_category: 'heizung',
    umlagefaehig: true,
    service_period: 'lieferdatum',
    anteil: 1,
    sicherheit: 'hoch',
    hinweis: 'Pelletlieferung für die Zentralheizung MG24. Leistungszeitraum ist das '
      + 'Lieferdatum. Im heutigen Umsatzbestand kommt keine Pelletlieferung vor — die '
      + 'Regel greift ab der ersten Lieferung, die über dieses Konto bezahlt wird.',
  },
];

/** Liest die Regeln aus den Einstellungen; ohne Eintrag gilt der Startbestand. */
export async function ladeRegeln(): Promise<AusgabenRegel[]> {
  const { rows } = await dbQuery<{ value: any }>(
    'SELECT value FROM system_settings WHERE key = $1', [REGEL_KEY],
  );
  if (rows.length === 0) return REGELN_START;
  const wert = rows[0].value;
  const liste = Array.isArray(wert) ? wert : wert?.regeln;
  if (!Array.isArray(liste) || liste.length === 0) return REGELN_START;
  return liste as AusgabenRegel[];
}

/**
 * Baut einen regulären Ausdruck aus einem Regelmuster.
 *
 * Ein vorangestelltes `(?i)` wird entfernt: Diese Schreibweise kommt aus
 * Postgres und PCRE, JavaScript kennt sie nicht und würde sie als Textsuche
 * behandeln. Verglichen wird ohnehin immer ohne Rücksicht auf Groß- und
 * Kleinschreibung.
 */
export function muster(ausdruck: string): RegExp {
  return new RegExp(ausdruck.replace(/^\(\?i\)/, ''), 'i');
}

export interface UmsatzZeile {
  id: number;
  booking_date: string;
  value_date?: string | null;
  amount: number;
  counterparty_name?: string | null;
  reference?: string | null;
}

/** Trifft die Regel auf den Umsatz zu? Nur Zahlungsausgänge werden betrachtet. */
export function trifft(regel: AusgabenRegel, u: UmsatzZeile): boolean {
  if (regel.aktiv === false) return false;
  if (!(u.amount < 0)) return false;

  const betrag = Math.abs(u.amount);
  const m = regel.match || {};
  if (m.amount_exact !== undefined && Math.abs(betrag - m.amount_exact) > 0.005) return false;
  if (m.amount_min !== undefined && betrag < m.amount_min) return false;
  if (m.amount_max !== undefined && betrag > m.amount_max) return false;

  if (m.date_min && u.booking_date < m.date_min) return false;
  if (m.date_max && u.booking_date > m.date_max) return false;

  if (m.counterparty && !muster(m.counterparty).test(u.counterparty_name || '')) return false;
  if (m.reference && !muster(m.reference).test(u.reference || '')) return false;

  // Eine Regel ohne inhaltliches Muster würde jeden Zahlungsausgang treffen —
  // Datums- und Betragsgrenzen allein genügen dafür nicht.
  if (!m.counterparty && !m.reference && m.amount_exact === undefined) return false;

  return true;
}

function jahresEnde(jahr: number): [string, string] {
  return [`${jahr}-01-01`, `${jahr}-12-31`];
}

/** `17.02.2025` oder `2025-02-17` → ISO-Datum. */
function datumAus(text: string): string | null {
  const de = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (de) return `${de[3]}-${de[2]}-${de[1]}`;
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

/**
 * Leitet den Leistungszeitraum ab — nach dem Leistungsprinzip, nicht nach dem
 * Zahlungszeitpunkt. Eine Wasserjahresrechnung für 2025, die im März 2026
 * abgebucht wird, gehört in die Abrechnung 2025.
 */
export function leistungszeitraum(
  art: Leistungszeitraum, u: UmsatzZeile,
): { start: string; ende: string } {
  const jahr = parseInt(u.booking_date.slice(0, 4), 10);
  const monat = u.booking_date.slice(0, 7);
  const zweck = u.reference || '';

  switch (art) {
    case 'rechnungsmonat': {
      const letzter = new Date(Date.UTC(jahr, parseInt(monat.slice(5, 7), 10), 0))
        .toISOString().slice(0, 10);
      return { start: `${monat}-01`, ende: letzter };
    }

    case 'lieferdatum':
      return { start: u.booking_date, ende: u.booking_date };

    case 'referenzzeitraum': {
      // Zwei Datumsangaben im Verwendungszweck, etwa "01.01.2025 - 01.01.2026".
      const treffer = zweck.match(/(\d{2}\.\d{2}\.\d{4})/g);
      if (treffer && treffer.length >= 2) {
        const a = datumAus(treffer[0])!;
        const b = datumAus(treffer[1])!;
        // Versicherungsjahre laufen "bis 01.01." des Folgejahres; der
        // Leistungszeitraum endet aber am 31.12.
        const ende = b.endsWith('-01-01')
          ? `${parseInt(b.slice(0, 4), 10) - 1}-12-31` : b;
        if (ende >= a) return { start: a, ende };
      }
      const [s, e] = jahresEnde(jahr);
      return { start: s, ende: e };
    }

    case 'jahresabrechnung': {
      // Jahreszahl aus dem Verwendungszweck, sonst: Zahlung im ersten Halbjahr
      // rechnet das Vorjahr ab.
      const jahre = (zweck.match(/\b(20\d{2})\b/g) || [])
        .map(j => parseInt(j, 10))
        .filter(j => j >= 2000 && j <= jahr);
      const ziel = jahre.length > 0 ? Math.max(...jahre)
        : (parseInt(u.booking_date.slice(5, 7), 10) <= 6 ? jahr - 1 : jahr);
      const [s, e] = jahresEnde(ziel);
      return { start: s, ende: e };
    }

    case 'kalenderjahr':
    default: {
      const [s, e] = jahresEnde(jahr);
      return { start: s, ende: e };
    }
  }
}

/** Betrag der Buchung: Zahlbetrag als positiver Wert mal Anteil, auf Cent gerundet. */
export function anteiligerBetrag(amount: number, anteil: number): number {
  return Math.round(Math.abs(amount) * anteil * 100) / 100;
}

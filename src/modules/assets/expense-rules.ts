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

/**
 * Ein Beleg, der über eine Sammelüberweisung bezahlt wird.
 *
 * Bei Sammelüberweisungen liefert die Bank weder Gegenpartei noch
 * Verwendungszweck — nur den Buchungsschlüssel SAMMELUEBERWEISUNG und bei
 * mehreren Posten „ANZAHL n". Eine Regel auf die Gegenpartei kann dort
 * grundsätzlich nicht greifen. Erkennbar ist eine solche Zahlung allein am
 * Betrag, und zwar gegen die bekannten Rechnungen.
 */
export interface Rechnung {
  /** Rechnungsnummer, soweit bekannt. */
  nr?: string;
  betrag: number;
  /** Leistungsdatum (Lieferung, Leistung). Fehlt es, gilt der Zahltag. */
  lieferdatum?: string;
  hinweis?: string;
}

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
  /**
   * Rechnungsabgleich statt Musterabgleich. Trägt eine Regel diese Liste,
   * werden ihre Muster NICHT ausgewertet; stattdessen wird versucht, den Betrag
   * einer Sammelüberweisung aus diesen Rechnungen zu erklären.
   */
  rechnungen?: Rechnung[];
}

/** Buchungsschlüssel, unter dem die Bank Sammelüberweisungen führt. */
export const SAMMEL_CODE = /sammel/i;

/** Arbeitet die Regel über den Rechnungsabgleich? */
export function istRechnungsregel(regel: AusgabenRegel): boolean {
  return Array.isArray(regel.rechnungen);
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
      + 'Umlagefähigkeit bleibt auf nein, bis die Schlussrechnung nach Zeiträumen '
      + 'aufgeteilt ist: 16.11.–31.12.2024 Bauphase, 01.01.–16.06.2025 Allgemeinstrom, '
      + '17.06.–20.08.2025 Bezug über die Kundenanlage. Diese Aufteilung macht Paket 3b '
      + 'aus der Schlussrechnung; danach werden die Vorschläge je Zeitraum neu erzeugt. '
      + 'Vorher nicht übernehmen.',
  },
  {
    id: 'mg24-swt-387849',
    property: 'mg24',
    match: { counterparty: 'stadtwerke', reference: '387849', date_min: '2024-11-05' },
    cost_category: 'wasser',
    umlagefaehig: true,
    service_period: 'rechnungsmonat',
    anteil: 1,
    sicherheit: 'hoch',
    hinweis: 'SWT Vertrag 387849 = Marktgasse 24 (Wasser), laut Kundenportal. SWT trennt '
      + 'ab 2026 die Sparten: je Sparte eine eigene Rechnung, Wasser und Fernwärme mit '
      + 'Jahresrechnung zum 31.12. Der Abschlag deckt den Zahlungsmonat.',
  },
  {
    id: 'mg24-swt-387847-abwasser',
    property: 'mg24',
    match: { counterparty: 'stadtwerke', reference: '387847', date_min: '2024-11-05' },
    cost_category: 'entwaesserung',
    umlagefaehig: true,
    service_period: 'rechnungsmonat',
    anteil: 1,
    sicherheit: 'hoch',
    hinweis: 'SWT Vertrag 387847 = Marktgasse 24 (Abwasser), Gegenstück zu 387849 aus der '
      + 'Spartentrennung ab 2026. Im heutigen Bestand noch ohne Zahlung — die Regel greift '
      + 'ab der ersten Abbuchung auf diesen Vertrag.',
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
    id: 'mg24-energiekonzept-mieterstrom-abrechnungsdienst',
    property: 'mg24',
    match: { counterparty: 'energiekonzept', reference: '11142', amount_min: 100, date_min: '2024-11-05' },
    cost_category: 'sonstige_betrkv',
    umlagefaehig: false,
    service_period: 'jahresabrechnung',
    anteil: 1,
    sicherheit: 'mittel',
    hinweis: 'Energiekonzept Ortenau, KNr 11142, Vertrag 390-A01-001 — Objekt MG24 ist '
      + 'belegt (11042 gehört zu N24). Das ist KEIN Wärmeposten, sondern der '
      + 'Abrechnungsdienst der Mieterstrom-Kundenanlage einschliesslich 600 Euro '
      + 'Einrichtung: Betreiberkosten des Mieterstrommodells und damit kein BetrKV-Posten. '
      + 'Deshalb vorerst nicht umlagefähig; die endgültige Einstufung fällt in Paket 3c '
      + 'Teil C (denkbar bleibt ein anteiliger Messstellenbetrieb des Allgemeinzählers). '
      + 'Das Abrechnungsjahr wird aus dem Verwendungszweck gelesen; steht dort nur ein '
      + 'zweistelliges Datum, gilt bei Zahlung im ersten Halbjahr das Vorjahr.',
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
    // Rechnungsabgleich statt Gegenpartei-Muster: Die Pelletrechnungen werden
    // über Sammelüberweisungen bezahlt, bei denen die Bank weder Gegenpartei
    // noch Verwendungszweck liefert. Eine Regel auf "koch" könnte dort nie
    // greifen — und Pellets sind der groesste Nebenkostenposten von MG24.
    match: {},
    rechnungen: [
      { nr: '101657', betrag: 2173.79, lieferdatum: '2025-03-11' },
      { nr: '106971', betrag: 1502.39, lieferdatum: '2025-09-25' },
      { nr: '109505', betrag: 1758.95, lieferdatum: '2025-12-15' },
      { nr: '201056', betrag: 1844.98, lieferdatum: '2026-02-09' },
      { nr: '202625', betrag: 1707.61, lieferdatum: '2026-04-22' },
    ],
    cost_category: 'heizung',
    umlagefaehig: true,
    service_period: 'lieferdatum',
    anteil: 1,
    sicherheit: 'hoch',
    hinweis: 'Pelletlieferungen Matthias Koch Brennstoffe für die Zentralheizung MG24. '
      + 'Leistungszeitraum ist das Lieferdatum, nicht der Zahltag. Die fünf Rechnungen '
      + 'stammen aus der Belegauswertung von Paket 1 und 2; eine neue Lieferung wird hier '
      + 'als Rechnung ergänzt (Einstellungen, kein Deployment). Die Zahlung vom 03.01.2025 '
      + 'über 1.695,84 Euro ist noch keiner Rechnung zugeordnet — sie gehört nach dem '
      + 'Leistungsprinzip vermutlich in 2024 und ist in Paket 3b zu klären.',
  },
  {
    id: 'reizner-rechnungen',
    property: 'n24',
    // Objektzuordnung laut Paket 2: Reizner, Maurer und Energiekonzept KD 11042
    // gehören zu N24. Die Rechnungsliste ist deshalb bewusst leer, bis die
    // Belege vorliegen — eine geratene Zuordnung würde Kosten dem falschen
    // Haus zuweisen.
    match: {},
    rechnungen: [
      {
        betrag: 128.46,
        hinweis: 'Rechnungsnummer und Leistungsdatum noch nicht belegt — Betrag aus der '
          + 'Überweisung vom 09.10.2025 (ANZAHL 2) abgeleitet, der zweite Posten ist '
          + 'Koch-Rechnung 106971 über 1.502,39 Euro. Beleg aus Postfach/SharePoint '
          + 'nachtragen; bis dahin gilt der Zahltag als Leistungsdatum.',
      },
    ],
    cost_category: 'instandhaltung',
    umlagefaehig: false,
    service_period: 'lieferdatum',
    anteil: 1,
    sicherheit: 'niedrig',
    hinweis: 'Reizner (Elektro) — wird über Sammelüberweisungen bezahlt. Objekt N24 laut '
      + 'Paket 2; Sicherheit niedrig, weil weder Rechnungsnummer noch Objektzuordnung '
      + 'dieser einen Rechnung belegt sind. Der Betrag ist nur deshalb bekannt, weil er '
      + 'die Differenz der Sammelüberweisung zur Koch-Rechnung ist.',
  },
  {
    id: 'maurer-rechnungen',
    property: 'n24',
    match: {},
    rechnungen: [],
    cost_category: 'instandhaltung',
    umlagefaehig: false,
    service_period: 'lieferdatum',
    anteil: 1,
    sicherheit: 'mittel',
    hinweis: 'H. Maurer (Heizung-Klima-Sanitär) — Sammelüberweisungen, Rechnungsliste noch '
      + 'leer. Achtung bei der Objektzuordnung: Paket 2 ordnet Maurer N24 zu, für MG24 ist '
      + 'aber ein Heizungs-Wartungsvertrag über 1.650 Euro im Jahr bekannt (Wartung '
      + '28.11.2025, Rechnung fehlt). Je Rechnung ist daher das Objekt zu prüfen; '
      + 'MG24-Rechnungen brauchen eine eigene Regel mit property mg24.',
  },
  {
    id: 'holzmanufaktur-rechnungen',
    property: 'n24',
    match: {},
    rechnungen: [],
    cost_category: 'instandhaltung',
    umlagefaehig: false,
    service_period: 'lieferdatum',
    anteil: 1,
    sicherheit: 'mittel',
    hinweis: 'Holzmanufaktur Rottweil — Sammelüberweisungen, Rechnungsliste noch leer. '
      + 'Im Bestand ist bisher nur eine Rückerstattung über 18,00 Euro zu Rechnung '
      + 'R24.0348 sichtbar (Zahlungseingang, daher kein Kostenvorschlag).',
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
  /** Buchungsschlüssel der Bank, z. B. SAMMELUEBERWEISUNG oder FOLGELASTSCHRIFT. */
  transaction_code?: string | null;
}

/** Trifft die Regel auf den Umsatz zu? Nur Zahlungsausgänge werden betrachtet. */
export function trifft(regel: AusgabenRegel, u: UmsatzZeile): boolean {
  if (regel.aktiv === false) return false;
  if (!(u.amount < 0)) return false;
  // Rechnungsregeln werden über ordneSammelueberweisungZu ausgewertet.
  if (istRechnungsregel(regel)) return false;

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

export interface RechnungsTreffer {
  regelId: string;
  rechnung: Rechnung;
  /** Wie viele Rechnungen die Zahlung zusammen erklären. */
  posten: number;
}

/**
 * Erklärt den Betrag einer Sammelüberweisung aus bekannten Rechnungen.
 *
 * Geprüft werden eine Rechnung und — weil die Bank bei zwei Posten
 * „ANZAHL 2" ausweist — Paare aus zwei Rechnungen. Die Paare dürfen aus
 * verschiedenen Regeln stammen: Eine Überweisung von 1.630,85 Euro bestand
 * tatsächlich aus einer Pelletrechnung über 1.502,39 und einer Handwerker-
 * rechnung über 128,46 Euro. Jede beteiligte Rechnung erzeugt dann einen
 * eigenen Vorschlag mit ihrer eigenen Kostenart.
 *
 * **Mehrdeutigkeit führt zu keinem Treffer.** Lassen sich mehrere
 * Zusammenstellungen auf denselben Betrag bringen, wird nicht geraten — dann
 * bleibt die Zahlung ohne Vorschlag und das gehört in die Meldung. Ein
 * geratener Beleg wäre schlimmer als keiner.
 */
export function ordneSammelueberweisungZu(
  u: UmsatzZeile,
  pool: { regelId: string; rechnung: Rechnung }[],
): { treffer: RechnungsTreffer[]; mehrdeutig: boolean } {
  if (!(u.amount < 0) || pool.length === 0) return { treffer: [], mehrdeutig: false };
  if (!SAMMEL_CODE.test(u.transaction_code || '')) return { treffer: [], mehrdeutig: false };

  const ziel = Math.round(Math.abs(u.amount) * 100);
  const cent = (n: number) => Math.round(n * 100);

  const einzel = pool.filter(e => cent(e.rechnung.betrag) === ziel);
  if (einzel.length === 1) {
    return { treffer: [{ regelId: einzel[0].regelId, rechnung: einzel[0].rechnung, posten: 1 }], mehrdeutig: false };
  }
  if (einzel.length > 1) return { treffer: [], mehrdeutig: true };

  const paare: [number, number][] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (cent(pool[i].rechnung.betrag) + cent(pool[j].rechnung.betrag) === ziel) paare.push([i, j]);
    }
  }
  if (paare.length === 1) {
    const [i, j] = paare[0];
    return {
      treffer: [
        { regelId: pool[i].regelId, rechnung: pool[i].rechnung, posten: 2 },
        { regelId: pool[j].regelId, rechnung: pool[j].rechnung, posten: 2 },
      ],
      mehrdeutig: false,
    };
  }
  return { treffer: [], mehrdeutig: paare.length > 1 };
}

/** Betrag der Buchung: Zahlbetrag als positiver Wert mal Anteil, auf Cent gerundet. */
export function anteiligerBetrag(amount: number, anteil: number): number {
  return Math.round(Math.abs(amount) * anteil * 100) / 100;
}

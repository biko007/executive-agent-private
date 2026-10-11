/**
 * assets/abrechnung-ansicht — Daten für die Darstellung einer Abrechnung.
 *
 * Die Vorschau-Route liefert das Rechenergebnis der Engine: Posten mit
 * Zähler, Nenner und Betrag. Für eine Darstellung, die ein Mieter lesen kann,
 * fehlt darin das Entscheidende:
 *
 *   - **Welche Zähler** stehen hinter einem Verbrauchsposten, und wie waren
 *     ihre Stände am Anfang und am Ende? „26,96 von 437" sagt einem Mieter
 *     nichts; „Ihr Kaltwasserzähler lief von 0 auf 16,18 m³" schon.
 *   - **Welche Rechnungen** stecken in einer Kostenart? Die Engine kennt die
 *     Buchungen (`source_booking_ids`), die Darstellung braucht Rechnungsnummer
 *     und Beleglink.
 *   - **Welche Befunde** gelten für diese Abrechnung? Ein ungemessener Rest
 *     oder eine Abweichung von der Heizkostenverordnung gehört in die
 *     Abrechnung geschrieben, nicht in ein Protokoll.
 *
 * Diese Datei führt das zusammen. Gerechnet wird NICHT neu — die Beträge
 * kommen unverändert aus der Engine. Wer hier rechnet, bekommt zwei Wahrheiten.
 */
import { query as dbQuery } from '../../shared/db/index.js';
import { computeNk, type Zeitraum } from '../nk/engine.js';
import { calculateConsumption } from '../nk/heating.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { MeterReadingRow } from '../nk/types.js';

/** Medien, die in der Darstellung als eigene Verbrauchszeile erscheinen. */
const MEDIEN_NAMEN: Record<string, string> = {
  cold_water: 'Kaltwasser',
  warm_water: 'Warmwasser',
  heat: 'Wärme',
  gas: 'Gas',
  electricity: 'Strom',
};

const MEDIEN_EINHEIT: Record<string, string> = {
  cold_water: 'm³',
  warm_water: 'm³',
  heat: 'kWh',
  gas: 'm³',
  electricity: 'kWh',
};

export interface ZaehlerZeile {
  nummer: string;
  medium: string;
  medium_name: string;
  einheit: string;
  zweck: string | null;
  stand_anfang: number | null;
  stand_anfang_am: string | null;
  stand_ende: number | null;
  stand_ende_am: string | null;
  verbrauch: number;
  /** Stand zu Beginn aus dem hinterlegten Anfangswert statt aus einer Ablesung. */
  anfang_aus_anfangswert: boolean;
  aktiv: boolean;
}

export interface KostenZeile {
  kostenart: string;
  kostenart_name: string;
  gesamt_objekt: number | null;
  schluessel: string | null;
  schluessel_klartext: string;
  anteil_zaehler: number | null;
  anteil_nenner: number | null;
  anteil_prozent: number | null;
  betrag: number;
  belege: { rechnungsnummer: string | null; betrag: number; link_code: string | null }[];
}

export interface EinheitAbrechnung {
  einheit: string;
  wohnflaeche: number | null;
  lage: string | null;
  vertrag_id: number;
  tage: number;
  tage_im_jahr: number;
  zaehler: ZaehlerZeile[];
  kosten: KostenZeile[];
  kosten_summe: number;
  vorauszahlung: number;
  saldo: number;
  rundung: number;
}

export interface AbrechnungAnsicht {
  objekt: string;
  objekt_name: string;
  adresse: string;
  jahr: number;
  zeitraum: { von: string; bis: string; tage: number };
  heizung: { grundkosten_prozent: number | null; verbrauch_prozent: number | null } | null;
  einheiten: EinheitAbrechnung[];
  eigentuemer: { kosten_summe: number; kosten: KostenZeile[] } | null;
  befunde: { code: string; schwere: string; text: string; details: Record<string, unknown> | null }[];
  summe_objekt: number;
  /** Nur Vorschau — es ist nichts finalisiert und nichts versendet. */
  vorlaeufig: true;
  /** Zwischenabrechnung zu einem Stichtag statt volles Kalenderjahr. */
  zwischenabrechnung: boolean;
}

/** Klartext für die Verteilschlüssel, wie ein Mieter sie lesen soll. */
function schluesselKlartext(basis: string | null): string {
  if (!basis) return 'ohne Schlüssel';
  if (basis === 'sqm') return 'nach Wohnfläche';
  if (basis === 'consumption') return 'nach gemessenem Verbrauch';
  if (basis === 'persons') return 'nach Personen';
  if (basis === 'units') return 'je Wohnung gleich';
  if (basis.startsWith('methodA') || basis.startsWith('methodB')) {
    const m = basis.match(/(\d+)\/(\d+)\)?$/);
    return m
      ? `Heizkosten: ${m[1]} % nach Wohnfläche, ${m[2]} % nach Verbrauch`
      : 'Heizkosten nach Heizkostenverordnung';
  }
  return basis;
}

function tagDiff(von: string, bis: string): number {
  const a = new Date(`${von}T00:00:00Z`).getTime();
  const b = new Date(`${bis}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000) + 1;
}

function isoTag(wert: unknown): string | null {
  if (!wert) return null;
  if (wert instanceof Date) return wert.toISOString().slice(0, 10);
  return String(wert).slice(0, 10);
}

/**
 * Baut die Darstellungsdaten für ein Objekt und ein Jahr.
 *
 * Der Lauf ist eine VORSCHAU: `computeNk` ohne Finalisierung. Es entsteht kein
 * Dokument, es wird nichts versendet und nichts gespeichert.
 *
 * Mit `zeitraum` wird daraus eine Zwischenabrechnung zu einem beliebigen
 * Stichtag innerhalb des Jahres. Gerechnet wird mit denselben Regeln und
 * demselben Code — nur der Zeitraum ist kürzer. Die Engine kennzeichnet, was
 * daran geschätzt ist (anteilige Rechnungen, veraltete Zählerstände).
 */
export async function abrechnungAnsicht(
  objektCode: string, jahr: number, zeitraum?: Zeitraum,
): Promise<AbrechnungAnsicht> {
  const { rows: objekte } = await dbQuery<any>(
    'SELECT * FROM properties WHERE code = $1 AND active = true', [objektCode]);
  if (objekte.length === 0) throw new Error(`Objekt ${objektCode} nicht gefunden`);
  const objekt = objekte[0];

  const von = zeitraum ? zeitraum.von : `${jahr}-01-01`;
  const bis = zeitraum ? zeitraum.bis : `${jahr}-12-31`;

  const ergebnis = await computeNk(objekt.id, jahr, false, zeitraum);

  // ── Stammdaten für die Zuordnung ─────────────────────────────────────────
  const { rows: einheiten } = await dbQuery<any>(
    'SELECT * FROM units WHERE property_id = $1 ORDER BY code', [objekt.id]);
  const { rows: vertraege } = await dbQuery<any>(
    `SELECT l.id, l.unit_id, l.start_date, l.end_date, l.nk_vorauszahlung,
            l.heizkosten_vorauszahlung, u.code AS einheit
       FROM leases l JOIN units u ON u.id = l.unit_id
      WHERE u.property_id = $1`, [objekt.id]);
  const { rows: arten } = await dbQuery<any>(
    'SELECT id, code, name FROM cost_categories');
  const artNachId = new Map(arten.map(a => [a.id, a]));

  const { rows: zaehler } = await dbQuery<any>(
    `SELECT m.*, u.code AS einheit
       FROM meters m LEFT JOIN units u ON u.id = m.unit_id
      WHERE (m.property_id = $1 OR u.property_id = $1)
      ORDER BY u.code NULLS FIRST, m.medium, m.meter_number`, [objekt.id]);
  const { rows: ablesungen } = await dbQuery<MeterReadingRow>(
    `SELECT * FROM meter_readings
      WHERE meter_id = ANY($1)
        AND read_at >= $2::date - INTERVAL '45 days'
        AND read_at <= $3::date + INTERVAL '45 days'
      ORDER BY read_at`, [zaehler.map(z => z.id), von, bis]);

  const { rows: buchungen } = await dbQuery<any>(
    `SELECT eb.id, eb.invoice_number, eb.amount_gross, eb.cost_category_id
       FROM expense_bookings eb
      WHERE eb.property_id = $1 AND eb.archived_at IS NULL`, [objekt.id]);
  const buchungNachId = new Map(buchungen.map(b => [b.id, b]));

  // Beleglinks über die Rechnungsnummer: Im Archivindex steht sie, in
  // entity_links der Zugriffscode. Fehlt der Index, bleibt der Link leer —
  // die Abrechnung ist dann trotzdem vollständig.
  const belegCode = new Map<string, string>();
  const indexPfad = join(homedir(), '.openclaw', 'workspace', 'artifacts', 'personal',
    'assets', 'belege', 'index-swt.json');
  if (existsSync(indexPfad)) {
    try {
      const index = JSON.parse(readFileSync(indexPfad, 'utf-8'));
      const { rows: links } = await dbQuery<any>(
        `SELECT link_code, local_path FROM entity_links
          WHERE entity_type = 'property' AND entity_id = $1 AND doc_type = 'local'`,
        [objektCode]);
      const codeZuPfad = new Map(links.map(l => [l.local_path, l.link_code]));
      for (const b of index.belege || []) {
        const code = codeZuPfad.get(b.pfad);
        if (code && b.rechnungsnummer) belegCode.set(b.rechnungsnummer, code);
      }
    } catch { /* Index unlesbar — dann ohne Links */ }
  }

  const { rows: heizung } = await dbQuery<any>(
    'SELECT * FROM property_heating_config WHERE property_id = $1 AND year = $2',
    [objekt.id, jahr]);

  // ── Posten in Darstellungszeilen übersetzen ──────────────────────────────
  function kostenZeilen(items: any[]): KostenZeile[] {
    return items
      .filter(i => i.item_type !== 'rounding_adjustment')
      .map(i => {
        const art = i.cost_category_id ? artNachId.get(i.cost_category_id) : null;
        const belege = (i.source_booking_ids || [])
          .map((id: number) => buchungNachId.get(id))
          .filter(Boolean)
          .map((b: any) => ({
            rechnungsnummer: b.invoice_number,
            betrag: parseFloat(b.amount_gross),
            link_code: b.invoice_number ? belegCode.get(b.invoice_number) || null : null,
          }));
        return {
          kostenart: art?.code || 'heizung_warmwasser',
          kostenart_name: art?.name || 'Heizung und Warmwasser',
          gesamt_objekt: i.total_property,
          schluessel: i.allocation_basis,
          schluessel_klartext: schluesselKlartext(i.allocation_basis),
          anteil_zaehler: i.share_numerator,
          anteil_nenner: i.share_denominator,
          anteil_prozent: i.share_fraction !== null
            ? Math.round(i.share_fraction * 10000) / 100 : null,
          betrag: i.amount,
          belege,
        };
      })
      .sort((a, b) => b.betrag - a.betrag);
  }

  /** Zählerzeilen einer Einheit, mit Ständen am Rand des Zeitraums. */
  function zaehlerZeilen(unitId: number | null): ZaehlerZeile[] {
    return zaehler
      .filter(m => (unitId === null ? !m.unit_id : m.unit_id === unitId))
      .map(m => {
        const eigene = ablesungen
          .filter(r => r.meter_id === m.id)
          .map(r => ({ tag: isoTag(r.read_at)!, wert: parseFloat(String(r.value)) }))
          .sort((a, b) => a.tag.localeCompare(b.tag));

        const vorher = eigene.filter(r => r.tag <= von).pop() || null;
        const imZeitraum = eigene.filter(r => r.tag > von && r.tag <= bis);
        const letzter = imZeitraum.length > 0 ? imZeitraum[imZeitraum.length - 1] : null;

        const anfangsWert = m.initial_reading !== null && m.initial_reading !== undefined
          ? parseFloat(String(m.initial_reading)) : null;

        return {
          nummer: m.meter_number,
          medium: m.medium,
          medium_name: MEDIEN_NAMEN[m.medium] || m.medium,
          einheit: MEDIEN_EINHEIT[m.medium] || '',
          zweck: m.submetering_purpose,
          stand_anfang: vorher ? vorher.wert : anfangsWert,
          stand_anfang_am: vorher ? vorher.tag : null,
          stand_ende: letzter ? letzter.wert : null,
          stand_ende_am: letzter ? letzter.tag : null,
          // Der Verbrauch kommt aus derselben Funktion wie in der Engine —
          // sonst stünde in der Abrechnung eine andere Zahl als in der Rechnung.
          verbrauch: Math.round(
            calculateConsumption(m.id, von, bis, ablesungen) * 1000) / 1000,
          anfang_aus_anfangswert: !vorher && anfangsWert !== null,
          aktiv: m.active !== false,
        };
      });
  }

  // ── Einheiten ────────────────────────────────────────────────────────────
  const tageImJahr = tagDiff(von, bis);
  const ausgabe: EinheitAbrechnung[] = [];

  for (const s of ergebnis.statements) {
    if (s.is_owner_block) continue;
    const vertrag = vertraege.find(v => v.id === s.lease_id);
    if (!vertrag) continue;
    const einheit = einheiten.find(u => u.id === vertrag.unit_id);

    ausgabe.push({
      einheit: vertrag.einheit,
      wohnflaeche: einheit ? parseFloat(String(einheit.living_area_qm)) : null,
      lage: einheit?.floor ?? null,
      // Ein Mietverhältnis ohne Kennung kann es im Ergebnis nicht geben; der
      // Satz wurde oben über genau diese Kennung zugeordnet.
      vertrag_id: s.lease_id!,
      tage: s.active_days,
      tage_im_jahr: tageImJahr,
      zaehler: zaehlerZeilen(vertrag.unit_id),
      kosten: kostenZeilen(s.items),
      kosten_summe: s.costs_total,
      vorauszahlung: s.advance_total,
      saldo: s.balance,
      rundung: s.rounding_adjustment ?? 0,
    });
  }

  const eigentuemerSatz = ergebnis.statements.find(s => s.is_owner_block);

  return {
    objekt: objektCode,
    objekt_name: objekt.name || objektCode,
    adresse: `${objekt.street}, ${objekt.postal_code} ${objekt.city}`,
    jahr,
    zeitraum: { von, bis, tage: tageImJahr },
    heizung: heizung[0]
      ? {
        grundkosten_prozent: heizung[0].base_share_percent !== null
          ? parseFloat(String(heizung[0].base_share_percent)) : null,
        verbrauch_prozent: heizung[0].consumption_share_percent !== null
          ? parseFloat(String(heizung[0].consumption_share_percent)) : null,
      }
      : null,
    einheiten: ausgabe,
    eigentuemer: eigentuemerSatz
      ? { kosten_summe: eigentuemerSatz.costs_total, kosten: kostenZeilen(eigentuemerSatz.items) }
      : null,
    /* `details` wird mitgegeben, weil die Oberfläche daraus die deutsche
       Erklärung baut (nk-befunde.js) und die Rohmeldung des Core nur noch
       dort zeigt, wo zu einem Prüfcode keine Erklärung hinterlegt ist. Ohne
       die Details bliebe offen, WELCHER Zähler gemeint ist. */
    befunde: (ergebnis.warnings || []).map((w: any) => ({
      code: w.code, schwere: w.severity, text: w.message, details: w.details ?? null,
    })),
    summe_objekt: ausgabe.reduce((n, e) => n + e.kosten_summe, 0)
      + (eigentuemerSatz?.costs_total ?? 0),
    vorlaeufig: true,
    zwischenabrechnung: Boolean(zeitraum),
  };
}

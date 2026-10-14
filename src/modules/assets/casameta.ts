/**
 * assets/casameta — Eingabeblatt für das Casameta-Portal.
 *
 * Die Abrechnungsarchitektur ist hybrid: bikosoc hält die Daten, Casameta
 * erzeugt das rechtsverbindliche Mieter-PDF. Eine Schnittstelle gibt es nicht —
 * die Eingabe erfolgt per Browser. Dieses Blatt bringt alle Portalfelder in
 * Portalreihenfolge und befüllt sie aus den eigenen Daten.
 *
 * Grundsatz: Eine Lücke wird als `FEHLT` ausgewiesen und nicht geschätzt. Ein
 * leeres Feld im Portal fällt auf, ein erfundener Wert nicht.
 *
 * Die erzeugte Datei enthält Mieternamen. Sie liegt deshalb in einem
 * Unterordner von ~/bikosoc-spec/, den der Report-Watcher nicht liest (der
 * sieht nur report-*.md direkt im Ordner), und gehört NICHT in einen Report.
 *
 * ERLAUBT seit der Owner-Entscheidung vom 11.10.2026: eine Kopie im privaten
 * App-Ordner des Owners unter `/Apps/bikosoc-reports/.../transfer/casameta/`.
 * Dort braucht der Claude-Chat sie für die Portaleingabe. Ein anderer
 * Dropbox-Ort bleibt ausgeschlossen.
 */
import { query as dbQuery } from '../../shared/db/index.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  stuetzpunkteVon, anteilAusStuetzpunkten, nutzungsAbschnitt, findeEinzugsstand,
} from '../nk/nutzerzeit.js';

const ZIEL_DIR = join(homedir(), 'bikosoc-spec', 'casameta');

const FEHLT = 'FEHLT';

function wert(v: unknown, einheit = ''): string {
  if (v === null || v === undefined || v === '') return FEHLT;
  return `${v}${einheit}`;
}

function geld(v: unknown): string {
  if (v === null || v === undefined) return FEHLT;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  if (!Number.isFinite(n)) return FEHLT;
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tag(v: unknown): string {
  if (!v) return FEHLT;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? FEHLT : d.toLocaleDateString('de-DE');
}

/* DATE-Spalten kommen als Date-Objekt aus pg. `String(date).slice(0,10)` ergibt
   "Sat Feb 01" — JavaScript ergaenzt daraus dann das Jahr 2001. Jeder Vergleich
   und jede Ausgabe braucht deshalb diesen Weg. */
function isoTag(v: unknown): string {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function csvFeld(s: string): string {
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface EingabeblattErgebnis {
  objekt: string;
  jahr: number;
  wohnungen: number;
  nutzerzeitraeume: number;
  zaehler_aktiv: number;
  zaehler_abgeschaltet: number;
  kostenbuchungen: number;
  umlagefaehig_anzahl: number;
  summe_umlagefaehig: number;
  luecken: string[];
  pfad_md: string;
  pfad_csv: string;
  pfad_json: string;
}

export async function erzeugeEingabeblatt(
  objektCode: string, jahr: number,
): Promise<EingabeblattErgebnis> {

  const von = `${jahr}-01-01`;
  const bis = `${jahr}-12-31`;

  // ── Zuordnung aus den Einstellungen ───────────────────────────────────────
  const { rows: mapRows } = await dbQuery<{ value: any }>(
    `SELECT value FROM system_settings WHERE key = 'casameta_mapping'`);
  const map = mapRows[0]?.value;
  if (!map) throw new Error('system_settings.casameta_mapping fehlt — erst die Zuordnung hinterlegen');

  const { rows: objekte } = await dbQuery<any>(
    'SELECT * FROM properties WHERE code = $1', [objektCode]);
  if (objekte.length === 0) throw new Error(`Objekt ${objektCode} nicht gefunden`);
  const objekt = objekte[0];

  const { rows: einheiten } = await dbQuery<any>(
    'SELECT * FROM units WHERE property_id = $1 ORDER BY code', [objekt.id]);

  const { rows: vertraege } = await dbQuery<any>(
    `SELECT l.*, u.code AS einheit
       FROM leases l JOIN units u ON u.id = l.unit_id
      WHERE u.property_id = $1
        AND l.start_date <= $3 AND (l.end_date IS NULL OR l.end_date >= $2)
      ORDER BY u.code, l.start_date`, [objekt.id, von, bis]);

  const { rows: mieter } = await dbQuery<any>(
    `SELECT lt.lease_id, t.last_name, t.first_name, t.company_name
       FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
      WHERE lt.lease_id = ANY($1)`, [vertraege.map(v => v.id)]);

  const { rows: zaehler } = await dbQuery<any>(
    `SELECT m.*, u.code AS einheit
       FROM meters m LEFT JOIN units u ON u.id = m.unit_id
      WHERE (m.property_id = $1 OR u.property_id = $1)
      ORDER BY u.code NULLS FIRST, m.medium, m.meter_number`, [objekt.id]);

  const { rows: staende } = await dbQuery<any>(
    `SELECT r.meter_id, r.read_at::date::text AS tag, r.value, r.reading_type, r.is_estimated
       FROM meter_readings r
      WHERE r.meter_id = ANY($1)
        AND r.read_at >= $2::date - INTERVAL '40 days'
        AND r.read_at <= $3::date + INTERVAL '40 days'
      ORDER BY r.meter_id, r.read_at`, [zaehler.map(z => z.id), von, bis]);

  const { rows: kosten } = await dbQuery<any>(
    `SELECT eb.*, cc.code AS kostenart
       FROM expense_bookings eb JOIN cost_categories cc ON cc.id = eb.cost_category_id
      WHERE eb.property_id = $1 AND eb.archived_at IS NULL
        AND eb.service_period_start <= $3 AND eb.service_period_end >= $2
      ORDER BY cc.sort_order, eb.service_period_start`, [objekt.id, von, bis]);

  const { rows: heizung } = await dbQuery<any>(
    'SELECT * FROM property_heating_config WHERE property_id = $1 AND year = $2',
    [objekt.id, jahr]);

  /* Brennstoffbestand. Casameta rechnet Energiekosten über Anfangsbestand +
     Zukauf − Endbestand; ohne diese Werte bleibt das Portalfeld leer. */
  const { rows: bestandRows } = await dbQuery<{ value: any }>(
    `SELECT value FROM system_settings WHERE key = 'brennstoffbestand'`);
  const bestand = bestandRows[0]?.value?.[objektCode]?.[String(jahr)] || null;

  // ── Hilfen ────────────────────────────────────────────────────────────────
  /** Stand möglichst nahe am Stichtag, höchstens 40 Tage daneben. */
  function standAm(meterId: number, stichtag: string): { tag: string; value: string } | null {
    const kandidaten = staende.filter(s => s.meter_id === meterId);
    if (kandidaten.length === 0) return null;
    const ziel = new Date(`${stichtag}T00:00:00Z`).getTime();
    let beste = kandidaten[0];
    let abstand = Infinity;
    for (const k of kandidaten) {
      const d = Math.abs(new Date(`${k.tag}T00:00:00Z`).getTime() - ziel);
      if (d < abstand) { abstand = d; beste = k; }
    }
    return abstand <= 40 * 86400000 ? { tag: beste.tag, value: beste.value } : null;
  }

  function mieterZu(leaseId: number): string {
    const m = mieter.filter(x => x.lease_id === leaseId);
    if (m.length === 0) return FEHLT;
    return m.map(x => x.company_name || `${x.first_name || ''} ${x.last_name || ''}`.trim())
      .filter(Boolean).join(' / ');
  }

  const luecken: string[] = [];
  function merkeLuecke(text: string) { if (!luecken.includes(text)) luecken.push(text); }

  // ── Blatt aufbauen ────────────────────────────────────────────────────────
  const z: string[] = [];
  const csv: string[] = ['abschnitt;feld;wert;hinweis'];
  /* Die JSON-Fassung entsteht aus denselben Aufrufen wie die CSV. Zwei
     getrennte Aufbauwege waeren zwei Wahrheiten — und die eine wuerde
     irgendwann von der anderen abweichen, ohne dass es auffaellt. */
  const felder: { abschnitt: string; feld: string; wert: string; hinweis: string }[] = [];
  const csvZeile = (abschnitt: string, feld: string, w: string, hinweis = '') => {
    felder.push({ abschnitt, feld, wert: w, hinweis });
    return csv.push([abschnitt, feld, w, hinweis].map(csvFeld).join(';'));
  };

  z.push(`# Casameta-Eingabeblatt — ${objekt.name || objekt.code}, Abrechnung ${jahr}`);
  z.push('');
  z.push(`Erzeugt am ${new Date().toLocaleString('de-DE')} aus bikosoc.`);
  z.push('');
  z.push('**Diese Datei enthält Mieternamen.** Sie ist eine interne Arbeitsdatei und gehört');
  z.push('nicht in einen Report. Zulässiger Ablageort außerhalb des Servers ist allein der');
  z.push('private App-Ordner des Owners: `/Apps/bikosoc-reports/.../transfer/casameta/`');
  z.push('(Owner-Entscheidung 11.10.2026).');
  z.push('');
  z.push('Felder mit `FEHLT` sind in bikosoc nicht vorhanden und im Portal bewusst zu setzen.');
  z.push('');
  z.push('---');
  z.push('');

  // 1. Abrechnungsobjekt
  const lsNr = map.leistungsstellen?.[objektCode];
  z.push('## 1. Abrechnungsobjekt');
  z.push('');
  z.push('| Feld | Wert |');
  z.push('|---|---|');
  for (const [feld, w] of [
    ['Leistungsstellen-Nummer', wert(lsNr)],
    ['Objekt', `${objekt.name || objekt.code}`],
    ['Adresse', `${objekt.street}, ${objekt.postal_code} ${objekt.city}`],
    ['Abrechnungszeitraum', `01.01.${jahr} – 31.12.${jahr}`],
    ['Anzahl Wohnungen', String(einheiten.length)],
    ['Gesamtfläche', `${einheiten.reduce((s, u) => s + Number(u.living_area_qm || 0), 0).toFixed(2)} m²`],
  ] as const) {
    z.push(`| ${feld} | ${w} |`);
    csvZeile('objekt', feld, w);
  }
  if (!lsNr) merkeLuecke('Leistungsstellen-Nummer für dieses Objekt ist in der Zuordnung nicht hinterlegt.');
  z.push('');

  // 2. Heizung
  const h = heizung[0];
  z.push('## 2. Heizung und Warmwasser');
  z.push('');
  z.push('| Feld | Wert |');
  z.push('|---|---|');
  const brennstoff = h ? map.brennstoff?.[h.heating_system] : null;
  const heizZeilen: [string, string][] = [
    ['Heizungsart', wert(h?.heating_system)],
    ['Brennstoff (Casameta)', wert(brennstoff?.casameta_art)],
    ['Heizwert Hi', brennstoff ? `${brennstoff.heizwert_kwh_je_kg} kWh/kg` : FEHLT],
    ['Warmwasser über die Heizung', h ? (h.hot_water_via_heating ? 'ja' : 'nein') : FEHLT],
    ['Grundkostenanteil', h?.base_share_percent != null ? `${h.base_share_percent} %` : FEHLT],
    ['Verbrauchsanteil', h?.consumption_share_percent != null ? `${h.consumption_share_percent} %` : FEHLT],
    ['Anfangsbestand Brennstoff', bestand?.anfangsbestand
      ? `${bestand.anfangsbestand.menge.toFixed(2)} ${bestand.einheit} / `
        + `${geld(bestand.anfangsbestand.wert)} EUR`
      : FEHLT],
    ['Zukauf Brennstoff', bestand?.zukauf
      ? `${bestand.zukauf.reduce((s: number, z: any) => s + z.menge, 0).toFixed(2)} ${bestand.einheit} / `
        + `${geld(bestand.zukauf.reduce((s: number, z: any) => s + z.wert, 0))} EUR`
      : FEHLT],
    ['Endbestand Brennstoff', bestand?.endbestand
      ? `${bestand.endbestand.menge.toFixed(2)} ${bestand.einheit} / `
        + `${geld(bestand.endbestand.wert)} EUR`
      : FEHLT],
    ['= Verbrauch Brennstoff', bestand?.verbrauch
      ? `${bestand.verbrauch.menge.toFixed(2)} ${bestand.einheit} / `
        + `${geld(bestand.verbrauch.wert)} EUR / ${bestand.verbrauch.energie_kwh} kWh`
      : FEHLT],
  ];
  for (const [feld, w] of heizZeilen) {
    z.push(`| ${feld} | ${w} |`);
    csvZeile('heizung', feld, w);
  }
  if (!bestand) {
    merkeLuecke('Anfangs- und Endbestand des Brennstofflagers sind für dieses Objekt und Jahr '
      + 'nicht hinterlegt (system_settings.brennstoffbestand). Casameta rechnet Brennstoff über '
      + 'Anfangsbestand + Zukauf − Endbestand.');
  } else {
    // Eine Arbeitsannahme gehört in die Lückenliste, auch wenn das Feld
    // gefüllt ist: Im Portal steht sonst eine Zahl, die wie gemessen aussieht.
    for (const [feld, b] of [['Anfangsbestand', bestand.anfangsbestand],
      ['Endbestand', bestand.endbestand]] as const) {
      if (b?.arbeitsannahme) {
        merkeLuecke(`${feld} Brennstoff ist eine ARBEITSANNAHME (${b.menge} ${bestand.einheit}, `
          + `Grundlage: ${b.grundlage}). ${b.annahme_text || ''}`.trim());
      }
    }
  }
  if (h && (Number(h.consumption_share_percent) < 50 || Number(h.consumption_share_percent) > 70)) {
    z.push('');
    z.push(`> **Hinweis:** Der Verbrauchsanteil von ${h.consumption_share_percent} % liegt außerhalb `
      + 'des Rahmens von § 7 Abs. 1 HeizkostenV (50 bis 70 %). Das ist eine bewusste '
      + 'Owner-Entscheidung; im Portal ist derselbe Wert zu setzen.');
  }
  z.push('');

  // 3. Wohnungen
  z.push('## 3. Wohnungen');
  z.push('');
  z.push('| Nr. | Lage | Nutzfläche NK | Nutzfläche HK | Nutzfläche WW |');
  z.push('|---|---|---:|---:|---:|');
  for (const u of einheiten) {
    const f = Number(u.living_area_qm || 0).toFixed(2);
    z.push(`| ${u.code} | ${wert(u.floor)} | ${f} m² | ${f} m² | ${f} m² |`);
    csvZeile('wohnung', `${u.code} Nutzfläche`, `${f}`,
      'bikosoc führt EINE Fläche; Casameta erlaubt HK/WW/NK getrennt');
  }
  merkeLuecke('bikosoc führt eine Fläche je Wohnung. Weichen die Nutzflächen für Heizkosten, '
    + 'Warmwasser und Nebenkosten voneinander ab, sind sie im Portal von Hand zu setzen.');
  z.push('');

  /**
   * Wie der Nutzeranteil dieser Wohnung zustande kommt — Stützpunkt und
   * Lückenanteil, mit derselben Funktion gerechnet wie in der Engine.
   *
   * Nicht eine zweite Fassung: Stünde im Eingabeblatt eine andere Zahl als in
   * der Kontrollrechnung, wäre das Blatt wertlos.
   */
  function stuetzpunktHinweis(einheitCode: string): { kurz: string; lang: string } {
    const vertrag = vertraege.find(v => v.einheit === einheitCode);
    const abschnitt = vertrag ? nutzungsAbschnitt(vertrag as any, von, bis) : null;
    /* Nur aktive Zähler — die Engine lädt ebenfalls nur aktive. Ein
       abgeschalteter Zähler (bei MG24 die beiden in W3) darf hier keinen
       Stützpunkt liefern, den die Rechnung nicht kennt. */
    const eigene = zaehler.filter(
      z => z.einheit === einheitCode && z.medium === 'heat' && z.active !== false);
    const serien = eigene.map(z => stuetzpunkteVon(
      z.id,
      staende.map(s => ({ meter_id: s.meter_id, read_at: s.tag, value: s.value })) as any,
      von, bis,
      z.initial_reading !== null && z.initial_reading !== undefined
        ? parseFloat(String(z.initial_reading)) : null));

    /* Rangfolge wie in der Engine: Eine Zwischenablesung zum Nutzerwechsel
       schlägt das Stützpunktverfahren. Ohne diese Prüfung stünde im
       Eingabeblatt „Aufteilung" , während die Abrechnung längst misst — zwei
       Aussagen über denselben Sachverhalt. */
    const alleAbgelesen = eigene.length > 0 && abschnitt !== null && eigene.every(
      z => findeEinzugsstand(
        z.id,
        isoTag((vertrag as any).start_date),
        staende.map(s => ({ meter_id: s.meter_id, read_at: s.tag, value: s.value })) as any,
      ) !== null);
    if (alleAbgelesen) {
      return {
        kurz: 'Zwischenablesung zum Nutzerwechsel vorhanden',
        lang: 'Zum Nutzerwechsel liegt eine Ablesung vor; der Verbrauch ist zwischen '
          + 'Leerstand und Mieter gemessen getrennt. Die Stände stehen in '
          + 'zwischenstaende-mg24-2025.csv und sind im Portal so einzutragen.',
      };
    }

    const a = abschnitt
      ? anteilAusStuetzpunkten(serien, abschnitt.von, abschnitt.bis, von, bis, 'gradtage')
      : null;

    if (!a || !a.stuetzpunkt) {
      return {
        kurz: '§ 9b-Aufteilung, Zwischenablesung fehlt',
        lang: 'Zwischenablesung zum Einzug fehlt und es gibt keine Ablesung im Zeitraum. '
          + 'Gerechnet wird nach § 9b Abs. 3 HeizkostenV über den ganzen Zeitraum: Wärme nach '
          + 'Gradtagszahlen, Warmwasser und Wasser zeitanteilig. Im Portal entsprechend '
          + 'einstellen. Liefert die Gebäudeleittechnik später echte Einzugsstände, ersetzen '
          + 'diese die Aufteilung.',
      };
    }
    const prozent = (a.lueckenAnteil * 100).toFixed(1).replace('.', ',');
    return {
      kurz: `§ 9b-Aufteilung, Zwischenablesung fehlt — gemessen ab ${a.stuetzpunkt}`,
      lang: 'Zwischenablesung zum Einzug fehlt. Ab der ersten Ablesung danach '
        + `(${a.stuetzpunkt}) wird gemessen; aufgeteilt ist nur die Lücke davor — `
        + `${prozent} % des Nutzerverbrauchs, Wärme nach Gradtagszahlen, Warmwasser und `
        + 'Wasser zeitanteilig (§ 9b Abs. 3 HeizkostenV). Im Portal entsprechend einstellen. '
        + 'Liefert die Gebäudeleittechnik später echte Einzugsstände, ersetzen diese die '
        + 'Aufteilung.',
    };
  }

  // 4. Nutzer und Zeiträume
  z.push('## 4. Nutzer und Nutzungszeiträume');
  z.push('');
  z.push('| Wohnung | Nutzer | von | bis | NK-Vorauszahlung/Monat | HK-Vorauszahlung/Monat |');
  z.push('|---|---|---|---|---:|---:|');
  for (const v of vertraege) {
    const nk = geld(v.nk_vorauszahlung);
    const hk = geld(v.heizkosten_vorauszahlung);
    z.push(`| ${v.einheit} | ${mieterZu(v.id)} | ${tag(v.start_date)} | `
      + `${v.end_date ? tag(v.end_date) : 'offen'} | ${nk} | ${hk} |`);
    csvZeile('nutzer', `${v.einheit} Zeitraum`, `${tag(v.start_date)} - ${v.end_date ? tag(v.end_date) : 'offen'}`);
    csvZeile('nutzer', `${v.einheit} NK-Vorauszahlung`, nk);
    csvZeile('nutzer', `${v.einheit} HK-Vorauszahlung`, hk);
    if (v.nk_vorauszahlung == null) merkeLuecke(`NK-Vorauszahlung für ${v.einheit} ist nicht erfasst.`);
  }
  // Leerstand sichtbar machen
  for (const u of einheiten) {
    const eigene = vertraege.filter(v => v.einheit === u.code);
    if (eigene.length === 0) {
      z.push(`| ${u.code} | *Leerstand im ganzen Zeitraum* | ${tag(von)} | ${tag(bis)} | — | — |`);
      continue;
    }
    const ersterStart = eigene.map(v => isoTag(v.start_date)).sort()[0];
    if (ersterStart > von) {
      z.push(`| ${u.code} | *Leerstand* | ${tag(von)} | ${tag(ersterStart)} | — | — |`);
      merkeLuecke(`${u.code} war von ${tag(von)} bis ${tag(ersterStart)} nicht vermietet — `
        + 'in Casameta als Leerstand-Nutzerzeitraum eintragen.');
      /* Der Nutzerwechsel ist der Punkt, an dem das Portal eine
         Zwischenablesung erwartet. Gibt es keine, muss dort dieselbe
         Aufteilung eingestellt werden wie hier gerechnet — sonst weichen
         Kontrollrechnung und verbindliche Abrechnung voneinander ab. */
      /* Stützpunkt und Lückenanteil kommen aus dem Rechenlauf — sie sagen,
         wie weit die Zahl gemessen und wie weit sie aufgeteilt ist. Ohne
         diese Angabe steht im Portal eine Zahl, deren Herkunft niemand mehr
         nachvollziehen kann. */
      const st = stuetzpunktHinweis(u.code);
      z.push(`| ${u.code} | *${st.kurz}* | — | — | — | — |`);
      csvZeile('nutzer', `${u.code} Aufteilung Nutzerwechsel`, st.kurz, st.lang);
      merkeLuecke(`${u.code}: ${st.lang}`);
    }
  }
  z.push('');

  /** Medium in Klartext — im Portal steht kein `cold_water`. */
  function mediumName(medium: string): string {
    const namen: Record<string, string> = {
      cold_water: 'Kaltwasser', warm_water: 'Warmwasser', heat: 'Wärme',
      gas: 'Gas', electricity: 'Strom',
    };
    return namen[medium] || medium;
  }

  /** Zähleinheit des Mediums. */
  function einheitVon(medium: string): string {
    const einheiten: Record<string, string> = {
      cold_water: 'm³', warm_water: 'm³', heat: 'kWh', gas: 'm³', electricity: 'kWh',
    };
    return einheiten[medium] || '';
  }

  /**
   * Lage eines Zählers, soweit die Daten sie hergeben.
   *
   * Ein eigenes Feld dafür gibt es nicht. Verwertbar ist, was in der Kennung
   * steht: Die Wärmemengenzähler tragen den Heizkreis (Nord/Ost, Süd/West),
   * die Objektzähler ihren Zweck. Alles andere bleibt ausdrücklich offen,
   * statt eine Raumangabe zu erfinden.
   */
  function lageVon(m: { meter_number: string; einheit?: string | null;
    submetering_purpose?: string | null }): string {
    const nr = String(m.meter_number);
    if (/-WMZ-NO$/.test(nr)) return 'Heizkreis Nord/Ost';
    if (/-WMZ-SW$/.test(nr)) return 'Heizkreis Süd/West';
    if (/HEIZUNG-GESAMT$/.test(nr)) return 'Heizzentrale, Heizkreis gesamt';
    if (/WARMWASSER-GESAMT$/.test(nr)) return 'Heizzentrale, Warmwasserbereitung';
    if (/HAUSANSCHLUSS$/.test(nr)) return 'Hausanschlussraum';
    if (!m.einheit) return 'Objekt';
    return 'nicht erfasst';
  }

  // 5. Zähler und Stände
  z.push('## 5. Zähler und Zählerstände');
  z.push('');
  z.push('| Pos. | Kennung | Wohnung | Medium | Lage | Stand 01.01. | Stand 31.12. | Verbrauch | Einheit |');
  z.push('|---|---|---|---|---|---:|---:|---:|---|');
  let pos = 0;
  for (const m of zaehler) {
    if (m.active === false) continue;
    pos++;
    const alt = standAm(m.id, von);
    const neu = standAm(m.id, bis);
    const verbrauch = (alt && neu)
      ? (Number(neu.value) - Number(alt.value)).toFixed(3)
      : (m.initial_reading != null && neu
        ? (Number(neu.value) - Number(m.initial_reading)).toFixed(3) : FEHLT);
    const standAlt = alt
      ? `${alt.value} (${tag(alt.tag)})`
      : (m.initial_reading != null ? `${m.initial_reading} (Anfangswert)` : FEHLT);
    z.push(`| ${pos} | ${m.meter_number} | ${m.einheit || 'Objekt'} | ${mediumName(m.medium)} | `
      + `${lageVon(m)} | ${standAlt} | ${neu ? `${neu.value} (${tag(neu.tag)})` : FEHLT} | `
      + `${verbrauch} | ${einheitVon(m.medium)} |`);
    csvZeile('zaehler', `${m.meter_number} Medium`, mediumName(m.medium), lageVon(m));
    csvZeile('zaehler', `${m.meter_number} Stand 01.01.`,
      alt ? String(alt.value) : (m.initial_reading != null ? String(m.initial_reading) : FEHLT),
      einheitVon(m.medium));
    csvZeile('zaehler', `${m.meter_number} Stand 31.12.`,
      neu ? String(neu.value) : FEHLT, einheitVon(m.medium));
    csvZeile('zaehler', `${m.meter_number} Verbrauch`, verbrauch, einheitVon(m.medium));
    if (!alt && m.initial_reading == null) {
      merkeLuecke(`Zähler ${m.meter_number}: kein Stand zum Periodenanfang und kein Anfangswert.`);
    }
    /* Ersatzwerte nach § 9a HeizkostenV sehen im Blatt aus wie Messwerte. Sie
       muessen im Portal aber als Schaetzung kenntlich sein — der Mieter hat ein
       Recht darauf zu wissen, welcher Teil gemessen und welcher geschaetzt ist. */
    const geschaetzt = staende.some((r: any) =>
      r.meter_id === m.id && r.is_estimated && r.tag >= von && r.tag <= bis);
    if (geschaetzt) {
      merkeLuecke(`Zähler ${m.meter_number}: ERSATZWERT nach § 9a HeizkostenV, keine Messung. `
        + 'Im Portal als Schätzung kennzeichnen. Grund und Verfahren stehen im Vermerk '
        + 'des Objekts.');
    }
    if (!neu) merkeLuecke(`Zähler ${m.meter_number}: kein Stand zum Periodenende.`);
  }
  merkeLuecke('Raumangabe je Zähler führt bikosoc nur, soweit sie aus der Kennung hervorgeht '
    + '(Heizkreis Nord/Ost bzw. Süd/West). Der K-Wert der Heizkostenverteiler wird nicht '
    + 'geführt — bei MG24 sind es Wärmemengenzähler, dort gibt es keinen.');
  z.push('');
  const inaktiv = zaehler.filter(m => m.active === false);
  if (inaktiv.length > 0) {
    z.push(`> **${inaktiv.length} Zähler sind abgeschaltet** und hier nicht aufgeführt: `
      + inaktiv.map(m => m.meter_number).join(', ')
      + '. Sie sind bis zur Klärung bewusst nicht abrechnungsrelevant.');
    z.push('');
  }

  // 6. Kosten
  z.push('## 6. Kosten');
  z.push('');
  z.push('| Casameta-Gruppe | Casameta-Kostenart | Schlüssel | Betrag | Leistungszeitraum | Beleg |');
  z.push('|---|---|---|---:|---|---|');
  let summeUmlagefaehig = 0;
  for (const k of kosten) {
    const zu = map.kostenarten?.[k.kostenart];
    if (!k.umlagefaehig) continue;
    summeUmlagefaehig += Number(k.amount_gross);
    z.push(`| ${wert(zu?.gruppe)} | ${wert(zu?.casameta)} | ${wert(zu?.schluessel)} | `
      + `${geld(k.amount_gross)} | ${tag(k.service_period_start)} – ${tag(k.service_period_end)} | `
      + `${wert(k.invoice_number)} |`);
    csvZeile('kosten', `${zu?.casameta || k.kostenart} ${isoTag(k.service_period_start)}`,
      geld(k.amount_gross), zu?.schluessel || '');
    if (!zu) merkeLuecke(`Kostenart ${k.kostenart} ist in der Casameta-Zuordnung nicht hinterlegt.`);
    if (zu?.menge_erforderlich) {
      merkeLuecke(`${zu.casameta}: Casameta verlangt hier eine MENGE mit Einheit, nicht nur den `
        + 'Betrag. Die Liefermengen stehen in den Rechnungen, nicht in der Buchung.');
    }
  }
  z.push(`| | **Summe umlagefähig** | | **${geld(summeUmlagefaehig)}** | | |`);
  z.push('');

  const nichtUmlagefaehig = kosten.filter(k => !k.umlagefaehig);
  if (nichtUmlagefaehig.length > 0) {
    z.push(`> **${nichtUmlagefaehig.length} Buchungen über `
      + `${geld(nichtUmlagefaehig.reduce((s, k) => s + Number(k.amount_gross), 0))} Euro sind nicht `
      + 'umlagefähig** und gehören NICHT ins Portal: '
      + nichtUmlagefaehig.map(k => `${k.kostenart} ${geld(k.amount_gross)}`).join(', ') + '.');
    z.push('');
  }

  // 7. Lücken
  z.push('## 7. Was im Portal von Hand zu setzen ist');
  z.push('');
  if (luecken.length === 0) {
    z.push('Keine Lücken — alle Portalfelder sind aus bikosoc befüllbar.');
  } else {
    for (const l of luecken) z.push(`- ${l}`);
  }
  z.push('');

  /* KEINE AUTOMATISCHE ARBEITSLISTE. Naheliegend waere, aus den FEHLT-Feldern
     eine Reihenfolge fuer den ersten Schreiblauf zu erzeugen. Der Versuch am
     14.10.2026 lieferte fuer MG24 2025 zweiundzwanzig "Blocker" — darunter neun
     Mieterstromzaehler, die die Casameta-Abrechnung gar nicht aufhalten, weil in
     Abschnitt 6 keine verbrauchsabhaengige Stromkostenart steht. Umgekehrt
     fehlten die echten Arbeitsschritte, denn Leerstandszeitraeume und die
     Paragraph-9b-Einstellung stehen nirgends als FEHLT; sie sind ganz normale
     Werte, die nur eingetragen werden muessen.
     Eine richtige Einstufung braucht die Zuordnung Verteilerschluessel zu
     Medium — VKW zu Kaltwasser, HK zu Waerme. Die gibt es in
     system_settings.casameta_mapping nicht, und sie im Code zu erraten wuerde
     fuer andere Objekte falsche Listen erzeugen. Deshalb liefert das Blatt die
     Lueckenliste (Abschnitt 7) und die Felder als JSON; welche Luecke die
     Abrechnung wirklich aufhaelt, wird im Report begruendet und nicht geraten. */

  // ── Schreiben ─────────────────────────────────────────────────────────────
  if (!existsSync(ZIEL_DIR)) mkdirSync(ZIEL_DIR, { recursive: true });
  const md = join(ZIEL_DIR, `eingabeblatt-${objektCode}-${jahr}.md`);
  const cs = join(ZIEL_DIR, `eingabeblatt-${objektCode}-${jahr}.csv`);
  const js = join(ZIEL_DIR, `eingabeblatt-${objektCode}-${jahr}.json`);
  writeFileSync(md, z.join('\n') + '\n');
  writeFileSync(cs, csv.join('\n') + '\n');
  writeFileSync(js, JSON.stringify({
    objekt: objektCode,
    objekt_name: objekt.name || objekt.code,
    jahr,
    erzeugt_am: new Date().toISOString(),
    /* Dieselbe Warnung wie im Blatt: die Datei fuehrt Mieternamen. */
    hinweis: 'Interne Arbeitsdatei mit Mieternamen. Nicht in Reports, nicht in Telegram.',
    kennzahlen: {
      wohnungen: einheiten.length,
      nutzerzeitraeume: vertraege.length,
      zaehler_aktiv: zaehler.filter(m => m.active !== false).length,
      zaehler_abgeschaltet: zaehler.filter(m => m.active === false).length,
      kostenbuchungen: kosten.length,
      umlagefaehig_anzahl: kosten.filter(k => k.umlagefaehig).length,
      summe_umlagefaehig: Math.round(summeUmlagefaehig * 100) / 100,
    },
    felder,
    luecken,
  }, null, 2) + '\n');

  return {
    objekt: objektCode,
    jahr,
    wohnungen: einheiten.length,
    nutzerzeitraeume: vertraege.length,
    zaehler_aktiv: zaehler.filter(m => m.active !== false).length,
    zaehler_abgeschaltet: zaehler.filter(m => m.active === false).length,
    kostenbuchungen: kosten.length,
    umlagefaehig_anzahl: kosten.filter(k => k.umlagefaehig).length,
    summe_umlagefaehig: Math.round(summeUmlagefaehig * 100) / 100,
    luecken,
    pfad_md: md,
    pfad_csv: cs,
    pfad_json: js,
  };
}

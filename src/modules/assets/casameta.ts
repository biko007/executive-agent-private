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
 * Die erzeugte Datei darf Mieternamen enthalten — sie ist eine interne
 * Arbeitsdatei und gehört NICHT in einen Report und nicht nach Dropbox. Sie
 * liegt deshalb in einem Unterordner von ~/bikosoc-spec/, den der
 * Report-Watcher nicht liest (der sieht nur report-*.md direkt im Ordner).
 */
import { query as dbQuery } from '../../shared/db/index.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
    `SELECT r.meter_id, r.read_at::date::text AS tag, r.value, r.reading_type
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
  const csvZeile = (abschnitt: string, feld: string, w: string, hinweis = '') =>
    csv.push([abschnitt, feld, w, hinweis].map(csvFeld).join(';'));

  z.push(`# Casameta-Eingabeblatt — ${objekt.name || objekt.code}, Abrechnung ${jahr}`);
  z.push('');
  z.push(`Erzeugt am ${new Date().toLocaleString('de-DE')} aus bikosoc.`);
  z.push('');
  z.push('**Diese Datei enthält Mieternamen. Sie ist eine interne Arbeitsdatei und gehört');
  z.push('nicht in einen Report und nicht nach Dropbox.**');
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
      z.push(`| ${u.code} | *§ 9b-Aufteilung, Zwischenablesung fehlt* | — | — | — | — |`);
      csvZeile('nutzer', `${u.code} Aufteilung Nutzerwechsel`,
        '§ 9b Abs. 3 HeizkostenV',
        'Wärme nach Gradtagszahlen, Warmwasser und Wasser zeitanteilig — '
        + 'im Portal entsprechend einstellen');
      merkeLuecke(`${u.code}: Zwischenablesung zum Einzug fehlt. Gerechnet wird nach `
        + '§ 9b Abs. 3 HeizkostenV (Wärme nach Gradtagszahlen, Warmwasser zeitanteilig). '
        + 'Liefert die Gebäudeleittechnik später echte Einzugsstände, ersetzen diese die '
        + 'Aufteilung.');
    }
  }
  z.push('');

  // 5. Zähler und Stände
  z.push('## 5. Zähler und Zählerstände');
  z.push('');
  z.push('| Pos. | Nummer | Wohnung | Typ | Raum | K-Wert | Stand alt | Stand neu | Verbrauch |');
  z.push('|---|---|---|---|---|---|---:|---:|---:|');
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
    z.push(`| ${pos} | ${m.meter_number} | ${m.einheit || 'Objekt'} | ${m.medium} | ${FEHLT} | ${FEHLT} | `
      + `${alt ? `${alt.value} (${tag(alt.tag)})` : (m.initial_reading != null ? `${m.initial_reading} (Anfangswert)` : FEHLT)} | `
      + `${neu ? `${neu.value} (${tag(neu.tag)})` : FEHLT} | ${verbrauch} |`);
    csvZeile('zaehler', `${m.meter_number} Stand alt`, alt ? String(alt.value) : FEHLT);
    csvZeile('zaehler', `${m.meter_number} Stand neu`, neu ? String(neu.value) : FEHLT);
    if (!alt && m.initial_reading == null) {
      merkeLuecke(`Zähler ${m.meter_number}: kein Stand zum Periodenanfang und kein Anfangswert.`);
    }
    if (!neu) merkeLuecke(`Zähler ${m.meter_number}: kein Stand zum Periodenende.`);
  }
  merkeLuecke('Raum und K-Wert je Zähler führt bikosoc nicht — im Portal zu ergänzen.');
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

  // ── Schreiben ─────────────────────────────────────────────────────────────
  if (!existsSync(ZIEL_DIR)) mkdirSync(ZIEL_DIR, { recursive: true });
  const md = join(ZIEL_DIR, `eingabeblatt-${objektCode}-${jahr}.md`);
  const cs = join(ZIEL_DIR, `eingabeblatt-${objektCode}-${jahr}.csv`);
  writeFileSync(md, z.join('\n') + '\n');
  writeFileSync(cs, csv.join('\n') + '\n');

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
  };
}

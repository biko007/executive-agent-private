/**
 * Objektsteckbrief — was über ein Objekt gewusst ist, woher es kommt, was fehlt.
 *
 * Die Spezifikation steht in `docs/projekt/Objektsteckbrief-Standard.md`
 * (Owner-Vorgabe 16.10.2026). Der Kern dieser Datei ist die Kachel: Sie führt
 * zusammen, was aus Verträgen, Zahlungen, Flächen und Belegen schon bekannt
 * ist, und sagt in einer Zahl, wie viel davon belegt ist.
 *
 * Zwei Regeln ziehen sich durch:
 *
 *   - Jeder erfasste Wert trägt Quelle und Stand (`objekt_felder`). Ein Wert
 *     ohne Quelle wird nicht geschrieben.
 *   - Gerechnetes bleibt als gerechnet erkennbar. Die Bruttomietrendite steht
 *     neben ihrer Grundlage, nicht an ihrer Stelle.
 */
import { query as dbQuery } from '../../shared/db/index.js';
import { ampelJeObjekt } from './mietforderungen.js';

/** Fehlt V043, sagt das die Route — statt mit einem SQL-Fehler abzubrechen. */
export async function steckbriefBereit(): Promise<boolean> {
  const { rows } = await dbQuery<any>(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='objekt_felder'`);
  return rows.length > 0;
}

export interface Katalogfeld {
  feld: string; reiter: string; label: string; einheit: string | null;
  art: string; pflicht: boolean; reihenfolge: number;
}

export async function katalog(): Promise<Katalogfeld[]> {
  const { rows } = await dbQuery<any>(
    `SELECT feld, reiter, label, einheit, art, pflicht, reihenfolge
       FROM objekt_feld_katalog WHERE aktiv ORDER BY reiter, reihenfolge`);
  return rows as Katalogfeld[];
}

export interface Feldwert {
  feld: string; reiter: string; label: string; einheit: string | null; art: string;
  pflicht: boolean;
  wert: string | number | null;
  quelle: string | null; quelle_typ: string | null; stand: string | null;
  notes: string | null;
}

/**
 * Felder, die ihren Platz schon in den Stammdaten haben.
 *
 * Diese Angaben werden NICHT doppelt gepflegt: Steht nichts in `objekt_felder`,
 * zählt der Wert aus `properties` beziehungsweise `units`. Sonst stünde die
 * Datenvollständigkeit zu niedrig — die Wohnfläche etwa ist seit jeher an den
 * Einheiten gepflegt und wäre im Steckbrief als Lücke erschienen.
 */
const AUS_STAMMDATEN: Record<string, { quelle: string }> = {
  baujahr: { quelle: 'bikosoc-Stammdaten: properties.construction_year' },
  heizart: { quelle: 'bikosoc-Stammdaten: properties.heating_type' },
  wohnflaeche: { quelle: 'bikosoc-Stammdaten: Summe units.living_area_qm' },
  kaufpreis: { quelle: 'bikosoc-Stammdaten: properties.purchase_price_total' },
  erwerbsdatum: { quelle: 'bikosoc-Stammdaten: properties.acquisition_date beziehungsweise ownership_start' },
  gebaeudeanteil: { quelle: 'bikosoc-Stammdaten: properties.building_value' },
  bodenanteil: { quelle: 'bikosoc-Stammdaten: properties.land_value' },
  afa_satz: { quelle: 'bikosoc-Stammdaten: properties.afa_rate' },
};

/** Katalog und erfasste Werte zusammengeführt — auch das, was fehlt. */
export async function felder(propertyId: number): Promise<Feldwert[]> {
  const { rows } = await dbQuery<any>(`
    SELECT k.feld, k.reiter, k.label, k.einheit, k.art, k.pflicht, k.reihenfolge,
           f.wert_text, f.wert_zahl::float AS wert_zahl,
           to_char(f.wert_datum,'YYYY-MM-DD') AS wert_datum,
           f.quelle, f.quelle_typ, to_char(f.stand,'YYYY-MM-DD') AS stand, f.notes
      FROM objekt_feld_katalog k
      LEFT JOIN objekt_felder f ON f.feld = k.feld AND f.property_id = $1
     WHERE k.aktiv ORDER BY k.reiter, k.reihenfolge`, [propertyId]);
  /* Ersatzwerte aus den Stammdaten — nur fuer Felder ohne eigenen Eintrag. */
  const { rows: stamm } = await dbQuery<any>(`
    SELECT p.construction_year, p.heating_type, p.purchase_price_total::float AS kaufpreis,
           to_char(coalesce(p.acquisition_date, p.ownership_start),'YYYY-MM-DD') AS erwerb,
           p.building_value::float AS gebaeude, p.land_value::float AS boden,
           p.afa_rate::float AS afa,
           (SELECT sum(u.living_area_qm)::float FROM units u
             WHERE u.property_id = p.id AND u.active AND u.archived_at IS NULL) AS wohnflaeche
      FROM properties p WHERE p.id = $1`, [propertyId]);
  const st = stamm[0] || {};
  const ersatz: Record<string, any> = {
    baujahr: st.construction_year, heizart: st.heating_type, wohnflaeche: st.wohnflaeche,
    kaufpreis: st.kaufpreis, erwerbsdatum: st.erwerb, gebaeudeanteil: st.gebaeude,
    bodenanteil: st.boden, afa_satz: st.afa,
  };

  return rows.map((r: any) => {
    const eigen = r.wert_text ?? r.wert_datum ?? (r.wert_zahl === null ? null : r.wert_zahl);
    if (eigen !== null && eigen !== undefined) {
      return {
        feld: r.feld, reiter: r.reiter, label: r.label, einheit: r.einheit, art: r.art,
        pflicht: r.pflicht, wert: eigen,
        quelle: r.quelle, quelle_typ: r.quelle_typ, stand: r.stand, notes: r.notes,
      };
    }
    const aus = AUS_STAMMDATEN[r.feld];
    const v = aus ? ersatz[r.feld] : null;
    return {
      feld: r.feld, reiter: r.reiter, label: r.label, einheit: r.einheit, art: r.art,
      pflicht: r.pflicht,
      wert: v === null || v === undefined ? null : v,
      quelle: v === null || v === undefined ? null : aus!.quelle,
      quelle_typ: v === null || v === undefined ? null : 'db',
      stand: null, notes: null,
    };
  });
}

export interface FeldEingabe {
  property_id: number; feld: string;
  wert_text?: string | null; wert_zahl?: number | null; wert_datum?: string | null;
  quelle: string; quelle_typ?: string; stand?: string | null; notes?: string | null;
}

/**
 * Einen Wert setzen oder fortschreiben.
 *
 * Ohne Quelle wird nicht geschrieben: Die Vorgabe verlangt zu jedem Wert die
 * Fundstelle, und ein leeres Quellenfeld wäre genau die Lücke, die später
 * niemand mehr schließen kann.
 */
export async function setzeFeld(e: FeldEingabe): Promise<void> {
  if (!e.quelle || !e.quelle.trim()) {
    throw new Error(`Feld ${e.feld}: Quelle fehlt — ein Wert ohne Fundstelle wird nicht erfasst.`);
  }
  await dbQuery(`
    INSERT INTO objekt_felder (property_id, feld, wert_text, wert_zahl, wert_datum,
                               quelle, quelle_typ, stand, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (property_id, feld) DO UPDATE SET
      wert_text = EXCLUDED.wert_text, wert_zahl = EXCLUDED.wert_zahl,
      wert_datum = EXCLUDED.wert_datum, quelle = EXCLUDED.quelle,
      quelle_typ = EXCLUDED.quelle_typ, stand = EXCLUDED.stand,
      notes = EXCLUDED.notes, updated_at = now()`,
    [e.property_id, e.feld, e.wert_text ?? null, e.wert_zahl ?? null, e.wert_datum ?? null,
     e.quelle, e.quelle_typ || 'owner', e.stand ?? null, e.notes ?? null]);
}

/** Anteil der belegten Pflichtfelder — die Zahl auf der Kachel. */
export async function vollstaendigkeit(propertyId: number): Promise<{
  pflicht: number; belegt: number; prozent: number; fehlend: string[];
}> {
  const alle = await felder(propertyId);
  const pflicht = alle.filter(f => f.pflicht);
  const belegt = pflicht.filter(f => f.wert !== null && f.wert !== '');
  const fehlend = pflicht.filter(f => f.wert === null || f.wert === '').map(f => f.label);
  return {
    pflicht: pflicht.length, belegt: belegt.length,
    prozent: pflicht.length ? Math.round((belegt.length / pflicht.length) * 100) : 0,
    fehlend,
  };
}

export interface Kachel {
  property_id: number; code: string; name: string; strasse: string | null;
  ampel: 'gruen' | 'rot' | 'unbekannt';
  mieter_rot: number; mieter_gesamt: number; saldo: number; unbestaetigt: number;
  soll_monat: number; soll_jahr: number; ist_jahr: number;
  einheiten: { gesamt: number; vermietet: number; eigen: number; leer: number };
  wohnflaeche: number | null;
  baujahr: number | null;
  heizart: string | null; energietraeger: string | null;
  energie_kennwert: number | null; energie_klasse: string | null; kfw_standard: string | null;
  anschaffungskosten: number | null; bruttomietrendite: number | null;
  naechste_frist: { bezeichnung: string; termin: string; tage: number } | null;
  vollstaendigkeit: number;
}

/**
 * Die Kachel je Objekt.
 *
 * Soll und Ist kommen aus dem Forderungsbuch, nicht aus den Vertragsfeldern:
 * Dort stecken die zeitabhängigen Positionen und die Vorauszahlungsregel schon
 * drin, und nur so stimmt die Kachel mit dem Lämpchen überein.
 */
export async function kacheln(stichtag?: string): Promise<Kachel[]> {
  const heute = stichtag || new Date().toISOString().slice(0, 10);
  const jahr = heute.slice(0, 4);
  const monat = heute.slice(0, 7);

  const { rows: objekte } = await dbQuery<any>(`
    SELECT p.id, p.code, p.name, p.street, p.construction_year, p.heating_type,
           p.purchase_price_total::float AS kaufpreis
      FROM properties p WHERE p.active ORDER BY p.code`);

  const { rows: flaechen } = await dbQuery<any>(`
    SELECT u.property_id, sum(u.living_area_qm)::float AS qm, count(*)::int AS einheiten
      FROM units u WHERE u.active AND u.archived_at IS NULL GROUP BY u.property_id`);

  const { rows: belegung } = await dbQuery<any>(`
    SELECT u.property_id,
           count(*) FILTER (WHERE l.id IS NOT NULL AND NOT coalesce(l.owner_hauptmieter,false))::int AS vermietet,
           count(*) FILTER (WHERE l.id IS NOT NULL AND coalesce(l.owner_hauptmieter,false))::int AS eigen,
           count(*) FILTER (WHERE l.id IS NULL)::int AS leer
      FROM units u
      LEFT JOIN leases l ON l.unit_id = u.id AND l.status = 'active'
       AND (l.end_date IS NULL OR l.end_date >= $1)
     WHERE u.active AND u.archived_at IS NULL
     GROUP BY u.property_id`, [heute]);

  const { rows: soll } = await dbQuery<any>(`
    SELECT p.id AS property_id,
           sum(r.expected_amount) FILTER (WHERE to_char(r.period_month,'YYYY-MM') = $1)::float AS soll_monat,
           sum(r.expected_amount) FILTER (WHERE to_char(r.period_month,'YYYY') = $2)::float AS soll_jahr,
           sum(coalesce(r.paid_amount,0)) FILTER (WHERE to_char(r.period_month,'YYYY') = $2)::float AS ist_jahr
      FROM rent_ledger r
      JOIN leases l ON l.id = r.lease_id
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
     GROUP BY p.id`, [monat, jahr]);

  const ampeln = await ampelJeObjekt(heute).catch(() => [] as any[]);

  const bereit = await steckbriefBereit();
  const werte = new Map<number, Map<string, any>>();
  const vollst = new Map<number, number>();
  const fristen = new Map<number, { bezeichnung: string; termin: string; tage: number }>();
  if (bereit) {
    const { rows: f } = await dbQuery<any>(`
      SELECT property_id, feld, wert_text, wert_zahl::float AS wert_zahl,
             to_char(wert_datum,'YYYY-MM-DD') AS wert_datum FROM objekt_felder`);
    for (const r of f) {
      const m = werte.get(r.property_id) || new Map<string, any>();
      m.set(r.feld, r.wert_text ?? r.wert_datum ?? r.wert_zahl);
      werte.set(r.property_id, m);
    }
    for (const o of objekte) vollst.set(o.id, (await vollstaendigkeit(o.id)).prozent);
    const { rows: fr } = await dbQuery<any>(`
      SELECT DISTINCT ON (property_id) property_id, bezeichnung,
             to_char(termin,'YYYY-MM-DD') AS termin, (termin - $1::date) AS tage
        FROM objekt_fristen WHERE erledigt_am IS NULL AND termin >= $1::date
       ORDER BY property_id, termin`, [heute]);
    for (const r of fr) fristen.set(r.property_id,
      { bezeichnung: r.bezeichnung, termin: r.termin, tage: r.tage });
  }

  const zahl = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));

  return objekte.map((o: any) => {
    const fl = flaechen.find((x: any) => x.property_id === o.id);
    const be = belegung.find((x: any) => x.property_id === o.id);
    const so = soll.find((x: any) => x.property_id === o.id);
    const am = ampeln.find((x: any) => x.objekt === o.code);
    const w = werte.get(o.id) || new Map<string, any>();

    const sollMonat = Math.round((so?.soll_monat || 0) * 100) / 100;
    const sollJahr = Math.round((so?.soll_jahr || 0) * 100) / 100;
    const anschaffung = zahl(w.get('anschaffungskosten'))
      ?? zahl(w.get('herstellungskosten')) ?? (o.kaufpreis || null);
    /* Bruttomietrendite: Jahressoll geteilt durch die Anschaffungskosten. Ohne
       belegte Anschaffungskosten gibt es keine Rendite — keine Schaetzung. */
    const rendite = anschaffung && anschaffung > 0 && sollJahr > 0
      ? Math.round((sollJahr / anschaffung) * 10000) / 100 : null;

    return {
      property_id: o.id, code: o.code, name: o.name, strasse: o.street,
      ampel: am ? am.farbe : 'unbekannt',
      mieter_rot: am?.mieter_rot ?? 0, mieter_gesamt: am?.mieter_gesamt ?? 0,
      saldo: am?.saldo ?? 0, unbestaetigt: am?.unbestaetigt ?? 0,
      soll_monat: sollMonat, soll_jahr: sollJahr,
      ist_jahr: Math.round((so?.ist_jahr || 0) * 100) / 100,
      einheiten: {
        gesamt: fl?.einheiten ?? 0, vermietet: be?.vermietet ?? 0,
        eigen: be?.eigen ?? 0, leer: be?.leer ?? 0,
      },
      wohnflaeche: fl?.qm ?? null,
      baujahr: o.construction_year ?? zahl(w.get('baujahr')),
      heizart: o.heating_type ?? (w.get('heizart') || null),
      energietraeger: w.get('energietraeger') || null,
      energie_kennwert: zahl(w.get('energieausweis_wert')),
      energie_klasse: w.get('energieausweis_klasse') || null,
      kfw_standard: w.get('kfw_standard') || null,
      anschaffungskosten: anschaffung,
      bruttomietrendite: rendite,
      naechste_frist: fristen.get(o.id) || null,
      vollstaendigkeit: vollst.get(o.id) ?? 0,
    };
  });
}

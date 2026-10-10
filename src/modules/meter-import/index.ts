/**
 * meter-import — Zählerstände aus den Monatsberichten der Gebäudeautomation.
 *
 * Owner-Leitprinzip (10.10.2026): Was dauerhaft anfällt, läuft ohne Handgriff.
 * Die Firma Fiehn schickt für MG24 monatlich vier Berichte als XLSX-Anlage.
 * Dieses Modul liest sie aus dem Postfach, trägt die Monatsendstände als
 * `meter_readings` ein und meldet NUR, wenn etwas nicht stimmt.
 *
 * Grenzen, bewusst gesetzt:
 *   - Es schreibt ausschließlich Zählerstände, nichts anderes.
 *   - Geschrieben wird über dieselbe geprüfte Einfügestrecke wie bei der
 *     Bulk-Route, mit Audit-Eintrag je Zähler.
 *   - Doppelte Stände (gleicher Zähler, gleicher Zeitpunkt) werden vor dem
 *     Schreiben aussortiert — ein erneuter Lauf verdoppelt nichts.
 *   - Kein eigener Dienst und kein eigener Timer: der Lauf hängt am
 *     bestehenden Mail-Intervall.
 */
import { query as dbQuery, getClient } from '../../shared/db/index.js';
import { graphGet } from '../../shared/m365/index.js';
import { ladeMapping, findeObjekt, schwellenFuer, istBekannt } from './config.js';
import { leseBericht, monatsStaende, einheitFuer } from './parser.js';
import {
  pruefeMonotonie, pruefeBilanz, pruefeSprung, pruefeFehlenderBericht,
  type Abweichung, type ZaehlerStand,
} from './pruefung.js';

export const ABSENDER = 'fiehn.gebaeudeautomation@gmx.de';

export interface ImportErgebnis {
  mailsGesehen: number;
  mailsVerarbeitet: number;
  staendeNeu: number;
  staendeDoppelt: number;
  abweichungen: Abweichung[];
  objekte: Record<string, number>;
  fehler: string[];
}

export interface ImportDeps {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  m365User: string;
  logger: { info: (m: string) => void; warn: (m: string) => void };
  /** Für Tests: überspringt Graph und liefert die Anlagen direkt. */
  anlagenLader?: () => Promise<{ mailId: string; name: string; inhalt: Buffer }[]>;
  jetzt?: Date;
}

/* ── Verarbeitungsstand ────────────────────────────────────────────────────
   Welche Mail schon gelesen wurde, steht in `system_settings`. Eine eigene
   Tabelle wäre eine Migration; für eine Liste von Nachrichtenkennungen ist
   das unverhältnismäßig. */
const STAND_KEY = 'meter_import_verarbeitet';

async function ladeVerarbeitet(): Promise<Set<string>> {
  const { rows } = await dbQuery('SELECT value FROM system_settings WHERE key = $1', [STAND_KEY]);
  const liste = rows[0]?.value;
  return new Set(Array.isArray(liste) ? liste : []);
}

async function speichereVerarbeitet(ids: Set<string>): Promise<void> {
  /* Nur die jüngsten tausend behalten — die Liste dient dem Dedupe, nicht als
     Archiv. Der eigentliche Schutz gegen Doppelbuchung sind die Zählerstände
     selbst (Zähler + Zeitpunkt). */
  const liste = [...ids].slice(-1000);
  await dbQuery(
    `INSERT INTO system_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [STAND_KEY, JSON.stringify(liste)],
  );
}

/* ── Mails holen ──────────────────────────────────────────────────────────── */

async function holeAnlagen(deps: ImportDeps, verarbeitet: Set<string>) {
  const u = encodeURIComponent(deps.m365User);
  /* Kein $orderby zusammen mit dem Absenderfilter: Graph lehnt die
     Kombination mit "InefficientFilter" ab, weil das Absenderfeld nicht
     indiziert ist. Sortiert wird deshalb hier. */
  const filter = `$filter=${encodeURIComponent(`from/emailAddress/address eq '${ABSENDER}'`)}`;
  const url = `https://graph.microsoft.com/v1.0/users/${u}/messages`
    + `?${filter}&$top=40&$select=id,subject,receivedDateTime,hasAttachments`;

  const liste = await graphGet(deps.tenantId, deps.clientId, deps.clientSecret, url);
  const mails = (liste?.value || [])
    .filter((m: any) => m.hasAttachments && !verarbeitet.has(m.id))
    .sort((x: any, y: any) => String(x.receivedDateTime).localeCompare(String(y.receivedDateTime)));

  const out: { mailId: string; name: string; inhalt: Buffer }[] = [];
  for (const mail of mails) {
    const anlagen = await graphGet(
      deps.tenantId, deps.clientId, deps.clientSecret,
      `https://graph.microsoft.com/v1.0/users/${u}/messages/${encodeURIComponent(mail.id)}/attachments`,
    );
    for (const a of anlagen?.value || []) {
      if (!a.contentBytes || !/\.xlsx$/i.test(a.name || '')) continue;
      out.push({ mailId: mail.id, name: a.name, inhalt: Buffer.from(a.contentBytes, 'base64') });
    }
  }
  return out;
}

/* ── Hauptlauf ────────────────────────────────────────────────────────────── */

export async function importiereZaehlerstaende(deps: ImportDeps): Promise<ImportErgebnis> {
  const jetzt = deps.jetzt || new Date();
  const ergebnis: ImportErgebnis = {
    mailsGesehen: 0, mailsVerarbeitet: 0, staendeNeu: 0, staendeDoppelt: 0,
    abweichungen: [], objekte: {}, fehler: [],
  };

  const mapping = await ladeMapping();
  const verarbeitet = await ladeVerarbeitet();

  let anlagen: { mailId: string; name: string; inhalt: Buffer }[];
  try {
    anlagen = deps.anlagenLader ? await deps.anlagenLader() : await holeAnlagen(deps, verarbeitet);
  } catch (e: any) {
    ergebnis.fehler.push(`Postfach nicht lesbar: ${e.message}`);
    return ergebnis;
  }
  ergebnis.mailsGesehen = new Set(anlagen.map(a => a.mailId)).size;

  /* Alle Stände eines Laufs sammeln, erst danach prüfen — die Bilanzprüfung
     braucht Haupt- und Unterzähler desselben Objekts nebeneinander. */
  const gesammelt: ZaehlerStand[] = [];
  const beruehrteObjekte = new Map<string, ReturnType<typeof findeObjekt>>();

  for (const anlage of anlagen) {
    try {
      const bericht = leseBericht(anlage.inhalt);
      const treffer = findeObjekt(mapping, bericht.ueberschrift);
      if (!treffer) {
        ergebnis.fehler.push(
          `Bericht "${anlage.name}" (${bericht.ueberschrift.slice(0, 60)}) hat keine Zuordnung in `
          + 'system_settings.meter_import_mapping — nicht importiert.');
        continue;
      }
      if (!bericht.ebene) {
        ergebnis.fehler.push(`Bericht "${anlage.name}": Ebene nicht erkennbar — nicht importiert.`);
        continue;
      }
      const spalten = treffer.zuordnung.ebenen[bericht.ebene];
      if (!spalten) {
        ergebnis.fehler.push(
          `Bericht "${anlage.name}": Ebene ${bericht.ebene} ist für ${treffer.zuordnung.property} nicht zugeordnet.`);
        continue;
      }
      beruehrteObjekte.set(treffer.zuordnung.property, treffer);

      for (const [gruppe, staende] of monatsStaende(bericht.staende)) {
        const meterNumber = spalten[gruppe];
        if (!meterNumber) {
          ergebnis.fehler.push(
            `Bericht "${anlage.name}": Spalte "${gruppe}" ist nicht zugeordnet.`);
          continue;
        }
        const gespeichert = await schreibeStaende(meterNumber, staende, anlage.mailId);
        ergebnis.staendeNeu += gespeichert.neu;
        ergebnis.staendeDoppelt += gespeichert.doppelt;
        ergebnis.objekte[treffer.zuordnung.property] =
          (ergebnis.objekte[treffer.zuordnung.property] || 0) + gespeichert.neu;
        gesammelt.push(...gespeichert.fuerPruefung);
      }

      verarbeitet.add(anlage.mailId);
      ergebnis.mailsVerarbeitet++;
    } catch (e: any) {
      ergebnis.fehler.push(`Bericht "${anlage.name}": ${e.message}`);
    }
  }

  await speichereVerarbeitet(verarbeitet);

  // Prüfungen je berührtem Objekt
  for (const [property, treffer] of beruehrteObjekte) {
    if (!treffer) continue;
    const schwellen = schwellenFuer(treffer.zuordnung);
    /* Ein Zaehler kommt in mehreren Berichten eines Laufs vor (die Berichte
       ueberlappen sich am Monatsrand). Ohne diese Entdopplung summierte die
       Bilanz denselben Zaehler mehrfach — bei MG24 ergaben sich so 401.268
       statt 49.720 kWh. Behalten wird je Zaehler der juengste Eintrag. */
    const jeZaehler = new Map<string, ZaehlerStand>();
    for (const s of gesammelt) {
      if (!s.meterNumber.startsWith(property.toUpperCase())) continue;
      const bisher = jeZaehler.get(s.meterNumber);
      if (!bisher || s.monat > bisher.monat) jeZaehler.set(s.meterNumber, s);
    }
    const eigene = [...jeZaehler.values()];
    const roh = [
      ...pruefeMonotonie(eigene),
      ...pruefeBilanz(eigene, schwellen),
      ...pruefeSprung(eigene, schwellen),
      ...pruefeFehlenderBericht(letzterMonat(eigene), jetzt, schwellen),
    ];
    /* Ein Zaehler kommt in mehreren Berichten eines Laufs vor; ohne diese
       Entdopplung stuende derselbe Befund zehnmal in der Meldung. */
    const gesehen = new Set<string>();
    for (const a of roh) {
      const grund = istBekannt(treffer.zuordnung, a.pruefung, jetzt);
      if (grund) continue; // bekannt und begründet — geht nur in die Wochenzeile
      const schluessel = `${a.pruefung}|${a.zaehler || ''}|${a.text}`;
      if (gesehen.has(schluessel)) continue;
      gesehen.add(schluessel);
      ergebnis.abweichungen.push({ ...a, text: `${property.toUpperCase()}: ${a.text}` });
    }
  }

  return ergebnis;
}

function letzterMonat(staende: ZaehlerStand[]): string | null {
  const monate = staende.map(s => s.monat).sort();
  return monate.length ? monate[monate.length - 1] : null;
}

/* ── Schreiben ────────────────────────────────────────────────────────────── */

async function schreibeStaende(
  meterNumber: string,
  staende: { zeitpunkt: string; wert: number }[],
  mailId: string,
): Promise<{ neu: number; doppelt: number; fuerPruefung: ZaehlerStand[] }> {
  const { rows: meterRows } = await dbQuery(
    'SELECT id, medium, is_main_meter, unit_id FROM meters WHERE meter_number = $1', [meterNumber]);
  if (meterRows.length === 0) {
    throw new Error(`Zähler ${meterNumber} ist in der Datenbank nicht angelegt`);
  }
  const meter = meterRows[0];
  const { einheit, teiler } = einheitFuer(meterNumber);

  const { rows: vorhanden } = await dbQuery(
    'SELECT read_at, value FROM meter_readings WHERE meter_id = $1 ORDER BY read_at', [meter.id]);
  const bekannteZeitpunkte = new Set(
    vorhanden.map((r: any) => new Date(r.read_at).toISOString().slice(0, 16)));
  /* Die Berichte ueberlappen sich am Monatsrand: Der Bericht fuer Maerz
     enthaelt die letzten Februartage gleich mit. Ohne diese Sperre entstuenden
     mehrere "Monatsendstaende" je Monat, je nachdem aus welchem Bericht sie
     stammen. Gespeichert wird deshalb nur, was spaeter liegt als der bereits
     vorhandene Stand desselben Monats. */
  const juengsterJeMonat = new Map<string, string>();
  for (const r of vorhanden) {
    const iso = new Date(r.read_at).toISOString();
    const monat = iso.slice(0, 7);
    const bisher = juengsterJeMonat.get(monat);
    if (!bisher || iso > bisher) juengsterJeMonat.set(monat, iso);
  }

  let neu = 0, doppelt = 0;
  const fuerPruefung: ZaehlerStand[] = [];
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const angelegt: number[] = [];

    for (const s of staende) {
      const wert = Math.round((s.wert / teiler) * 1000) / 1000;
      const readAt = `${s.zeitpunkt.replace(' ', 'T')}:00+01:00`;
      const iso = new Date(readAt).toISOString();
      const schluessel = iso.slice(0, 16);
      if (bekannteZeitpunkte.has(schluessel)) { doppelt++; continue; }
      const monat = s.zeitpunkt.slice(0, 7);
      const juengster = juengsterJeMonat.get(iso.slice(0, 7));
      if (juengster && juengster >= iso) { doppelt++; continue; }
      const { rows } = await client.query(
        `INSERT INTO meter_readings (meter_id, value, unit, reading_type, read_at, source, reader_name, notes)
         VALUES ($1,$2,$3,$4,$5,'automatic',$6,$7) RETURNING id`,
        [meter.id, wert, einheit,
         monat.endsWith('-12') || s.zeitpunkt.startsWith(`${monat.slice(0, 4)}-01-01`) ? 'annual' : 'interim',
         readAt, 'Fiehn Gebäudeautomation (M-Bus)',
         `Automatischer Import aus dem Monatsbericht ${monat}, protokollierter Stand ${s.zeitpunkt}. Mail ${mailId}.`],
      );
      angelegt.push(rows[0].id);
      bekannteZeitpunkte.add(schluessel);
      juengsterJeMonat.set(iso.slice(0, 7), iso);
      neu++;
    }

    if (angelegt.length > 0) {
      await client.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source)
         VALUES ('meter-import', 'assets', 'meter_reading.auto_import', 'meter', $1, $2, 'system')`,
        [String(meter.id), JSON.stringify({ meter_number: meterNumber, count: angelegt.length, reading_ids: angelegt, mail_id: mailId })],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  /* Für die Prüfungen: der jüngste Monat mit Vormonat und Vorvormonat. */
  const alle = [...vorhanden.map((r: any) => ({
    monat: new Date(r.read_at).toISOString().slice(0, 7), wert: Number(r.value),
  })), ...staende.map(s => ({ monat: s.zeitpunkt.slice(0, 7), wert: Math.round((s.wert / teiler) * 1000) / 1000 }))];
  const proMonat = new Map<string, number>();
  for (const a of alle) proMonat.set(a.monat, a.wert);
  /* Geprueft wird nur der juengste ABGESCHLOSSENE Monat. Der laufende Monat
     ist je Zaehler unterschiedlich weit protokolliert — eine Bilanz darueber
     vergliche Teilzeitraeume und schluege jeden Monatsanfang grundlos an. */
  const laufenderMonat = new Date().toISOString().slice(0, 7);
  const monate = [...proMonat.keys()].filter(m => m < laufenderMonat).sort();
  if (monate.length >= 2) {
    const m = monate[monate.length - 1], v = monate[monate.length - 2];
    const vv = monate.length >= 3 ? monate[monate.length - 3] : null;
    fuerPruefung.push({
      meterNumber, medium: meter.medium,
      istHauptzaehler: !!meter.is_main_meter,
      gehoertZuEinheit: !!meter.unit_id,
      monat: m, wert: proMonat.get(m)!,
      vorher: { monat: v, wert: proMonat.get(v)! },
      vormonatsVerbrauch: vv ? proMonat.get(v)! - proMonat.get(vv)! : undefined,
    });
  }

  return { neu, doppelt, fuerPruefung };
}

/** Eine Zeile für die Montags-Zusammenfassung, oder null wenn nichts lief. */
export function wochenZeile(ergebnis: ImportErgebnis): string | null {
  const objekte = Object.entries(ergebnis.objekte).filter(([, n]) => n > 0);
  if (objekte.length === 0) return null;
  return objekte
    .map(([p, n]) => `Zähler ${p.toUpperCase()}: ${n} ${n === 1 ? 'Stand' : 'Stände'} importiert`)
    .join(' · ');
}

/** Meldungstext — null bedeutet: still bleiben. */
export function meldung(ergebnis: ImportErgebnis): string | null {
  if (ergebnis.abweichungen.length === 0 && ergebnis.fehler.length === 0) return null;
  const zeilen = ['*Zählerimport — Abweichung*', ''];
  for (const a of ergebnis.abweichungen) zeilen.push(`• ${a.text}`);
  for (const f of ergebnis.fehler) zeilen.push(`• ${f}`);
  if (ergebnis.staendeNeu > 0) {
    zeilen.push('', `${ergebnis.staendeNeu} Stände wurden trotzdem übernommen — die Zeitreihe bleibt lückenlos.`);
  }
  return zeilen.join('\n');
}

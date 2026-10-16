#!/usr/bin/env bun
/**
 * Zwischenstände je Zähler für das Casameta-Portal.
 *
 * Das Eingabeblatt nennt je Wohnung EINE Methode („Zwischenablesung vorhanden"
 * oder „§ 9b-Aufteilung"). Für die Eingabe im Portal braucht der Owner aber die
 * Stände JE ZÄHLER: Anfang, Einzug, Ende — und daraus getrennt den Verbrauch
 * vor und nach dem Einzug.
 *
 * Bis zum 16.10.2026 entstand diese Datei von Hand. Das ist genau die Stelle,
 * an der eine Korrektur im Bestand nicht ankommt: Am 11.10. wurden die
 * Einzugsstände W1/W2 nachgetragen, die Datei blieb aber stehen.
 *
 * KURZKENNUNGEN. Die Spalte `kurz_id` ist eine Kennung des PORTALS (SWTKW,
 * W1KW …), nicht von bikosoc. Sie steht in keiner Tabelle. Damit sie nicht
 * verlorengeht, wird sie aus der vorhandenen Datei übernommen, über die
 * Zählernummer zugeordnet. Fehlt sie dort, bleibt das Feld leer — raten wäre
 * hier schlimmer als eine Lücke.
 *
 * Aufruf:
 *   bun run scripts/casameta-zwischenstaende.ts --objekt mg24 --jahr 2025 [--alt <datei>]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function envWert(s: string): string {
  const t = readFileSync(join(homedir(), '.config', 'openclaw', 'env'), 'utf-8')
    .match(new RegExp(`^${s}=(.+)$`, 'm'));
  if (!t) throw new Error(`${s} fehlt in der Env-Datei`);
  return t[1].trim();
}

const argv = process.argv;
const objekt = (argv[argv.indexOf('--objekt') + 1] || '').toLowerCase();
const jahr = parseInt(argv[argv.indexOf('--jahr') + 1] || '', 10);
if (!objekt || !Number.isInteger(jahr)) {
  console.error('Aufruf: --objekt <code> --jahr <jjjj> [--alt <datei>]');
  process.exit(1);
}
if (!process.env.POSTGRES_URL) process.env.POSTGRES_URL = envWert('POSTGRES_URL');

const ZIEL = join(homedir(), 'bikosoc-spec', 'casameta');
const altPfad = argv.includes('--alt')
  ? argv[argv.indexOf('--alt') + 1]
  : join(ZIEL, `zwischenstaende-${objekt}-${jahr}.csv`);

/** Kurzkennungen des Portals aus der vorhandenen Datei übernehmen. */
const kurzVon = new Map<string, string>();
if (existsSync(altPfad)) {
  for (const zeile of readFileSync(altPfad, 'utf-8').split('\n').slice(1)) {
    const s = zeile.split(';');
    if (s.length > 1 && s[0] && s[1]) kurzVon.set(s[0].trim(), s[1].trim());
  }
}

const { query } = await import('../src/shared/db/index.js');

const von = `${jahr}-01-01`;
const bis = `${jahr}-12-31`;

/* Ein Zaehler haengt ENTWEDER am Objekt (scope_type='property', dann ist
   unit_id leer) ODER an einer Einheit (dann ist property_id leer). Wer nur
   ueber property_id verknuepft, verliert saemtliche Wohnungszaehler — beim
   ersten Lauf am 16.10.2026 genau so passiert: neun Zeilen statt
   fuenfundzwanzig. */
const { rows: zaehler } = await query<any>(`
  SELECT m.id, m.meter_number, m.medium, m.active, m.scope_type,
         m.initial_reading::float AS initial_reading,
         COALESCE(u.code, 'Objekt') AS einheit,
         to_char(l.start_date, 'YYYY-MM-DD') AS einzug
    FROM meters m
    LEFT JOIN units u ON u.id = m.unit_id
    LEFT JOIN properties po ON po.id = u.property_id
    LEFT JOIN properties pm ON pm.id = m.property_id
    LEFT JOIN leases l ON l.unit_id = u.id AND l.status = 'active'
                      AND l.start_date BETWEEN $2::date AND $3::date
   WHERE COALESCE(pm.code, po.code) = $1
   ORDER BY COALESCE(u.code, '0'), m.meter_number`, [objekt, von, bis]);

/* `read_at` ist ein Zeitstempel. `BETWEEN … AND '2025-12-31'` meint dort
   Mitternacht und schneidet jede Ablesung AM 31.12. ab — beim ersten Lauf
   stand deshalb 48.116 kWh statt 54.327 im Blatt. Deshalb auf das Datum
   casten statt auf den Zeitstempel zu vergleichen. */
const { rows: staende } = await query<any>(`
  SELECT r.meter_id, to_char(r.read_at, 'YYYY-MM-DD') AS tag,
         r.value::float AS wert, r.reading_type
    FROM meter_readings r
    JOIN meters m ON m.id = r.meter_id
    LEFT JOIN units u ON u.id = m.unit_id
    LEFT JOIN properties po ON po.id = u.property_id
    LEFT JOIN properties pm ON pm.id = m.property_id
   WHERE COALESCE(pm.code, po.code) = $1
     AND r.read_at::date BETWEEN $2::date AND $3::date
   ORDER BY r.meter_id, r.read_at`, [objekt, von, bis]);

const proZaehler = new Map<number, any[]>();
for (const s of staende) {
  if (!proZaehler.has(s.meter_id)) proZaehler.set(s.meter_id, []);
  proZaehler.get(s.meter_id)!.push(s);
}

/** Einheit je Medium — so, wie das Portal sie erwartet. */
const EINHEIT: Record<string, string> = {
  cold_water: 'm³', warm_water: 'm³', hot_water: 'm³', water: 'm³',
  heat: 'kWh', electricity: 'kWh', gas: 'm³',
};

const zeilen: string[] = [
  'zaehler_kennung;kurz_id;wohnung;einheit;skala;stand_01_01_' + jahr
  + ';stand_einzug;einzugsdatum;stand_31_12_' + jahr
  + ';verbrauch_leerstand;verbrauch_mieter;methode',
];

const zahl = (v: number | null, medium: string) =>
  v === null || v === undefined ? ''
    : (medium === 'heat' || medium === 'electricity' ? String(Math.round(v)) : v.toFixed(3));

for (const z of zaehler) {
  const liste = proZaehler.get(z.id) ?? [];
  if (liste.length === 0 && z.initial_reading === null) {
    zeilen.push([z.meter_number, kurzVon.get(z.meter_number) ?? '', z.einheit,
      EINHEIT[z.medium] ?? '', 'Zaehlerstand absolut', '', '', '', '', '', '',
      'keine Messung'].join(';'));
    continue;
  }

  const amAnfang = liste.find((s) => s.tag === von && s.reading_type === 'annual')
    ?? liste.find((s) => s.tag === von);
  const einzug = liste.find((s) => s.reading_type === 'move_in');
  /* Der Jahresabschluss ist die LETZTE Jahresablesung — nicht einfach die
     letzte Zeile: Dazwischen koennen Zwischenablesungen liegen. */
  const jahresende = [...liste].reverse().find((s) => s.reading_type === 'annual')
    ?? [...liste].reverse()[0];

  const anfang = amAnfang ? amAnfang.wert : z.initial_reading;
  const ende = jahresende ? jahresende.wert : null;
  const eWert = einzug ? einzug.wert : null;
  const eTag = einzug ? einzug.tag : '';

  /* Methode aus den Daten, nicht aus der Erinnerung: Liegt zum Einzugstag des
     Vertrags eine Ablesung vor, wird gemessen getrennt. Liegt eine Ablesung
     an einem ANDEREN Tag vor, ist sie fuer die Trennung nicht brauchbar. */
  let methode: string;
  if (z.scope_type !== 'unit') methode = 'Objektzaehler';
  else if (!z.einzug) methode = 'kein Nutzerwechsel im Jahr';
  else if (einzug && einzug.tag === z.einzug) methode = `Zwischenablesung ${einzug.tag}`;
  else if (einzug) methode = `Ablesung ${einzug.tag} weicht vom Einzug ${z.einzug} ab`;
  /* Paragraf 9b HeizkostenV regelt Waerme und Warmwasser. Ein Stromzaehler
     faellt nicht darunter; dort waere die Angabe schlicht falsch. */
  else if (z.medium === 'heat' || z.medium === 'warm_water' || z.medium === 'cold_water') {
    methode = 'Paragraf 9b-Aufteilung, Zwischenablesung fehlt';
  } else methode = 'Zwischenablesung fehlt, zeitanteilig';

  const leer = eWert !== null && anfang !== null ? eWert - anfang : null;
  const mieter = ende !== null && eWert !== null ? ende - eWert : null;

  zeilen.push([
    z.meter_number,
    kurzVon.get(z.meter_number) ?? '',
    z.einheit,
    EINHEIT[z.medium] ?? '',
    'Zaehlerstand absolut',
    zahl(anfang, z.medium),
    zahl(eWert, z.medium),
    eTag,
    zahl(ende, z.medium),
    zahl(leer, z.medium),
    zahl(mieter, z.medium),
    methode,
  ].join(';'));
}

mkdirSync(ZIEL, { recursive: true });
const pfad = join(ZIEL, `zwischenstaende-${objekt}-${jahr}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`);
writeFileSync(pfad, zeilen.join('\n') + '\n');
console.log(`${zeilen.length - 1} Zaehlerzeilen`);
console.log(`  ohne Kurzkennung: ${zaehler.filter((z: any) => !kurzVon.has(z.meter_number)).length}`);
console.log(`  ${pfad}`);
process.exit(0);

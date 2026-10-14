/**
 * scripts/l19-trinkwasser-s28-anfangsstaende — Auftrag vom 14.10.2026.
 *
 * TEIL 1 — L19. Gesucht waren die Trinkwasserzaehler der Wohnungen. Es gibt
 * keine. Die vier Geraete, die eddi24 als „Kaltwasserzaehler" (KWZ) abrechnet,
 * sind WAERMEZAEHLER:
 *
 *   - Gehaeuseaufdruck „Heat Meter", Typ WDV Molliné Ultramess C SensoStar 2U,
 *     Art. 1100104803, Theta 0-105 Grad C, Delta-Theta 3-100 K.
 *   - Das Display zeigt MWh. Der abgelesene Wert stimmt ZIFFERNWEISE mit dem
 *     Wert ueberein, den eddi24 als KWZ-Stand in Kubikmetern abrechnet.
 *     eddi24 liest also das Energieregister und verbucht es als Wasser.
 *   - Waermebilanz 2024: vier „KWZ" 29,116 + vier Wohnungs-Waermezaehler 7,701
 *     = 36,817 MWh gegen 43,169 MWh am zentralen Zaehler 40450611 (85,3 %).
 *
 * Ebenso ist 40450611 („Gemeindewasserzaehler" bei eddi24) kein Wasserzaehler,
 * sondern der ZENTRALE WAERMEZAEHLER der Waermepumpe: Display 400.577 MWh und
 * 16,134 kW. 2025: 37,865 MWh Waerme gegen 12,708 MWh Waermestrom — JAZ 2,98.
 *
 * Dieses Skript aendert deshalb KEIN Medium und legt KEINE Verbrauchsregel fuer
 * Wasser oder Schmutzwasser an: Mit den vorhandenen Daten wuerde die Engine das
 * Wasser nach Waermezaehlerstaenden verteilen — genau der Fehler, den eddi24
 * seit Jahren macht. Es schreibt den Befund in die Zaehlernotizen und legt die
 * eine Regel an, die unabhaengig davon gilt: Niederschlagswasser nach Flaeche.
 *
 * TEIL 2 — S28. Anfangsstaende 01.01.2025 fuer W1, als Schaetzung mit
 * Owner-Freigabe (Rueckrechnung aus dem Verbrauch 02.04.-31.12.2025).
 *
 * Aufruf:  bun run scripts/l19-trinkwasser-s28-anfangsstaende.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';
const ANWENDEN = process.argv.includes('--apply');

const SP = '5-L19/Nebenkostenabrechnungen Mieter/';
const FOTO: Record<string, string> = {
  '53650437': SP + '2025/Zählerstände_20260103_App-1.pdf',
  '53650518': SP + '2025/Zählerstände_20251228_App-2.pdf',
  '53650734': SP + '2025/Zählerstände_20251223_App-3.pdf',
  '53650737': SP + '2025/Zählerstände_20251223_App-4.pdf',
  '40450611': SP + '2025/Zählerstände_20251223_Haus.pdf',
  'Z2001676': SP + '2025/Zählerstände_20251223_Haus.pdf',
};
const EDDI = SP + '2024/Abrechnungen in 2025 erstellt/NK/Uebersicht_NK_21.12.2025 14_12.pdf';

const BEFUND_GEMEINSAM =
  'Waermebilanz 2024 als Gegenprobe: die vier „KWZ" (29,116) und die vier '
  + 'Wohnungs-Waermezaehler (7,701) ergeben zusammen 36,817 MWh gegen 43,169 MWh '
  + 'am zentralen Waermezaehler 40450611 — 85,3 Prozent. 2025 sind es 32,589 von '
  + '37,865 MWh (86,1 Prozent). Zum Vergleich: der Hauswasserzaehler Z2001676 '
  + 'misst 476 m3 im Jahr; die vier Geraete zusammen 26,345 — 5,5 Prozent. '
  + 'FOLGE: In den Wohnungen von L19 ist keine Trinkwassermessung belegt. '
  + 'Welchen Kreis dieses Geraet misst (Heizung oder Warmwasser), ist nicht belegt '
  + 'und bleibt offen. Medium und Einheit sind UNVERAENDERT gelassen (cold_water, '
  + 'm3), weil die Umstellung zugleich die Grundlage der Heizkostenverteilung '
  + 'aendert — das ist eine Owner-Entscheidung.';

function kwzNotiz(nummer: string): string {
  return 'BERICHTIGT UND BELEGT AM 14.10.2026 — dieses Geraet ist ein WAERMEZAEHLER, '
    + 'kein Trinkwasserzaehler. Beweis am Zaehlerfoto: Gehaeuseaufdruck „Heat Meter", '
    + 'Typ WDV Molliné Ultramess C SensoStar 2U, Art. 1100104803, Theta 0-105 Grad C, '
    + 'Delta-Theta 3-100 K; das Display zeigt den Stand in MWh, nicht in m3. Der '
    + 'abgelesene Wert stimmt ziffernweise mit dem Stand ueberein, den eddi24 als '
    + '„KWZ" in Kubikmetern abrechnet — eddi24 liest also das Energieregister und '
    + 'verbucht es als Kaltwasser (eddi24-Uebersicht NK 2024, Abschnitt '
    + '„Wasserzaehlerstaende der Nutzer", Schluessel VKW). '
    + `Belegpfade: ${FOTO[nummer]} und ${EDDI}. ` + BEFUND_GEMEINSAM;
}

const NOTIZEN: Record<string, string> = {
  '53650437': kwzNotiz('53650437'),
  '53650518': kwzNotiz('53650518'),
  '53650734': kwzNotiz('53650734'),
  '53650737': kwzNotiz('53650737'),
  '40450611':
    'BERICHTIGT UND BELEGT AM 14.10.2026 — dieses Geraet ist der ZENTRALE '
    + 'WAERMEZAEHLER der Waermepumpe, kein Wasserzaehler. Beweis am Zaehlerfoto '
    + `(${FOTO['40450611']}): WDV Molliné SensoStar 2; das Display zeigt 400.577 MWh, `
    + 'im Wechsel dazu 16,134 kW Momentanleistung. eddi24 fuehrt das Geraet als '
    + '„Gemeindewasserzaehler, nur informativ" und verbucht die MWh als Kubikmeter. '
    + 'Waermemenge 2025: 400,577 minus 362,712 = 37,865 MWh gegen 12,708 MWh '
    + 'Waermestrom am Abrechnungszaehler 64128135 — Jahresarbeitszahl 2,98, fuer '
    + 'eine Waermepumpe stimmig. DAMIT IST DER IN DER VORPRUEFUNG FEHLENDE '
    + 'HAUPT-WAERMEMENGENZAEHLER GEFUNDEN. Medium (cold_water) und Einheit (m3) '
    + 'sind unveraendert gelassen: die Umstellung auf Waerme setzt zugleich das '
    + 'Kennzeichen Hauptzaehler und aendert die Heizkostenverteilung — '
    + 'Owner-Entscheidung.',
  'Z2001676':
    'ERGAENZT AM 14.10.2026: Dies ist der EINZIGE Trinkwasserzaehler, der fuer L19 '
    + 'belegt ist. Geprueft wurden die Zaehlerfotos 2024 und 2025 (Haus und alle '
    + 'vier Wohnungen), die eddi24-Abrechnung 2024 und der SharePoint-Bestand zu '
    + 'L19 — ein weiterer Wasserzaehler kommt nirgends vor. Die vier Geraete, die '
    + 'eddi24 als Kaltwasserzaehler fuehrt, sind Waermezaehler; siehe deren Notizen. '
    + 'Verbrauch 2025: 476 m3 (1.854 am 31.12.2024 auf 2.330 am 31.12.2025).',
};

interface Stand {
  tag: string; wert: number; typ: string; notiz: string;
}
/* S28 W1 — Owner-Freigabe vom 14.10.2026. Rueckrechnung aus dem gemessenen
   Verbrauch 02.04.-31.12.2025 (273 Tage) auf den 01.01.2025 (91 Tage zurueck). */
const S28_W1: Array<{ nummer: string; einheit: string; stand: Stand }> = [
  {
    nummer: '23000185404', einheit: 'm3',
    stand: {
      tag: '2025-01-01', wert: 57.1, typ: 'annual',
      notiz: 'Rueckrechnung aus Verbrauch 02.04.-31.12.2025, ersetzen, sobald Beleg vorliegt',
    },
  },
  {
    nummer: '2300199115', einheit: 'm3',
    stand: {
      tag: '2025-01-01', wert: 34.8, typ: 'annual',
      notiz: 'Rueckrechnung aus Verbrauch 02.04.-31.12.2025, ersetzen, sobald Beleg vorliegt',
    },
  },
];

const SCHAETZ_METHODE = 'Rueckrechnung aus dem gemessenen Verbrauch 02.04.-31.12.2025';
const SCHAETZ_GRUND =
  'Fuer den 01.01.2025 liegt kein Beleg vor. Die Fotos vom 24.09.2024 zeigen das '
  + 'Zaehlwerk nicht lesbar, das Dokument vom 11.11.2024 ist ein Angebot der Fa. '
  + 'Maurer und keine Ablesung. Owner-Freigabe vom 14.10.2026, ausdruecklich als '
  + 'Schaetzung.';

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
  return treffer[1].trim();
}

async function ruf(pfad: string, methode = 'GET', rumpf?: unknown, idempotenz?: string) {
  const kopf: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env('CORE_SERVICE_TOKEN')}`,
    'X-Actor': 'owner',
  };
  if (idempotenz) kopf['Idempotency-Key'] = idempotenz;
  const res = await fetch(`${BASIS}${pfad}`, {
    method: methode, headers: kopf, ...(rumpf ? { body: JSON.stringify(rumpf) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${methode} ${pfad} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  console.log(ANWENDEN ? '=== ANWENDEN ===' : '=== PROBELAUF (ohne --apply) ===');

  // ── Teil 2: S28 Anfangsstaende W1 ────────────────────────────────────────
  let neueStaende = 0;
  for (const eintrag of S28_W1) {
    const { rows } = await dbQuery<{ id: number }>(
      `SELECT m.id FROM meters m JOIN units u ON u.id = m.unit_id
        WHERE m.meter_number = $1 AND u.property_id = (SELECT id FROM properties WHERE code='s28')`,
      [eintrag.nummer]);
    if (rows.length === 0) { console.log(`  FEHLT: Zaehler ${eintrag.nummer}`); continue; }
    const meterId = rows[0].id;
    const { rows: vorhanden } = await dbQuery<{ n: string }>(
      "SELECT count(*) AS n FROM meter_readings WHERE meter_id = $1 AND read_at::date = $2",
      [meterId, eintrag.stand.tag]);
    if (Number(vorhanden[0].n) > 0) {
      console.log(`  schon da: ${eintrag.nummer} ${eintrag.stand.tag}`); continue;
    }
    console.log(`  NEU: ${eintrag.nummer} ${eintrag.stand.tag} = ${eintrag.stand.wert} ${eintrag.einheit} (geschaetzt)`);
    if (ANWENDEN) {
      await ruf(`/api/assets/meters/${meterId}/readings/bulk`, 'POST', {
        readings: [{
          value: eintrag.stand.wert, unit: eintrag.einheit, reading_type: eintrag.stand.typ,
          read_at: `${eintrag.stand.tag}T00:00:00Z`, source: 'manual',
          reader_name: 'Owner-Freigabe 14.10.2026',
          is_estimated: true, estimate_method: SCHAETZ_METHODE, estimate_reason: SCHAETZ_GRUND,
          notes: eintrag.stand.notiz,
        }],
      }, `s28-w1-anfang-${eintrag.nummer}-20261014`);
      neueStaende++;
    }
  }

  // ── Teil 1: L19 Zaehlernotizen ───────────────────────────────────────────
  let notizen = 0;
  for (const [nummer, text] of Object.entries(NOTIZEN)) {
    const { rows } = await dbQuery<{ id: number; notes: string | null }>(
      `SELECT m.id, m.notes FROM meters m LEFT JOIN units u ON u.id = m.unit_id
        WHERE m.meter_number = $1
          AND (m.property_id = (SELECT id FROM properties WHERE code='l19')
               OR u.property_id = (SELECT id FROM properties WHERE code='l19'))`,
      [nummer]);
    if (rows.length === 0) { console.log(`  FEHLT: Zaehler ${nummer}`); continue; }
    if ((rows[0].notes ?? '').includes('14.10.2026')) {
      console.log(`  Notiz schon da: ${nummer}`); continue;
    }
    console.log(`  NOTIZ: ${nummer} (+${text.length} Zeichen)`);
    if (ANWENDEN) {
      await ruf(`/api/assets/meters/${rows[0].id}`, 'PATCH', { append_notes: text });
      notizen++;
    }
  }

  // ── Teil 1: Umlageregel Niederschlagswasser ──────────────────────────────
  const bestehende: any[] = await ruf('/api/assets/properties/l19/allocation-rules');
  let regeln = 0;
  const schonDa = bestehende.some((r: any) => r.cost_category_code === 'niederschlagswasser');
  if (schonDa) {
    console.log('  Regel niederschlagswasser schon da');
  } else {
    const { rows: cc } = await dbQuery<{ id: number }>(
      "SELECT id FROM cost_categories WHERE code = 'niederschlagswasser'");
    console.log('  REGEL: niederschlagswasser -> sqm, ab 01.01.2025');
    if (ANWENDEN) {
      await ruf('/api/assets/properties/l19/allocation-rules', 'POST', {
        cost_category_id: cc[0].id,
        key_type: 'sqm',
        valid_from: '2025-01-01',
        source: 'Owner-Vorgabe 14.10.2026',
        notes: 'Owner-Vorgabe 14.10.2026: Nur die allgemeine Entwaesserung '
          + '(Niederschlagswasser) wird nach Wohnflaeche verteilt. '
          + 'Die beiden anderen Regeln derselben Vorgabe — Trinkwasser nach '
          + 'gemessenem Verbrauch, Schmutzwasser im Verhaeltnis des Trinkwassers — '
          + 'sind bewusst NICHT angelegt: Fuer die Wohnungen von L19 ist keine '
          + 'Trinkwassermessung belegt. Die vier Geraete, die eddi24 als '
          + 'Kaltwasserzaehler fuehrt, sind Waermezaehler (Nachweis in deren '
          + 'Notizen). Eine Verbrauchsregel wuerde das Wasser nach '
          + 'Waermezaehlerstaenden verteilen.',
      });
      regeln++;
    }
  }

  console.log(`\nErgebnis: ${neueStaende} Staende, ${notizen} Notizen, ${regeln} Umlageregeln`);
  if (!ANWENDEN) console.log('Probelauf — nichts geschrieben.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

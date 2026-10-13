/**
 * scripts/mg24-allgemeinstrom-h1-entscheidung — zwei Owner-Entscheidungen vom
 * 13.10.2026 in den Buchungen festhalten.
 *
 * 1. DER HAUSSTROM DES ERSTEN HALBJAHRS 2025 WIRD NICHT UMGELEGT. Er lief über
 *    einen gemeinsamen Zählpunkt; welcher Anteil auf den Allgemeinstrom entfiel,
 *    ist nicht belegt. Statt weiter zu schätzen, trägt ihn der Eigentümer.
 *
 *    ACHTUNG, das ist mehr als ein Vermerk: Der Betrag war bereits gebucht, und
 *    zwar nach einer Arbeitsannahme geteilt — 419,42 EUR umlagefähig, 30,66 EUR
 *    nicht. Die Entscheidung kippt den umlagefähigen Teil. Die Abrechnung sinkt
 *    dadurch um 419,42 EUR; sie ändert also sehr wohl umlagefähige Kosten.
 *
 * 2. DER HILFSSTROM DER PELLETANLAGE BLEIBT IM ALLGEMEINSTROM. Keine
 *    Herauslösung in die Heizkosten.
 *
 * Aufruf:  bun run scripts/mg24-allgemeinstrom-h1-entscheidung.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';

const ENTSCHEIDUNG_H1 =
  ' OWNER-ENTSCHEIDUNG 13.10.2026: Allgemeinanteil nicht belegt, keine Umlage. Der '
  + 'Hausstrom des Zeitraums 01.01. bis 16.06.2025 lief über einen gemeinsamen Zählpunkt; '
  + 'ein eigener Allgemeinstromzähler besteht erst ab 24.06.2025. Welcher Teil der 900 kWh '
  + 'auf den Allgemeinstrom entfiel, ist nicht zu belegen. Der Eigentümer trägt den '
  + 'gesamten Betrag von 450,08 EUR brutto. Die bisherige Aufteilung nach der '
  + 'Arbeitsannahme 93,19 zu 6,81 Prozent ist damit gegenstandslos; weitere Recherche zur '
  + 'Aufteilung entfällt.';

const ENTSCHEIDUNG_PELLET =
  ' OWNER-ENTSCHEIDUNG 13.10.2026: Heizungshilfsstrom vernachlässigbar, verbleibt im '
  + 'Allgemeinstrom. Der Hilfsstrom der Pelletanlage — Förderschnecke, Regelung, '
  + 'Umwälzpumpen — wird nicht aus dem Allgemeinstrom herausgelöst und nicht in die '
  + 'Heizkosten überführt. Er bleibt Bestandteil dieser Position und wird nach BetrKV '
  + '§ 2 Nr. 11 nach Fläche verteilt.';

/** id, was geändert wird, welcher Text angehängt wird. */
const AENDERUNGEN: {
  id: number; marke: string; anhang: string; umlagefaehig?: boolean; zweck: string;
}[] = [
  {
    id: 22, marke: 'OWNER-ENTSCHEIDUNG 13.10.2026: Allgemeinanteil',
    anhang: ENTSCHEIDUNG_H1, umlagefaehig: false,
    zweck: 'Hausstrom H1 2025, bisher umlagefähig — wird nicht umgelegt',
  },
  {
    id: 23, marke: 'OWNER-ENTSCHEIDUNG 13.10.2026: Allgemeinanteil',
    anhang: ENTSCHEIDUNG_H1,
    zweck: 'Restbetrag H1 2025, war bereits nicht umlagefähig',
  },
  {
    id: 55, marke: 'OWNER-ENTSCHEIDUNG 13.10.2026: Heizungshilfsstrom',
    anhang: ENTSCHEIDUNG_PELLET,
    zweck: 'Allgemeinstrom 24.06.–31.12.2025 — Hilfsstrom bleibt enthalten',
  },
];

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
  return treffer[1].trim();
}

async function ruf(pfad: string, methode = 'GET', rumpf?: unknown) {
  const res = await fetch(`${BASIS}${pfad}`, {
    method: methode,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env('CORE_SERVICE_TOKEN')}`,
      'X-Actor': 'owner',
    },
    ...(rumpf ? { body: JSON.stringify(rumpf) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${methode} ${pfad} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const anwenden = process.argv.includes('--apply');

  for (const a of AENDERUNGEN) {
    const { rows } = await dbQuery<{ notes: string; umlagefaehig: boolean; amount_gross: string }>(
      `SELECT b.notes, b.umlagefaehig, b.amount_gross::text FROM expense_bookings b
         JOIN properties p ON b.property_id = p.id
        WHERE b.id = $1 AND p.code = 'mg24'`, [a.id]);
    if (rows.length === 0) { console.log(`  Buchung ${a.id} nicht gefunden`); continue; }

    const basis = rows[0].notes.split(` ${a.marke}`)[0].trimEnd();
    const neuText = basis + a.anhang;
    const rumpf: Record<string, unknown> = {};
    if (rows[0].notes !== neuText) rumpf.notes = neuText;
    if (a.umlagefaehig !== undefined && rows[0].umlagefaehig !== a.umlagefaehig) {
      rumpf.umlagefaehig = a.umlagefaehig;
    }
    if (Object.keys(rumpf).length === 0) {
      console.log(`  Buchung ${a.id} (${rows[0].amount_gross} EUR) unveraendert`);
      continue;
    }
    console.log(`  Buchung ${a.id} (${rows[0].amount_gross} EUR) — ${a.zweck}`);
    console.log(`     ${Object.keys(rumpf).join(' + ')}`);
    if (!anwenden) continue;
    await ruf(`/api/assets/properties/mg24/expense-bookings/${a.id}`, 'PATCH', rumpf);
  }

  console.log(anwenden ? '\nAngewendet.' : '\nProbelauf — nichts geschrieben.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

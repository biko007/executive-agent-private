#!/usr/bin/env bun
/**
 * Reise-Etappen ↔ M365-Kalender juergen.bickel@ (Vorschlag 4c, Stufe 2,
 * Owner-Freigabe 07.11.2026). Der Reise-Import ruft denselben Abgleich nach
 * jeder übernommenen Version auf; dieses Skript ist für Probe, Nachholen und
 * Rückweg.
 *
 *   bun run scripts/reise-kalender.ts <reise-id> --probe      Plan zeigen, nichts schreiben
 *   bun run scripts/reise-kalender.ts <reise-id>              abgleichen (anlegen/ändern/löschen)
 *   bun run scripts/reise-kalender.ts <reise-id> --entfernen  Rückweg: alle Termine mit Marker löschen
 *   … --entfernen --probe                                     zeigen, was gelöscht würde
 *
 * Angefasst werden nur Termine mit Marker `bikosoc:reise:<reise-id>:…`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  kalenderAbgleich, kalenderEntfernen, graphKalenderApi, graphZugangAusEnv, idsUebernehmen, ortszeitText,
  type SollTermin,
} from '../src/modules/reise-import/index.js';

const HOME = process.env.HOME || homedir();
const TRAVEL_DIR = path.join(HOME, '.openclaw/workspace/artifacts/personal/travel');
const id = process.argv[2];
const probe = process.argv.includes('--probe');
const entfernen = process.argv.includes('--entfernen');
if (!id || id.startsWith('--')) { console.error('Aufruf: reise-kalender.ts <reise-id> [--probe] [--entfernen]'); process.exit(2); }
const datei = path.join(TRAVEL_DIR, `${path.basename(id)}.json`);
if (!fs.existsSync(datei)) { console.error(`Reise ${id} nicht gefunden`); process.exit(2); }
const zugang = graphZugangAusEnv();
if (!zugang) { console.error('M365-Zugang fehlt'); process.exit(2); }
const api = graphKalenderApi(zugang);
const trip = JSON.parse(fs.readFileSync(datei, 'utf-8'));

const zeile = (t: SollTermin) => t.ganztags
  ? `${t.tagVon} ganztägig (${t.zone})${t.hinweis ? ` – ${t.hinweis}` : ''}`
  : `${t.startUtc} → ${t.endeUtc} UTC | Ortszeit ${ortszeitText(t.startUtc!, t.zone)} (${t.zone}) → ${ortszeitText(t.endeUtc!, t.zoneEnde ?? t.zone)}${t.zoneEnde && t.zoneEnde !== t.zone ? ` (${t.zoneEnde})` : ''}`;

if (entfernen) {
  const e = await kalenderEntfernen(trip, api, { schreiben: !probe });
  for (const i of e.geloescht) console.log(`${probe ? '[Probe] würde löschen' : 'gelöscht'}: ${i.etappe} | ${i.betreff ?? ''}`);
  for (const f of e.fehler) console.log(`FEHLER ${f}`);
  if (!probe) fs.writeFileSync(datei, JSON.stringify(idsUebernehmen(trip, {}), null, 2), 'utf-8');
  console.log(`${e.geloescht.length} Termin(e) mit Marker ${probe ? 'gefunden' : 'entfernt'}`);
  process.exit(e.fehler.length ? 1 : 0);
}

const e = await kalenderAbgleich(trip, api, { schreiben: !probe });
const p = probe ? '[Probe] ' : '';
for (const t of e.plan.anlegen) console.log(`${p}anlegen  | ${t.betreff} | ${zeile(t)} | ${t.ort}`);
for (const a of e.plan.aendern) console.log(`${p}ändern   | ${a.soll.betreff} | ${zeile(a.soll)}`);
for (const g of e.plan.gleich) console.log(`${p}gleich   | ${g.soll.betreff}`);
for (const l of e.plan.loeschen) console.log(`${p}löschen  | ${l.etappe} | ${l.betreff ?? ''}`);
for (const f of e.fehler) console.log(`FEHLER ${f}`);
if (!probe) fs.writeFileSync(datei, JSON.stringify(idsUebernehmen(trip, e.ids), null, 2), 'utf-8');
console.log(`${p}anlegen ${e.plan.anlegen.length} · ändern ${e.plan.aendern.length} · gleich ${e.plan.gleich.length} · löschen ${e.plan.loeschen.length}`);
process.exit(e.fehler.length ? 1 : 0);

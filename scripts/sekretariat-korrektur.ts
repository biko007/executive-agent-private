/**
 * Korrekturen des Owners ins Sekretariat übernehmen (Lernschleife, Stufe 1).
 *
 *   bun run scripts/sekretariat-korrektur.ts <korrekturen.json>
 *
 * Die Datei enthält eine Liste von Korrekturen (Format `sekretariat/korrektur.ts`).
 * Jede wird an `artifacts/personal/sekretariat/korrekturen.jsonl` angehängt;
 * Änderungen am Vorgang (Status, Vorschlag, Schritt, Verweis) werden in
 * `vorgaenge.json` angewendet. Vorher wird `vorgaenge.json` gesichert
 * (`vorgaenge.json.vor-korrektur-<zeit>`) — Rückweg: diese Datei zurückkopieren.
 * Element-Kennungen in `nachbewerten` werden auf „erfasst" zurückgesetzt und
 * im nächsten Nachlauf neu bewertet.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { speichereKorrektur, wendeAn, type Korrektur } from '../src/modules/sekretariat/index.js';

const ZUSTAND = path.join(os.homedir(), '.openclaw', 'workspace', 'artifacts', 'personal', 'sekretariat');
const eingabe = process.argv[2];
if (!eingabe) { console.error('Aufruf: sekretariat-korrektur.ts <korrekturen.json>'); process.exit(2); }
const roh = JSON.parse(fs.readFileSync(eingabe, 'utf-8')) as { korrekturen: Korrektur[]; nachbewerten?: string[] };
const zeit = new Date().toISOString();

const pv = path.join(ZUSTAND, 'vorgaenge.json');
const pe = path.join(ZUSTAND, 'elemente.json');
const stempel = zeit.replace(/[-:]/g, '').slice(0, 13);
fs.copyFileSync(pv, `${pv}.vor-korrektur-${stempel}`);
fs.copyFileSync(pe, `${pe}.vor-korrektur-${stempel}`);
const vj = JSON.parse(fs.readFileSync(pv, 'utf-8'));
const fehlend: string[] = [];
for (const k of roh.korrekturen) {
  const mitZeit = { ...k, zeit };
  if (!wendeAn(vj.vorgaenge, mitZeit, zeit)) fehlend.push(k.aenderung!.vorgang);
  speichereKorrektur(ZUSTAND, mitZeit);
}
fs.writeFileSync(pv, JSON.stringify(vj, null, 2));

/* Nachbewerten: Status zurück auf „erfasst"; der Text wird beim nächsten Lauf neu gesammelt. */
const ej = JSON.parse(fs.readFileSync(pe, 'utf-8'));
const zurueck: string[] = [];
for (const kennung of roh.nachbewerten ?? []) {
  if (!ej[kennung]) continue;
  delete ej[kennung];
  zurueck.push(kennung);
}
fs.writeFileSync(pe, JSON.stringify(ej, null, 2));
console.log(JSON.stringify({ korrekturen: roh.korrekturen.length, fehlend, nachbewerten: zurueck, sicherung: stempel }));

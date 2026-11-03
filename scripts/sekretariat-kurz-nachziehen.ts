/**
 * Kurzbezeichnungen für bestehende Vorgänge einmalig nachziehen (Owner-Anweisung 03.11.2026).
 *
 *   bun run scripts/sekretariat-kurz-nachziehen.ts [zuordnung.json] [--probe]
 *
 * Für jeden offenen, wartenden oder freigegebenen Vorgang ohne `kurz`: Wert aus
 * der Zuordnung {Kennung: Kurzbezeichnung}, sonst aus Objekt und Titel gebildet;
 * immer eindeutig. Vorhandene Kurzbezeichnungen bleiben unangetastet
 * (wiederholbar). Erledigte Vorgänge bleiben leer. Vorher wird vorgaenge.json
 * gesichert (`vorgaenge.json.vor-kurz-<zeit>`) — Rückweg: zurückkopieren.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { vergibKurz } from '../src/modules/sekretariat/index.js';

const ZUSTAND = path.join(os.homedir(), '.openclaw', 'workspace', 'artifacts', 'personal', 'sekretariat');
const probe = process.argv.includes('--probe');
const zuordnungDatei = process.argv.slice(2).find((a) => !a.startsWith('--'));
const zuordnung: Record<string, string> = zuordnungDatei ? JSON.parse(fs.readFileSync(zuordnungDatei, 'utf-8')) : {};
const pv = path.join(ZUSTAND, 'vorgaenge.json');
const vj = JSON.parse(fs.readFileSync(pv, 'utf-8'));
const neu: Array<{ kennung: string; kurz: string; quelle: string; titel: string; status: string }> = [];
for (const v of vj.vorgaenge) {
  if (v.kurz || !['offen', 'wartet', 'freigegeben'].includes(v.status)) continue;
  v.kurz = vergibKurz(v, zuordnung[v.kennung] ?? null, vj.vorgaenge);
  neu.push({ kennung: v.kennung, kurz: v.kurz, quelle: zuordnung[v.kennung] ? 'Zuordnung' : 'Titel', titel: v.titel, status: v.status });
}
if (!probe && neu.length) {
  const stempel = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  fs.copyFileSync(pv, `${pv}.vor-kurz-${stempel}`);
  fs.writeFileSync(pv, JSON.stringify(vj, null, 2));
  console.error(`Sicherung vorgaenge.json.vor-kurz-${stempel}`);
}
console.log(JSON.stringify({ probe, gesetzt: neu.length, neu }, null, 1));

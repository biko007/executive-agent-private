/**
 * Freigabezeile des Owners auflösen (Owner-Anweisung 03.11.2026).
 *
 *   bun run scripts/sekretariat-freigabe.ts "Freigabe Vorgang S28-Zaehlerstand-SWT Privat-Abo-DAZN"
 *
 * Nimmt Kurzbezeichnungen (bevorzugt) und v-Kennungen, mehrere durch
 * Leerzeichen, tolerant gegen Groß-/Kleinschreibung und Umlaute. Gibt je
 * Bezeichnung den Vorgang aus oder — bei Unbekanntem — die drei ähnlichsten.
 * NUR LESEN: ändert nichts. Exit 0 = alles aufgelöst, 1 = Unbekanntes dabei.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loeseFreigabe, freigabeRueckmeldung } from '../src/modules/sekretariat/index.js';

const zeile = process.argv.slice(2).join(' ').trim();
if (!zeile) { console.error('Aufruf: sekretariat-freigabe.ts "Freigabe Vorgang <Kurzbezeichnung …>"'); process.exit(2); }
const datei = path.join(os.homedir(), '.openclaw', 'workspace', 'artifacts', 'personal', 'sekretariat', 'vorgaenge.json');
const { vorgaenge } = JSON.parse(fs.readFileSync(datei, 'utf-8'));
const e = loeseFreigabe(zeile, vorgaenge);
for (const z of freigabeRueckmeldung(e)) console.log(z);
if (process.argv.includes('--json')) console.log(JSON.stringify(e));
process.exit(e.unbekannt.length ? 1 : 0);

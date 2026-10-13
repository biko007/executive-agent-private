/**
 * casameta — der Portal-Agent für das Abrechnungsportal von eddi24.
 *
 * AUSGANGSLAGE. Die Abrechnungsarchitektur ist hybrid: bikosoc ist
 * Datendrehscheibe, Kontrollrechnung und Belegarchiv, Casameta
 * (portal.casameta.de) ist die Abrechnungsmaschine und erzeugt das
 * rechtsverbindliche Mieter-PDF. Eine Schnittstelle gibt es nicht; die Eingabe
 * lief bisher von Hand im Browser.
 *
 * WAS DIESES MODUL IST. Nur das Protokoll. Die eigentliche Bedienung des
 * Portals macht ein Agent außerhalb des Gateways:
 *
 *   ~/bin/casameta-run <auftrag.md>
 *     ├── scripts/casameta-login.ts    deterministisch, ohne Sprachmodell
 *     ├── claude -p + @playwright/mcp  der eigentliche Agent
 *     └── scripts/casameta-protokoll.ts  JSONL → hierher → Dropbox → Telegram
 *
 * WARUM DIE TRENNUNG. Der Agent darf im Portal viel — lesen, ausfüllen,
 * speichern. Er darf nichts an der Datenbank. Er hängt je Aktion eine Zeile an
 * eine JSONL-Datei an; erst ein deterministisches Skript überführt das
 * anschließend in `casameta_runs` und `casameta_actions`. Ein abgebrochener
 * Agentenlauf hinterlässt damit eine unvollständige Textdatei, nie eine
 * unvollständige Transaktion.
 *
 * Die Regeln, an die sich der Agent halten muss, stehen in
 * `docs/casameta-agent.md` — versioniert, damit sie überprüfbar sind. Die
 * Feldzuordnung Casameta ↔ bikosoc steht in `docs/casameta-mapping.md`.
 *
 * Die Kontrollrechnung, gegen die jeder Lauf abgeglichen wird, ist das
 * Eingabeblatt aus `src/modules/assets/casameta.ts` — dieselbe Funktion, die
 * auch das Dashboard verwendet.
 */
export {
  laufAnlegen,
  uebernehmeAktionen,
  laufAbschliessen,
  laufLesen,
} from './store.js';

export type {
  LaufModus,
  LaufStatus,
  AktionsTyp,
  LaufAnlegen as LaufAnlegenEingabe,
  Aktion,
  LaufAbschluss,
  LaufUebersicht,
} from './store.js';

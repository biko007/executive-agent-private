/**
 * briefing — Modulschnittstelle (Owner-Auftrag 26.10.2026).
 *
 * Morgenbriefing: Fehlerverhalten, Nachholen, neue Abschnitte (cc-Aufträge,
 * NK-Fristen, Banking, Trading, Reisen). Abendbriefing 21:00 über Telegram und
 * Mail an das eigene Postfach. Ablage beider in der Tabelle `briefings` für
 * das Dashboard-Panel.
 *
 * Der Morgentext selbst entsteht weiterhin in index.ts (generateBriefingText),
 * weil Wetter, Postfach, Kalender und Gesundheit dort verdrahtet sind; die
 * neuen Abschnitte kommen von hier.
 *
 * Nur die hier exportierten Namen dürfen von außerhalb des Moduls verwendet
 * werden (ESLint-Regel no-deep-module-import).
 */
export {
  RUBRIK, tagMonat, tageZwischen, euro, ausfallZeile, alsTelegramHtml, alsMailText,
  ccEinordnung, ccAbschnittMorgen, ccAbschnittAbend,
  nkFristZeile, nkFristZeilen, nkAbschnitt,
  bankingAbschnitt, SALDO_ALT_STUNDEN,
  tradingZeilen, reisenAbschnitt, gewichtAlterZusatz,
  abendZeilen, ABEND_FRISTEN_TAGE,
} from './abschnitte.js';
export type {
  CcReport, NkFrist, KontoStand, TradingStatus, TradingTag, ReiseKurz, AbendDaten,
} from './abschnitte.js';

export { naechsteAktion, minutenVon, NACHHOL_MINUTEN, NACHHOL_FENSTER_MINUTEN, MAX_VERSUCHE } from './planer.js';
export type { Aktion, Tagesstand } from './planer.js';

export {
  holeBriefing, speichereVersuch, markiereGesendet, markiereFehlerGemeldet,
  listeBriefings, istZugestellt,
} from './store.js';
export type { BriefingArt, BriefingStatus, BriefingEintrag } from './store.js';

export {
  ABENDBRIEFING_EMPFAENGER, abendBetreff, abendMailAnfrage, sendeAbendbriefingMail,
} from './mail.js';
export type { GraphPost, AbendMail } from './mail.js';

export {
  leseCcReports, leseNkFristen, leseKonten, leseTradingStatus, leseTradingTagesbuch, leseReisen,
  REPORT_ABLAGEN,
} from './quellen.js';

export { registerBriefingHttpRoutes } from './routes.js';

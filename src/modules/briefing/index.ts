/**
 * briefing — Modulschnittstelle (Owner-Auftrag 26.10.2026).
 *
 * Morgenbriefing: Fehlerverhalten, Nachholen, neue Abschnitte (cc-Aufträge,
 * NK-Fristen, Banking, Trading, Reisen). Abendbriefing 21:00 nur über Telegram
 * (Mailversand am 27.10.2026 entfernt, Owner-Vorgabe). Ablage beider in der Tabelle `briefings` für
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
  RUBRIK, tagMonat, tageZwischen, euro, ausfallZeile, alsTelegramHtml,
  ccEinordnung, ccAbschnittMorgen, ccAbschnittAbend,
  nkFristZeile, nkFristZeilen, nkAbschnitt, fristErledigtZeilen, VERALTET_TAGE,
  bankingAbschnitt, SALDO_ALT_STUNDEN,
  tradingZeilen, reisenAbschnitt, gewichtAlterZusatz,
  abendZeilen, ABEND_FRISTEN_TAGE, ccLoginZeile,
  zuordnungsAbschnitt, ZUORDNUNG_MAX, VORBRIEFING_ALT_MIN,
} from './abschnitte.js';
export type {
  CcReport, NkFrist, FristErledigt, KontoStand, TradingStatus, TradingTag, ReiseKurz, AbendDaten,
  CcLoginStand, VorbriefingStand,
} from './abschnitte.js';

export { naechsteAktion, minutenVon, NACHHOL_MINUTEN, NACHHOL_FENSTER_MINUTEN, MAX_VERSUCHE } from './planer.js';
export type { Aktion, Tagesstand } from './planer.js';

export {
  holeBriefing, speichereVersuch, markiereGesendet, markiereFehlerGemeldet,
  listeBriefings, istZugestellt, speichereZeitzone, leseZeitzonen, mitZeitzone, ZEITZONEN_DATEI,
} from './store.js';
export {
  astroOrtszeit, ortszeitHinweis, zoneAusOpenMeteo, zonenOffsetMin, ortsDatum, ortsMitternacht, BERLIN,
} from './ortszeit.js';
export type { OrtsZeitzone, AstroDaten } from './ortszeit.js';
export type { BriefingArt, BriefingStatus, BriefingEintrag } from './store.js';

export {
  leseCcReports, leseNkFristen, leseKonten, leseTradingStatus, leseTradingTagesbuch, leseReisen,
  REPORT_ABLAGEN,
  ERLEDIGT_DATEI, ladeErledigt, vermerkeErledigt, leseOffeneCcReports, pruefeOffeneAktionen,
  yahooPostfachStand, postfaecherVereint, leseVorbriefing, VORBRIEFING_DATEI,
  leseSekretariatFristen, SEKRETARIAT_VORGAENGE, SEKRETARIAT_VORLAUF_TAGE, leseFristenErledigt,
  leseCcLoginStand,
} from './quellen.js';
export type { ErledigtEintrag, PostfachStand, ImapLesend } from './quellen.js';

export {
  AKTION_TAGE, AKTION_ZEILEN_MAX, istSendeAktion, mailZiele, betreffNormal, betreffKern, entwurfStand, berichtTag, offeneAktionen,
} from './aktionen.js';
export type { MailZiel, MailKurz, EntwurfStand, OffeneAktionen } from './aktionen.js';

export { registerBriefingHttpRoutes } from './routes.js';

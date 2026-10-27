/**
 * briefing/abschnitte — Textbausteine für Morgen- und Abendbriefing.
 *
 * Reine Funktionen: Sie bekommen fertige Daten und liefern Zeilen. Abruf und
 * Fehlerbehandlung der Quellen liegen in quellen.ts bzw. im Gateway.
 *
 * Zeilen, die mit RUBRIK beginnen, sind Überschriften. `alsTelegramHtml()`
 * maskiert alles und setzt nur diese Zeilen fett — dieselbe Regel wie im
 * Morgenbriefing seit 14.10.2026, damit ein „<" in einem Termintitel die
 * Nachricht nicht zerreisst.
 *
 * Datenschutz (C5): Konten erscheinen nur als Summe, ohne IBAN; Reports nur
 * mit Titel und Owner-Aktion aus dem Kopfblock.
 */

export const RUBRIK = '\u0001';

/* ── Formatierung ────────────────────────────────────────────────────────── */

/** "2026-10-26" → "26.10." */
export function tagMonat(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.` : String(iso || '?');
}

/** Ganze Kalendertage von `von` bis `bis` (beide YYYY-MM-DD). */
export function tageZwischen(von: string, bis: string): number {
  const a = Date.parse(`${von.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${bis.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function euro(betrag: number, waehrung = 'EUR'): string {
  const zahl = betrag.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const zeichen = waehrung === 'EUR' ? '€' : waehrung === 'USD' ? '$' : waehrung;
  return `${zahl} ${zeichen}`;
}

function mitVorzeichen(betrag: number, waehrung: string): string {
  return (betrag > 0 ? '+' : betrag < 0 ? '−' : '±') + euro(Math.abs(betrag), waehrung);
}

/** Einheitliche Zeile für eine Quelle, die nicht geantwortet hat. Statt
 *  stiller Lücke — sonst sieht ein Ausfall aus wie „keine Termine". */
export function ausfallZeile(quelle: string): string {
  return `⚠️ ${quelle} nicht abrufbar`;
}

/** Text für Telegram: alles maskieren, nur die Rubrikzeilen fett. */
export function alsTelegramHtml(zeilen: string[]): string {
  const maske = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return zeilen.join('\n').trim().split('\n')
    .map(z => (z.startsWith(RUBRIK) ? `<b>${maske(z.slice(1))}</b>` : maske(z)))
    .join('\n');
}

/* ── cc-Aufträge aus den Reportköpfen ────────────────────────────────────── */

export interface CcReport {
  datei: string;
  /** 'bikosoc' (~/bikosoc-spec) oder 'hdcc' (~/hdcc-spec) */
  strang: 'bikosoc' | 'hdcc';
  titel: string;
  /** Status, wie er im Kopf steht — die beiden Stränge benutzen verschiedene Wörter */
  statusRoh: string;
  aktion: string;
  /** Änderungszeit der Datei, ISO */
  zeit: string;
}

/**
 * Erledigt oder offen? bikosoc schreibt ok/hinweis/aktion/fehler/wartet,
 * HDCC schreibt DONE/PARTIAL/BLOCKED/REVIEW. „uebergeben" und Übernahme-
 * Quittungen sind kein Ergebnis und zählen nicht.
 */
export function ccEinordnung(statusRoh: string): 'erledigt' | 'offen' | 'ignorieren' {
  const s = String(statusRoh || '').trim().toLowerCase();
  if (!s || s.startsWith('uebergeben') || s.startsWith('übergeben')) return 'ignorieren';
  if (/^(aktion|fehler|wartet|blocked|partial|review|failed)/.test(s)) return 'offen';
  if (/wartet/.test(s)) return 'offen';                 // „DONE — wartet auf /arm …"
  if (/^(ok|hinweis|done)/.test(s)) return 'erledigt';
  return 'ignorieren';
}

const CC_SYMBOL: Record<string, string> = {
  aktion: '👉', fehler: '❌', wartet: '⏸', blocked: '⏸', partial: '⚠️', review: '👉', failed: '❌',
};

function ccSymbol(statusRoh: string): string {
  const s = String(statusRoh || '').trim().toLowerCase();
  const schluessel = Object.keys(CC_SYMBOL).find(k => s.startsWith(k));
  return schluessel ? CC_SYMBOL[schluessel] : '⏸';
}

function ccAktionText(aktion: string): string {
  const a = String(aktion || '').trim();
  return !a || /^keine\.?$/i.test(a) ? '' : ` — Ihre Aktion: ${a}`;
}

/** Morgen: nur die offenen Aufträge der letzten 24 h. Nichts offen → kein Abschnitt. */
export function ccAbschnittMorgen(reports: CcReport[]): string[] {
  const offen = reports.filter(r => ccEinordnung(r.statusRoh) === 'offen');
  if (offen.length === 0) return [];
  const zeilen = ['', `${RUBRIK}📋 Offene cc-Aufträge (24 h)`];
  for (const r of offen) {
    const strang = r.strang === 'hdcc' ? ' [HDCC]' : '';
    zeilen.push(`• ${ccSymbol(r.statusRoh)} ${r.titel || r.datei}${strang}${ccAktionText(r.aktion)}`);
  }
  return zeilen;
}

/** Abend: Tagesrückblick — erledigt als Anzahl, offen mit Titel und Aktion. */
export function ccAbschnittAbend(reports: CcReport[]): string[] {
  const erledigt = reports.filter(r => ccEinordnung(r.statusRoh) === 'erledigt');
  const offen = reports.filter(r => ccEinordnung(r.statusRoh) === 'offen');
  const zeilen = ['', `${RUBRIK}📋 cc-Aufträge heute`];
  zeilen.push(`• Erledigt: ${erledigt.length}`);
  if (offen.length === 0) {
    zeilen.push('• Offen: keine');
  } else {
    zeilen.push(`• Offen: ${offen.length}`);
    for (const r of offen) {
      const strang = r.strang === 'hdcc' ? ' [HDCC]' : '';
      zeilen.push(`  ${ccSymbol(r.statusRoh)} ${r.titel || r.datei}${strang}${ccAktionText(r.aktion)}`);
    }
  }
  return zeilen;
}

/* ── NK- und Objektfristen ───────────────────────────────────────────────── */

export interface NkFrist {
  /** Objektkürzel, z. B. MG24 */
  objekt: string;
  bezeichnung: string;
  /** YYYY-MM-DD */
  termin: string;
  /** Tage bis zum Termin, negativ = überfällig */
  tage: number;
  /** Vorlauf der Objektfrist heute erreicht (kann jenseits der Grenze liegen) */
  vorlaufHeute?: boolean;
}

export function nkFristZeile(f: NkFrist): string {
  if (f.tage < 0) {
    const t = Math.abs(f.tage);
    return `• ${f.objekt} — ${f.bezeichnung}: überfällig seit ${t} Tag${t === 1 ? '' : 'en'} (${tagMonat(f.termin)}) 🔴`;
  }
  if (f.tage === 0) return `• ${f.objekt} — ${f.bezeichnung}: heute fällig ⚠️`;
  return `• ${f.objekt} — ${f.bezeichnung}: in ${f.tage} Tag${f.tage === 1 ? '' : 'en'} (${tagMonat(f.termin)})`;
}

/**
 * Fristen bis `grenzeTage`, nach Objekt und Termin sortiert. Eine Objektfrist,
 * deren Vorlauf heute erreicht ist, steht auch jenseits der Grenze da — die
 * getrennte NK-Meldung, die das bisher tat, entfällt (Owner-Auftrag 26.10.2026).
 */
export function nkFristZeilen(fristen: NkFrist[], grenzeTage: number): string[] {
  return fristen
    .filter(f => f.tage <= grenzeTage || f.vorlaufHeute)
    .sort((a, b) => a.objekt.localeCompare(b.objekt) || a.termin.localeCompare(b.termin))
    .map(nkFristZeile);
}

export function nkAbschnitt(fristen: NkFrist[], grenzeTage: number, titel: string): string[] {
  const zeilen = nkFristZeilen(fristen, grenzeTage);
  return zeilen.length ? ['', `${RUBRIK}${titel}`, ...zeilen] : [];
}

/* ── Banking ─────────────────────────────────────────────────────────────── */

export interface KontoStand {
  status: string;
  accountType: string | null;
  currency: string;
  currentBalance: number | null;
  lastSyncAt: string | null;
}

/** Salden ab diesem Alter gelten als veraltet. */
export const SALDO_ALT_STUNDEN = 48;

/**
 * Kontensumme wie im Dashboard: aktive Konten, ohne Darlehen, je Währung.
 * Dazu eine Warnung, wenn Salden älter als 2 Tage sind.
 */
export function bankingAbschnitt(konten: KontoStand[], jetzt: Date): string[] {
  const summenKonten = konten.filter(k => k.status === 'active'
    && String(k.accountType || '').toLowerCase() !== 'darlehen');
  if (summenKonten.length === 0) return [];

  const jeWaehrung = new Map<string, number>();
  for (const k of summenKonten) {
    if (k.currentBalance === null || !Number.isFinite(k.currentBalance)) continue;
    const w = k.currency || 'EUR';
    jeWaehrung.set(w, (jeWaehrung.get(w) || 0) + k.currentBalance);
  }

  const zeilen = ['', `${RUBRIK}💶 Banking`];
  for (const [w, summe] of [...jeWaehrung.entries()].sort()) {
    zeilen.push(`• Kontensumme: ${euro(Math.round(summe * 100) / 100, w)} (${summenKonten.length} Konten, ohne Darlehen)`);
  }

  const grenze = jetzt.getTime() - SALDO_ALT_STUNDEN * 3600_000;
  const alt = summenKonten.filter(k => !k.lastSyncAt || Date.parse(k.lastSyncAt) < grenze);
  if (alt.length > 0) {
    const daten = alt.map(k => k.lastSyncAt).filter(Boolean).sort() as string[];
    const aeltester = daten.length ? ` (ältester Stand ${tagMonat(daten[0])})` : '';
    zeilen.push(`⚠️ ${alt.length} ${alt.length === 1 ? 'Konto' : 'Konten'} mit Saldo älter als 2 Tage${aeltester}`);
  }
  return zeilen;
}

/* ── Trading ─────────────────────────────────────────────────────────────── */

export interface TradingStatus {
  connected: boolean;
  paperMode?: boolean;
  netLiquidation?: number;
}

export interface TradingTag {
  date: string;
  report?: { netLiquidation?: number };
}

/**
 * Eine Zeile: Verbindung und Ergebnis des Vortags (Paper-Konto).
 *
 * Das Ergebnis ist die Änderung der Nettoliquidation zwischen den beiden
 * letzten Tagesberichten vor heute. Den Tageswert `dailyPnl` liefert IBKR für
 * das Paper-Konto nicht verlässlich — das Dashboard zeigt ihn deshalb seit
 * 24.10.2026 als „nicht verfügbar", und im Tagesbuch steht an zwei Tagen
 * derselbe Wert.
 */
export function tradingZeilen(status: TradingStatus | null, tage: TradingTag[] | null, heute: string): string[] {
  const zeilen = ['', `${RUBRIK}📈 Trading (Paper)`];
  if (!status) {
    zeilen.push(ausfallZeile('Trading-Agent'));
    return zeilen;
  }
  const verbindung = status.connected ? 'verbunden' : 'NICHT verbunden ⚠️';
  const berichte = (tage || [])
    .filter(t => t.date < heute && Number.isFinite(t.report?.netLiquidation))
    .sort((a, b) => a.date.localeCompare(b.date));
  let ergebnis = 'Vortag: kein Tagesbericht';
  if (berichte.length >= 2) {
    const [vorher, letzter] = berichte.slice(-2);
    const diff = Math.round((letzter.report!.netLiquidation! - vorher.report!.netLiquidation!) * 100) / 100;
    ergebnis = `Vortag (${tagMonat(letzter.date)}): ${mitVorzeichen(diff, 'USD')}`;
  }
  zeilen.push(`• ${verbindung} · ${ergebnis}`);
  return zeilen;
}

/* ── Reisen ──────────────────────────────────────────────────────────────── */

export interface ReiseKurz {
  name: string;
  start_date: string;
  end_date: string;
}

/** Laufende Reisen und solche, die in den nächsten `tage` Tagen beginnen. */
export function reisenAbschnitt(reisen: ReiseKurz[], heute: string, tage = 7): string[] {
  const zeilen: string[] = [];
  for (const r of [...reisen].sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    const bisStart = tageZwischen(heute, r.start_date);
    const bisEnde = tageZwischen(heute, r.end_date || r.start_date);
    if (bisStart <= 0 && bisEnde >= 0) {
      zeilen.push(`• ${r.name}: unterwegs bis ${tagMonat(r.end_date)}`);
    } else if (bisStart > 0 && bisStart <= tage) {
      zeilen.push(`• ${r.name}: ab ${tagMonat(r.start_date)} (in ${bisStart} Tag${bisStart === 1 ? '' : 'en'})`);
    }
  }
  return zeilen.length ? ['', `${RUBRIK}✈️ Reisen (7 Tage)`, ...zeilen] : [];
}

/* ── Gesundheit ──────────────────────────────────────────────────────────── */

/** Zusatz zur Gewichtszeile, wenn die Messung älter als 2 Tage ist. */
export function gewichtAlterZusatz(messzeit: string | null | undefined, jetzt: Date): string {
  if (!messzeit) return '';
  const t = Date.parse(messzeit);
  if (!Number.isFinite(t)) return '';
  if (jetzt.getTime() - t <= 2 * 86_400_000) return '';
  return ` — Messung vom ${tagMonat(new Date(t).toISOString())}`;
}

/* ── Abendbriefing ───────────────────────────────────────────────────────── */

export interface AbendDaten {
  /** "Montag, 26. Oktober 2026" */
  datumLang: string;
  ccReports: CcReport[] | null;
  /** Fertig formatierte Terminzeilen für morgen; null = Kalender nicht abrufbar */
  termineMorgen: string[] | null;
  /** Fertig formatierte Fuhrparkzeilen (≤ 14 Tage); null = nicht abrufbar */
  fuhrpark: string[] | null;
  nkFristen: NkFrist[] | null;
}

export const ABEND_FRISTEN_TAGE = 14;

export function abendZeilen(d: AbendDaten): string[] {
  const zeilen = [`${RUBRIK}🌙 Abendbriefing — ${d.datumLang}`];

  if (d.ccReports === null) zeilen.push('', `${RUBRIK}📋 cc-Aufträge heute`, ausfallZeile('Reportablage'));
  else zeilen.push(...ccAbschnittAbend(d.ccReports));

  zeilen.push('', `${RUBRIK}📆 Termine morgen`);
  if (d.termineMorgen === null) zeilen.push(ausfallZeile('Kalender'));
  else if (d.termineMorgen.length === 0) zeilen.push('• keine Termine');
  else zeilen.push(...d.termineMorgen);

  zeilen.push('', `${RUBRIK}⏳ Fristen (14 Tage)`);
  const fristZeilen: string[] = [];
  if (d.fuhrpark === null) fristZeilen.push(ausfallZeile('Fuhrpark'));
  else fristZeilen.push(...d.fuhrpark);
  if (d.nkFristen === null) fristZeilen.push(ausfallZeile('NK-Fristen'));
  else fristZeilen.push(...nkFristZeilen(d.nkFristen, ABEND_FRISTEN_TAGE));
  zeilen.push(...(fristZeilen.length ? fristZeilen : ['• keine']));

  return zeilen;
}

/**
 * briefing/quellen — Daten für die neuen Briefing-Abschnitte holen.
 *
 * Jede Funktion wirft bei einem Ausfall; der Aufrufer macht daraus eine
 * „nicht abrufbar"-Zeile. Nichts hier schreibt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { query as dbQuery } from '../../shared/db/index.js';
import { listAccounts } from '../banking/index.js';
import { listTrips } from '../travel/index.js';
import { kopfblockLesen } from '../report-telegram/index.js';
import { ccEinordnung, VERALTET_TAGE } from './abschnitte.js';
import type { CcLoginStand, CcReport, FristErledigt, KontoStand, NkFrist, ReiseKurz, TradingStatus, TradingTag } from './abschnitte.js';
import { AKTION_TAGE, berichtTag, entwurfStand, istSendeAktion, mailZiele, offeneAktionen } from './aktionen.js';
import type { MailKurz, MailZiel, OffeneAktionen } from './aktionen.js';

const HOME = process.env.HOME || '/home/biko';

/** Die beiden Report-Ablagen. Andere Stränge haben keine Reportköpfe. */
export const REPORT_ABLAGEN: { strang: 'bikosoc' | 'hdcc'; dir: string }[] = [
  { strang: 'bikosoc', dir: path.join(HOME, 'bikosoc-spec') },
  { strang: 'hdcc', dir: path.join(HOME, 'hdcc-spec') },
];

/** Rohstatus aus dem Kopfblock. kopfblockLesen() bildet unbekannte Werte auf
 *  „hinweis" ab — für HDCC (DONE/BLOCKED) braucht es das Original. */
function rohStatus(kopf: string): string {
  const m = /^status:\s*(.+)$/m.exec(kopf);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

/**
 * Ergebnis-Reports, die seit `seit` geschrieben wurden. Übernahme-Quittungen
 * (typ: uebernahme) zählen nicht — sie sagen nur, dass ein Auftrag abgeholt
 * wurde.
 */
export function leseCcReports(seit: Date, ablagen = REPORT_ABLAGEN): CcReport[] {
  const ergebnis: CcReport[] = [];
  for (const { strang, dir } of ablagen) {
    if (!fs.existsSync(dir)) continue;
    for (const datei of fs.readdirSync(dir)) {
      if (!/^report-.*\.md$/.test(datei)) continue;
      const voll = path.join(dir, datei);
      const st = fs.statSync(voll);
      if (!st.isFile() || st.mtime < seit) continue;
      // Nur der Kopf wird gebraucht; Reports können groß sein.
      const fd = fs.openSync(voll, 'r');
      const puffer = Buffer.alloc(4096);
      const n = fs.readSync(fd, puffer, 0, puffer.length, 0);
      fs.closeSync(fd);
      const anfang = puffer.subarray(0, n).toString('utf-8');
      const kopf = kopfblockLesen(anfang);
      if (!kopf || kopf.typ === 'uebernahme') continue;
      const kopfText = anfang.split('\n---')[0];
      ergebnis.push({
        datei, strang,
        titel: kopf.titel,
        statusRoh: rohStatus(kopfText),
        aktion: kopf.aktion,
        zeit: st.mtime.toISOString(),
      });
    }
  }
  return ergebnis.sort((a, b) => a.zeit.localeCompare(b.zeit));
}

/** Merkdatei der erledigten Owner-Aktionen. Punkt vorn: Der Report-Watcher
 *  liest nur report-*.md, der Docs-Spiegel keine Punktdateien. */
export const ERLEDIGT_DATEI = path.join(HOME, 'bikosoc-spec', '.aktionen-erledigt.json');

export interface ErledigtEintrag {
  /** `<strang>:<datei>` */
  schluessel: string;
  zeit: string;
  grund: string;
}

export function ladeErledigt(datei = ERLEDIGT_DATEI): ErledigtEintrag[] {
  try {
    const d = JSON.parse(fs.readFileSync(datei, 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

/** Neue Einträge anhängen; vorhandene Schlüssel bleiben, wie sie sind. Atomar über eine Zwischendatei. */
export function vermerkeErledigt(neu: ErledigtEintrag[], datei = ERLEDIGT_DATEI): void {
  if (neu.length === 0) return;
  const alle = ladeErledigt(datei);
  const da = new Set(alle.map(e => e.schluessel));
  for (const e of neu) if (!da.has(e.schluessel)) { alle.push(e); da.add(e.schluessel); }
  const zwischen = `${datei}.tmp-${process.pid}`;
  fs.writeFileSync(zwischen, JSON.stringify(alle, null, 1));
  fs.renameSync(zwischen, datei);
}

/** Alle Reports mit offenem Status, samt Mailziel bei „Entwurf … senden". */
export function leseOffeneCcReports(ablagen = REPORT_ABLAGEN): (CcReport & { ziel?: MailZiel })[] {
  const ergebnis: (CcReport & { ziel?: MailZiel })[] = [];
  for (const r of leseCcReports(new Date(0), ablagen)) {
    if (ccEinordnung(r.statusRoh) !== 'offen') continue;
    if (!istSendeAktion(r.aktion)) { ergebnis.push(r); continue; }
    const dir = ablagen.find(a => a.strang === r.strang)!.dir;
    const ziel = mailZiele(fs.readFileSync(path.join(dir, r.datei), 'utf-8'));
    ergebnis.push(ziel.an.length ? { ...r, ziel } : r);
  }
  return ergebnis;
}

export interface PostfachStand { gesendet: MailKurz[]; entwuerfe: MailKurz[] }

/** graphRequest wiederholt bis zu viermal mit je 20 s — so lange darf das Briefing nicht warten. */
export const POSTFACH_ZEITLIMIT_MS = 10_000;

/**
 * Offene Aktionen prüfen (Owner-Auftrag 29.10.2026): gesendete Entwürfe
 * herausnehmen und in der Merkdatei vermerken, ältere als 7 Tage zählen.
 * `holePostfach` liest Gesendete Elemente und Entwürfe; schlägt es fehl, bleibt
 * die Liste ohne Postfachprüfung und `postfachAusfall` ist gesetzt.
 */
export async function pruefeOffeneAktionen(opts: {
  heute: string;
  /** erster Berichtstag, der einzeln erscheint (Abend: heute, Morgen: gestern) */
  abTag: string;
  holePostfach: (seitIso: string) => Promise<PostfachStand>;
  ablagen?: typeof REPORT_ABLAGEN;
  erledigtDatei?: string;
  jetzt?: Date;
  /** Höchstdauer der Postfachabfrage; das ganze Briefing hat nur 45 s. */
  zeitlimitMs?: number;
}): Promise<{ offen: OffeneAktionen; postfachAusfall: boolean; neuErledigt: ErledigtEintrag[] }> {
  const datei = opts.erledigtDatei ?? ERLEDIGT_DATEI;
  const reports = leseOffeneCcReports(opts.ablagen);
  const erledigt = new Set(ladeErledigt(datei).map(e => e.schluessel));
  const grenze = new Date(Date.parse(`${opts.heute}T00:00:00Z`) - AKTION_TAGE * 86_400_000).toISOString().slice(0, 10);
  const zuPruefen = reports.filter(r => r.ziel && !erledigt.has(`${r.strang}:${r.datei}`)
    && berichtTag(r.datei, r.zeit) >= grenze);
  const hinweise = new Map<string, string>();
  const neuErledigt: ErledigtEintrag[] = [];
  let postfachAusfall = false;
  if (zuPruefen.length) {
    let pf: PostfachStand | null = null;
    let uhr: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, nein) => {
      uhr = setTimeout(() => nein(new Error('Postfach-Zeitlimit')), opts.zeitlimitMs ?? POSTFACH_ZEITLIMIT_MS);
    });
    try { pf = await Promise.race([opts.holePostfach(`${grenze}T00:00:00Z`), limit]); } catch { postfachAusfall = true; } finally { clearTimeout(uhr); }
    if (pf) {
      for (const r of zuPruefen) {
        const schluessel = `${r.strang}:${r.datei}`;
        // Gesendet zählt ab eine Stunde vor dem Report: Der Entwurf entsteht kurz
        // vor dem Report, eine frühere Mail im selben Strang ist nicht dieser Entwurf.
        const seit = new Date(Date.parse(r.zeit) - 3600_000).toISOString();
        const st = entwurfStand(r.ziel!, pf.gesendet, pf.entwuerfe, seit);
        if (st.stand === 'gesendet') {
          neuErledigt.push({ schluessel, zeit: (opts.jetzt ?? new Date()).toISOString(), grund: `gesendet ${st.zeit} an ${st.an}` });
          erledigt.add(schluessel);
        } else if (st.stand === 'fehlt') {
          hinweise.set(schluessel, 'Entwurf nicht mehr in Entwürfe, keine gesendete Mail gefunden');
        }
      }
    }
  }
  vermerkeErledigt(neuErledigt, datei);
  return { offen: offeneAktionen(reports, opts.heute, opts.abTag, erledigt, hinweise), postfachAusfall, neuErledigt };
}

/** Sekretariat-Zustand (Stufe 1, Dateien statt Tabelle). */
export const SEKRETARIAT_VORGAENGE = path.join(HOME, '.openclaw/workspace/artifacts/personal/sekretariat/vorgaenge.json');
/** Vorlauf, wenn eine Frist keinen eigenen nennt. */
export const SEKRETARIAT_VORLAUF_TAGE = 14;

/**
 * Fristen, die an offenen Sekretariat-Vorgängen hängen (`fristen: [{termin,
 * was, vorlaufTage}]`, Owner-Auftrag 29.10.2026 — für Fristen ohne Objekt, die
 * `objekt_fristen` nicht aufnehmen kann). Ab dem Vorlauf bis zur Erledigung
 * des Vorgangs, auch überfällig.
 */
export function leseSekretariatFristen(heute: string, datei = SEKRETARIAT_VORGAENGE): NkFrist[] {
  if (!fs.existsSync(datei)) return [];
  const d = JSON.parse(fs.readFileSync(datei, 'utf-8'));
  const liste: NkFrist[] = [];
  for (const v of Array.isArray(d?.vorgaenge) ? d.vorgaenge : []) {
    if (v?.status === 'erledigt' || !Array.isArray(v?.fristen)) continue;
    for (const f of v.fristen) {
      // Einzeln erledigt (Fristen-Abgleich 30.10.2026) — nie mehr überfällig zeigen
      if (f?.erledigt || !/^\d{4}-\d{2}-\d{2}$/.test(String(f?.termin))) continue;
      const tage = Math.round((Date.parse(`${f.termin}T00:00:00Z`) - Date.parse(`${heute}T00:00:00Z`)) / 86_400_000);
      const roh = f.vorlaufTage;
      const vorlauf = roh !== null && roh !== '' && Number.isFinite(Number(roh)) ? Number(roh) : SEKRETARIAT_VORLAUF_TAGE;
      if (tage > vorlauf) continue;
      const unberuehrt = String(v.aktualisiert || '').slice(0, 10) <= f.termin;
      liste.push({ objekt: String(v.objekt || 'Sekretariat'), bezeichnung: String(f.was || v.titel), termin: f.termin, tage,
        ...(tage < -VERALTET_TAGE && unberuehrt ? { veraltet: true } : {}) });
    }
  }
  return liste;
}

/**
 * Offene Fristen aus beiden Quellen des NK-Tageslaufs: Abrechnungspflichten je
 * Mieter (nk_period_obligations) und Objektfristen (objekt_fristen).
 * Gelesen wird bis `grenzeTage`; Objektfristen mit heute erreichtem Vorlauf
 * kommen zusätzlich mit.
 */
export async function leseNkFristen(grenzeTage: number): Promise<NkFrist[]> {
  const { rows: pflichten } = await dbQuery<any>(
    `SELECT upper(p.code) AS objekt, o.year,
            to_char(o.service_deadline_at, 'YYYY-MM-DD') AS termin,
            (o.service_deadline_at - CURRENT_DATE)::int AS tage
       FROM nk_period_obligations o
       JOIN properties p ON p.id = o.property_id
      WHERE o.service_deadline_at IS NOT NULL
        AND o.status <> 'served'
        AND (o.service_deadline_at - CURRENT_DATE) <= $1`, [grenzeTage]);
  const { rows: fristen } = await dbQuery<any>(
    `SELECT upper(p.code) AS objekt, f.bezeichnung,
            to_char(f.termin, 'YYYY-MM-DD') AS termin,
            (f.termin - CURRENT_DATE)::int AS tage, f.vorlauf_tage,
            (f.updated_at::date <= f.termin) AS unberuehrt
       FROM objekt_fristen f
       JOIN properties p ON p.id = f.property_id
      WHERE f.erledigt_am IS NULL
        AND ((f.termin - CURRENT_DATE) <= $1
             OR (f.vorlauf_tage > 0 AND (f.termin - CURRENT_DATE) = f.vorlauf_tage))`, [grenzeTage]);
  return [
    ...pflichten.map((r: any) => ({
      objekt: r.objekt, bezeichnung: `NK-Abrechnung ${r.year} zustellen (§ 556 BGB)`,
      termin: r.termin, tage: Number(r.tage),
    })),
    ...fristen.map((r: any) => ({
      objekt: r.objekt, bezeichnung: r.bezeichnung, termin: r.termin, tage: Number(r.tage),
      vorlaufHeute: Number(r.vorlauf_tage) > 0 && Number(r.tage) === Number(r.vorlauf_tage),
      veraltet: Number(r.tage) < -VERALTET_TAGE && r.unberuehrt === true,
    })),
  ];
}

/** Heute (ab `seitIso`) vom Fristen-Abgleich erledigte Fristen, aus dem Audit. */
export async function leseFristenErledigt(seitIso: string): Promise<FristErledigt[]> {
  const { rows } = await dbQuery<any>(
    `SELECT after_jsonb AS a FROM audit_log
      WHERE action = 'frist.auto-erledigt' AND ts >= $1 ORDER BY ts`, [seitIso]);
  return rows.map((r: any) => ({
    objekt: String(r.a?.objekt || ''), text: String(r.a?.text || ''), erledigtAm: String(r.a?.erledigt_am || ''),
    // Keine Adresse und keine Domain: sie kann einen Mieternamen tragen (C5). Gegenseite aus dem Fristtext.
    an: /^\s*([^:]{2,40}):/.exec(String(r.a?.text || ''))?.[1]?.trim() || 'Gegenseite', vorschlag: r.a?.vorschlag_folgefrist,
  }));
}

export async function leseKonten(): Promise<KontoStand[]> {
  const konten = await listAccounts({ status: 'active' });
  return konten.map(k => ({
    status: k.status, accountType: k.accountType, currency: k.currency,
    currentBalance: k.currentBalance, lastSyncAt: k.lastSyncAt,
  }));
}

const TRADING_URL = 'http://127.0.0.1:18793/status';
/** Tagesbuch des Trading-Agents (gleiche Maschine, nur lesend). */
const TRADING_TAGESBUCH = path.join(HOME, '.openclaw/workspace/artifacts/personal/trading/report-ledger.json');

export async function leseTradingStatus(): Promise<TradingStatus> {
  const res = await fetch(TRADING_URL, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Trading-Agent HTTP ${res.status}`);
  const d: any = await res.json();
  return { connected: !!d.connected, paperMode: d.paperMode, netLiquidation: d.netLiquidation };
}

export function leseTradingTagesbuch(): TradingTag[] {
  const d = JSON.parse(fs.readFileSync(TRADING_TAGESBUCH, 'utf-8'));
  return Array.isArray(d) ? d : [];
}

export function leseReisen(): ReiseKurz[] {
  return listTrips().map(t => ({ name: t.name, start_date: t.start_date, end_date: t.end_date }));
}


/**
 * Stand der Anmeldung von Claude Code (02.11.2026). Liest NUR Existenz und
 * Rechte von ~/.claude-oauth-token und die Ablaufdatei daneben — nie den
 * Token-Inhalt.
 */
export function leseCcLoginStand(home = process.env.HOME || '/home/biko'): CcLoginStand {
  const tokenDatei = path.join(home, '.claude-oauth-token');
  let rechte: string | null = null;
  let tokenDa = false;
  try {
    rechte = (fs.statSync(tokenDatei).mode & 0o777).toString(8);
    tokenDa = true;
  } catch { /* fehlt */ }
  let ablauf: string | null = null;
  try {
    ablauf = fs.readFileSync(path.join(home, '.claude-oauth-token.expires'), 'utf-8').trim().split('\n')[0] || null;
  } catch { /* fehlt */ }
  return { tokenDa, rechte, ablauf };
}

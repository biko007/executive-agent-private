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
import type { CcReport, KontoStand, NkFrist, ReiseKurz, TradingStatus, TradingTag } from './abschnitte.js';

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
            (f.termin - CURRENT_DATE)::int AS tage, f.vorlauf_tage
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
    })),
  ];
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

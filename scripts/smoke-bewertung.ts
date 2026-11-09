/**
 * scripts/smoke-bewertung — Welche rote Smoke-Prüfung blockiert welchen Deploy?
 *
 * ANLASS (02.11.2026, report-reisen-tab-neu-20261102): `~/.codex/auth.json`
 * fehlte. Prüfung „Codex-Anmeldung" war rot, der Smoke-Test stand auf 36/37,
 * und deploy.sh brach die Auslieferung des **Dashboards** ab — eines Dienstes,
 * der Codex gar nicht benutzt. Der Rückfall scheiterte an derselben Prüfung,
 * Telegram meldete „ROLLBACK FAILED — ALARM", obwohl das Dashboard gesund war.
 *
 * Regel jetzt:
 *   - Prüfungen, die nur einen Dienst betreffen, blockieren nur dessen Deploy.
 *     Für alle anderen Dienste sind sie eine WARNUNG: sichtbar im Smoke-Bericht
 *     und in der Deploy-Meldung, aber kein Abbruch und kein Rückfall.
 *   - Reine Frühwarnungen (cc-Login) blockieren nie.
 *   - Ohne Dienstangabe (Smoke-Test von Hand, Nachtlauf) bleibt alles wie
 *     bisher: Jede rote dienstgebundene Prüfung ist ein Fehler.
 *
 * Reine Funktionen — die Tests stehen in __tests__/smoke-bewertung.test.ts.
 */

/** Prüfung → Dienste, deren Deploy sie blockiert. */
export const DIENSTGEBUNDEN: Readonly<Record<string, readonly string[]>> = {
  // Codex ist das Modell-Backend des Gateways; Dashboard, Trading und
  // Banking rufen es nicht auf.
  'Codex-Anmeldung': ['openclaw-gateway'],
  // Die Modellroute ist der Agentenpfad des Gateways und scheitert aus
  // demselben Grund, wenn die Codex-Anmeldung fehlt.
  'Agentenpfad (Modellroute)': ['openclaw-gateway'],
};

/** Frühwarnungen: werden angezeigt, blockieren aber nie einen Deploy. */
export const NIE_BLOCKIEREND: ReadonlySet<string> = new Set(['cc-Login']);

export type Einstufung = 'ok' | 'warnung' | 'blockiert';

/**
 * @param name      Name der Prüfung, wie im Smoke-Bericht
 * @param bestanden Ergebnis der Prüfung
 * @param dienste   Dienste des laufenden Deploys; null = kein Deploy-Kontext
 */
export function einstufung(name: string, bestanden: boolean, dienste: readonly string[] | null): Einstufung {
  if (bestanden) return 'ok';
  if (NIE_BLOCKIEREND.has(name)) return 'warnung';
  const gebunden = DIENSTGEBUNDEN[name];
  if (!gebunden || dienste === null) return 'blockiert';
  return dienste.some((d) => gebunden.includes(d)) ? 'blockiert' : 'warnung';
}

/** `--dienste=openclaw-dashboard,openclaw-trading` → Liste; fehlt der Schalter: null. */
export function diensteAusArgumenten(argv: readonly string[]): string[] | null {
  const arg = argv.find((a) => a.startsWith('--dienste='));
  if (!arg) return null;
  const liste = arg.slice('--dienste='.length).split(',').map((d) => d.trim()).filter(Boolean);
  return liste.length ? liste : null;
}

/** Ergebniszeile: „ALL PASS (36/36 + 1 Warnung)" bzw. „FAIL (35/36 passed, 1 Warnung)". */
export function ergebnisZeile(e: { ok: number; warnungen: number; blockiert: number }): string {
  const gezaehlt = e.ok + e.blockiert;
  const warn = e.warnungen === 1 ? '1 Warnung' : `${e.warnungen} Warnungen`;
  if (e.blockiert === 0) {
    return e.warnungen ? `RESULT: ALL PASS (${gezaehlt}/${gezaehlt} + ${warn})` : `RESULT: ALL PASS (${gezaehlt}/${gezaehlt})`;
  }
  return `RESULT: FAIL (${e.ok}/${gezaehlt} passed${e.warnungen ? `, ${warn}` : ''})`;
}

/** Codex: Schwelle für „bald ablaufend“ (Tage). */
export const CODEX_WARN_TAGE = 3;

/**
 * Stufe der Codex-Anmeldung nach Restlaufzeit (Owner-Freigabe 09.11.2026):
 * abgelaufen → Fehler; gültig, aber unter CODEX_WARN_TAGE → Warnung
 * („codex login einplanen“, blockiert nicht); sonst ok. Fehlende oder
 * unlesbare Anmeldung bleibt im Smoke-Test ein Fehler.
 */
export function codexAblaufStufe(tage: number): 'fehler' | 'warnung' | 'ok' {
  if (!Number.isFinite(tage) || tage < 0) return 'fehler';
  return tage < CODEX_WARN_TAGE ? 'warnung' : 'ok';
}

/**
 * casameta/store — Protokoll der Portalläufe in Postgres.
 *
 * Der Agent selbst schreibt nicht in die Datenbank. Er hängt je Aktion eine
 * Zeile an eine JSONL-Datei an — mehr nicht. Alles Weitere erledigt
 * `scripts/casameta-protokoll.ts` über diese Funktionen, nachdem der Lauf
 * beendet ist.
 *
 * Diese Trennung ist Absicht. Ein Sprachmodell, das mitten im Lauf Transaktionen
 * gegen die Produktivdatenbank fährt, kann sie in einem halbfertigen Zustand
 * hinterlassen. Eine angehängte Textzeile kann das nicht.
 *
 * `uebernehmeAktionen` ist mehrfach aufrufbar: Jede Aktion trägt eine laufende
 * Nummer, und `(run_id, seq)` ist eindeutig. Ein zweiter Protokolllauf über
 * dieselbe Datei fügt deshalb nichts doppelt ein. Das ist wichtig, weil der
 * Protokollschritt nach einem Abbruch wiederholt werden können muss.
 */
import { query as dbQuery, getClient } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';

export type LaufModus = 'lesen' | 'schreiben';
export type LaufStatus = 'laeuft' | 'fertig' | 'fehler' | 'gestoppt';
export type AktionsTyp = 'lesen' | 'schreiben' | 'klicken' | 'navigieren' | 'stopp';

export interface LaufAnlegen {
  runId: string;
  propertyCode?: string | null;
  periodYear?: number | null;
  mode: LaufModus;
  taskFile?: string | null;
  artifactPath?: string | null;
}

export interface Aktion {
  seq: number;
  occurredAt: string;
  actionType: AktionsTyp;
  pageUrl?: string | null;
  pageTitle?: string | null;
  element?: string | null;
  fieldLabel?: string | null;
  valueBefore?: string | null;
  valueAfter?: string | null;
  verified?: boolean | null;
  screenshotBefore?: string | null;
  screenshotAfter?: string | null;
  note?: string | null;
}

export interface LaufAbschluss {
  status: LaufStatus;
  stopReason?: string | null;
  summary?: string | null;
  dropboxPath?: string | null;
}

/** Legt den Lauf an. Ist er schon da, bleibt er unverändert — der
 *  Protokollschritt darf wiederholt werden. */
export async function laufAnlegen(l: LaufAnlegen): Promise<void> {
  await dbQuery(
    `INSERT INTO casameta_runs
       (run_id, property_code, period_year, mode, task_file, artifact_path)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id) DO NOTHING`,
    [l.runId, l.propertyCode ?? null, l.periodYear ?? null, l.mode,
     l.taskFile ?? null, l.artifactPath ?? null],
  );
  await audit.log({
    module: 'casameta', action: 'run.start', entityType: 'casameta_run',
    entityId: l.runId, after: { mode: l.mode, property: l.propertyCode ?? null },
  });
}

/**
 * Übernimmt die Aktionen eines Laufs. Gibt zurück, wie viele neu waren.
 *
 * Alles in EINER Transaktion: Entweder das Protokoll des Laufs steht
 * vollständig, oder gar nicht. Ein halb eingelesenes Protokoll wäre schlimmer
 * als keines, weil es vollständig aussieht.
 */
export async function uebernehmeAktionen(
  runId: string, aktionen: Aktion[],
): Promise<number> {
  if (aktionen.length === 0) return 0;
  const client = await getClient();
  let neu = 0;
  try {
    await client.query('BEGIN');
    for (const a of aktionen) {
      const { rowCount } = await client.query(
        `INSERT INTO casameta_actions
           (run_id, seq, occurred_at, action_type, page_url, page_title, element,
            field_label, value_before, value_after, verified,
            screenshot_before, screenshot_after, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (run_id, seq) DO NOTHING`,
        [runId, a.seq, a.occurredAt, a.actionType, a.pageUrl ?? null,
         a.pageTitle ?? null, a.element ?? null, a.fieldLabel ?? null,
         a.valueBefore ?? null, a.valueAfter ?? null, a.verified ?? null,
         a.screenshotBefore ?? null, a.screenshotAfter ?? null, a.note ?? null],
      );
      neu += rowCount ?? 0;
    }
    /* Die Zähler werden aus den Aktionen abgeleitet, nicht mitgezählt. So
       stimmen sie auch dann, wenn der Protokollschritt wiederholt wurde. */
    await client.query(
      `UPDATE casameta_runs SET
         actions_read = (SELECT count(*) FROM casameta_actions
                          WHERE run_id = $1 AND action_type = 'lesen'),
         actions_written = (SELECT count(*) FROM casameta_actions
                             WHERE run_id = $1 AND action_type = 'schreiben')
       WHERE run_id = $1`,
      [runId],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return neu;
}

export async function laufAbschliessen(
  runId: string, a: LaufAbschluss,
): Promise<void> {
  await dbQuery(
    `UPDATE casameta_runs
        SET status = $2, stop_reason = $3, summary = $4, dropbox_path = $5,
            finished_at = NOW()
      WHERE run_id = $1`,
    [runId, a.status, a.stopReason ?? null, a.summary ?? null, a.dropboxPath ?? null],
  );
  await audit.log({
    module: 'casameta', action: 'run.finish', entityType: 'casameta_run',
    entityId: runId, after: { status: a.status, stopReason: a.stopReason ?? null },
  });
}

export interface LaufUebersicht {
  runId: string; propertyCode: string | null; periodYear: number | null;
  mode: LaufModus; status: LaufStatus; actionsRead: number; actionsWritten: number;
  startedAt: string; finishedAt: string | null; stopReason: string | null;
}

export async function laufLesen(runId: string): Promise<LaufUebersicht | null> {
  const { rows } = await dbQuery<any>(
    `SELECT run_id, property_code, period_year, mode, status,
            actions_read, actions_written, started_at, finished_at, stop_reason
       FROM casameta_runs WHERE run_id = $1`, [runId]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    runId: r.run_id, propertyCode: r.property_code, periodYear: r.period_year,
    mode: r.mode, status: r.status, actionsRead: r.actions_read,
    actionsWritten: r.actions_written, startedAt: r.started_at,
    finishedAt: r.finished_at, stopReason: r.stop_reason,
  };
}

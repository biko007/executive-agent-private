-- 044 — Protokolltabellen des Casameta-Portal-Agenten
--
-- WOZU. Der Agent bedient das Abrechnungsportal von eddi24 selbstständig:
-- lesen, ausfuellen, speichern, pruefen. Einzelfreigaben je Schreibvorgang gibt
-- es bewusst nicht — an ihre Stelle tritt ein luckenloses Protokoll. Diese
-- beiden Tabellen sind dieses Protokoll.
--
-- WARUM ZWEI TABELLEN. `casameta_runs` ist der Lauf: wann, welcher Auftrag,
-- welches Objekt, wie ausgegangen. `casameta_actions` ist jede einzelne
-- Beruehrung der Oberflaeche. Die Trennung erlaubt die Frage "was hat der Agent
-- am 13.10. in MG24 geaendert" ebenso wie "wer hat dieses Feld je angefasst".
--
-- WARUM WERT VORHER UND NACHHER. Eine Aenderung ist erst nachvollziehbar, wenn
-- der Ausgangswert mit protokolliert ist. Der Agent liest deshalb vor jedem
-- Schreiben und nach jedem Schreiben; beide Werte stehen hier.
--
-- NAMENSSCHEMA. Die Datei heisst `044_` und nicht `V044__`. `runMigrations`
-- erkennt nur das Muster `NNN_` — Dateien mit `VNNN__` werden stillschweigend
-- uebersprungen. Genau daran haengen die Fleet-Migrationen V026 und V037, die
-- deshalb seinerzeit von Hand eingespielt werden mussten.

CREATE TABLE IF NOT EXISTS casameta_runs (
  id                BIGSERIAL PRIMARY KEY,
  -- Sprechende Lauf-ID nach Manifest 12, Format YYMMDD-<zweck>-<objekt>.
  run_id            TEXT        NOT NULL UNIQUE,
  property_code     TEXT,
  period_year       INTEGER,
  -- 'lesen' = Bestandsaufnahme ohne jede Aenderung, 'schreiben' = mit Eingaben.
  mode              TEXT        NOT NULL CHECK (mode IN ('lesen', 'schreiben')),
  task_file         TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  -- 'laeuft' bis zum Abschluss; 'gestoppt' heisst: der Agent ist auf eine
  -- verbotene Handlung gestossen und hat von sich aus abgebrochen.
  status            TEXT        NOT NULL DEFAULT 'laeuft'
                      CHECK (status IN ('laeuft', 'fertig', 'fehler', 'gestoppt')),
  stop_reason       TEXT,
  actions_read      INTEGER     NOT NULL DEFAULT 0,
  actions_written   INTEGER     NOT NULL DEFAULT 0,
  artifact_path     TEXT,
  dropbox_path      TEXT,
  summary           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_casameta_runs_started
  ON casameta_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_casameta_runs_property
  ON casameta_runs (property_code, period_year);

CREATE TABLE IF NOT EXISTS casameta_actions (
  id                BIGSERIAL PRIMARY KEY,
  run_id            TEXT        NOT NULL REFERENCES casameta_runs (run_id) ON DELETE CASCADE,
  -- Laufende Nummer innerhalb des Laufs. Zusammen mit run_id eindeutig, damit
  -- ein zweiter Protokolllauf dieselbe JSONL-Datei nicht doppelt einliest.
  seq               INTEGER     NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  action_type       TEXT        NOT NULL
                      CHECK (action_type IN ('lesen', 'schreiben', 'klicken', 'navigieren', 'stopp')),
  page_url          TEXT,
  page_title        TEXT,
  element           TEXT,
  field_label       TEXT,
  value_before      TEXT,
  value_after       TEXT,
  -- Ergebnis der Nachkontrolle: Wurde der geschriebene Wert beim erneuten
  -- Lesen bestaetigt? NULL bei reinen Lesevorgaengen.
  verified          BOOLEAN,
  screenshot_before TEXT,
  screenshot_after  TEXT,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_casameta_actions_run
  ON casameta_actions (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_casameta_actions_written
  ON casameta_actions (action_type, occurred_at DESC)
  WHERE action_type = 'schreiben';

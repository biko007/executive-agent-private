-- Modul briefing, Version 1 — Morgen- und Abendbriefing persistieren
-- (Owner-Auftrag 26.10.2026, Punkt 5).
--
-- Eine Zeile je Briefing-Art und Berliner Kalendertag. Sie hält drei Dinge:
--   1. den zugestellten Text für das Dashboard-Panel (letzte 7 Tage),
--   2. den Zustellstatus — daraus entscheidet der Taktgeber, ob um 07:15
--      nachgeholt werden muss, auch nach einem Gateway-Neustart,
--   3. ob der NK-Fristenlauf seine eigene Meldung sparen darf (nur wenn das
--      Morgenbriefing des Tages zugestellt ist).
--
-- Datenklassifizierung: intern. Der Text enthält Termine, Mailbetreffs und
-- Gesundheitswerte des Owners; er verlässt den Server nur über Telegram,
-- die Mail an das eigene Postfach und das tokengeschützte Dashboard.
--
-- Reine DDL, idempotent (Boot-Migration über runMigrations()).

CREATE TABLE IF NOT EXISTS briefings (
  id               SERIAL PRIMARY KEY,
  art              TEXT NOT NULL CHECK (art IN ('morgen', 'abend')),
  -- Berliner Kalendertag, für den das Briefing gilt
  datum            DATE NOT NULL,
  -- Telegram-HTML, wie zugestellt (nur <b> als Auszeichnung)
  text_html        TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'erzeugt'
                     CHECK (status IN ('erzeugt', 'gesendet', 'fehler')),
  -- Erzeugungsversuche des Tages (1 = planmäßig, 2 = nachgeholt)
  versuche         INTEGER NOT NULL DEFAULT 0,
  telegram_ok      BOOLEAN NOT NULL DEFAULT FALSE,
  -- NULL = für diese Art gibt es keinen Mailweg (Morgenbriefing)
  mail_ok          BOOLEAN,
  fehler           TEXT,
  -- Die kurze Fehlermeldung an Telegram ging raus — kein zweites Mal
  fehler_gemeldet  BOOLEAN NOT NULL DEFAULT FALSE,
  erzeugt_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gesendet_at      TIMESTAMPTZ,
  UNIQUE (art, datum)
);

CREATE INDEX IF NOT EXISTS briefings_datum_idx ON briefings (datum DESC);

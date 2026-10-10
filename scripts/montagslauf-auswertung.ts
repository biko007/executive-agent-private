#!/usr/bin/env bun
/**
 * Wertet den Montags-Bankabgleich aus und schreibt EINEN Report nach
 * `~/bikosoc-spec/report-montagslauf-<YYYYMMDD>.md`. Der Report-Watcher stellt
 * die Datei danach selbst zu (Telegram dev + Dropbox).
 *
 * Hintergrund: Der echte Montagsabgleich um 13:00 Berliner Zeit ist seit dem
 * 07.10.2026 im Core umgesetzt (`70c4f05`), aber noch nie gelaufen — der
 * Buchungsbestand endete am 29.06.2026. Der 12.10.2026 ist die erste Probe.
 * Diese Auswertung sieht nach, OB und WIE er gelaufen ist.
 *
 * Streng lesend:
 *   - kein FinTS-Aufruf, kein Abgleich, keine TAN
 *   - nur SELECT auf banking_sync_runs / banking_sessions / banking_transactions
 *   - zusaetzlich das journald-Protokoll des Gateways als Textquelle
 *
 * Datenschutz (C5): keine vollstaendigen IBANs, keine Gegenparteien, keine
 * Verwendungszwecke im Report — nur Zaehlungen, Status und Zeitpunkte.
 *
 * Aufruf: systemd-user-Timer `montagslauf-auswertung.timer` (einmalig).
 * Ein manueller Aufruf ist jederzeit moeglich und aendert nichts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { query } from '../src/shared/db/index.js';

/** Tag, fuer den ausgewertet wird — Standard: heute in Europe/Berlin. */
function berlinDatum(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
}

function berlinZeit(wert: unknown): string {
  if (!wert) return '–';
  const d = wert instanceof Date ? wert : new Date(String(wert));
  if (Number.isNaN(d.getTime())) return String(wert);
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(d) + ' (Berlin)';
}

/** Reines Datum (DATE-Spalte) als TT.MM.JJJJ. */
function nurDatum(wert: unknown): string {
  if (!wert) return '–';
  const d = wert instanceof Date ? wert : new Date(String(wert));
  if (Number.isNaN(d.getTime())) return String(wert);
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(d);
}

/** Letzte 4 Stellen einer Kontokennung — nie die volle IBAN (C5). */
function kontoKurz(bezeichnung: string | null): string {
  const s = String(bezeichnung || '').trim();
  return s.length > 4 ? '…' + s.slice(-4) : (s || 'unbenannt');
}

const tag = process.argv[2] || berlinDatum();              // YYYY-MM-DD
const tagKompakt = tag.replace(/-/g, '');
const zielDatei = path.join(homedir(), 'bikosoc-spec', `report-montagslauf-${tagKompakt}.md`);

/** journald des Gateways fuer den Tag — rein lesend, Fehler sind kein Abbruch. */
function journal(): string[] {
  try {
    const out = execFileSync('/usr/bin/journalctl', [
      '--user', '-u', 'openclaw-gateway.service',
      '--since', `${tag} 00:00:00`, '--until', `${tag} 23:59:59`,
      '--no-pager', '-o', 'short-iso',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    /* C5: Der erste Entwurf filterte mit /…|tan|…/ — das traf „S-tan-dort" und
       haette Standortdaten in den Report geschrieben. Deshalb jetzt ein enger
       Suchbegriff MIT Wortgrenzen und zusaetzlich ein harter Ausschluss fuer
       alles, was nach Personen-, Standort- oder Kontodaten aussieht. */
    const relevant = /(banking|fints|montagsabgleich|umsatzabruf|sync[_-]?run|\bSCA\b|\bTAN\b|\bAbgleich\b)/i;
    const verboten = /(standort|location|koordinate|withings|oura|gewicht|iban|DE\d{20})/i;
    return out.split('\n')
      .filter(zeile => relevant.test(zeile) && !verboten.test(zeile))
      .slice(-60);
  } catch {
    return [];
  }
}

const zeilen: string[] = [];
const z = (s = '') => zeilen.push(s);

try {
  const { rows: laeufe } = await query(
    `SELECT id, started_at, finished_at, run_phase, status, sca_required, alert_delivered,
            accounts_synced, transactions_new, trigger_source, error_message
       FROM banking_sync_runs
      WHERE started_at >= $1::date AND started_at < ($1::date + interval '1 day')
      ORDER BY id`,
    [tag],
  );

  const { rows: letzterLauf } = await query(
    `SELECT id, started_at, status, run_phase FROM banking_sync_runs ORDER BY started_at DESC LIMIT 1`,
  );

  const { rows: sitzungen } = await query(
    `SELECT id, created_at, updated_at, last_success_at, session_expires_at,
            pending_challenge_type
       FROM banking_sessions
      WHERE updated_at >= $1::date AND updated_at < ($1::date + interval '1 day')
      ORDER BY id`,
    [tag],
  );

  const { rows: bestand } = await query(
    `SELECT count(*)::int AS anzahl,
            min(booking_date) AS aeltester,
            max(booking_date) AS juengster,
            count(*) FILTER (WHERE imported_at >= $1::date
                               AND imported_at < ($1::date + interval '1 day'))::int AS heute_importiert
       FROM banking_transactions`,
    [tag],
  );

  const { rows: konten } = await query(
    `SELECT a.display_name, count(t.id)::int AS tx
       FROM banking_accounts a
       LEFT JOIN banking_transactions t
              ON t.account_id = a.id
             AND t.imported_at >= $1::date
             AND t.imported_at < ($1::date + interval '1 day')
      GROUP BY a.id, a.display_name
      HAVING count(t.id) > 0
      ORDER BY a.id`,
    [tag],
  );

  const b = bestand[0] || {};
  const gelaufen = laeufe.length > 0;

  z(`# Montagslauf ${tag} — automatische Auswertung`);
  z();
  z(`**Modus:** AUTO, rein lesend · **Erstellt:** ${berlinZeit(new Date())}`);
  z('**Datenklassifizierung:** internal — keine IBANs, keine Gegenparteien, keine Verwendungszwecke');
  z();
  z('**Rote Zone berührt: nein**');
  z('**Rückweg:** entfällt (keine Änderung; der Timer deaktiviert sich nach diesem Lauf selbst)');
  z();
  z('---');
  z();
  z('## Zusammenfassung');
  z();
  if (!gelaufen) {
    z(`Am ${tag} ist **kein** Bankabgleich protokolliert. In \`banking_sync_runs\` steht für `
      + `diesen Tag keine Zeile. Letzter bekannter Lauf: `
      + (letzterLauf[0]
        ? `#${letzterLauf[0].id} am ${berlinZeit(letzterLauf[0].started_at)}, Status \`${letzterLauf[0].status}\`.`
        : 'keiner.'));
    z();
    z('Das heißt NICHT automatisch, dass der Zeitplan defekt ist — es heißt, dass bis zu '
      + 'diesem Zeitpunkt nichts eingetragen wurde. Die Journalzeilen unten zeigen, ob der '
      + 'Dienst es überhaupt versucht hat.');
  } else {
    const neu = laeufe.reduce((s: number, r: any) => s + (r.transactions_new || 0), 0);
    const sca = laeufe.some((r: any) => r.sca_required);
    z(`Am ${tag} ${laeufe.length === 1 ? 'ist **ein** Lauf' : `sind **${laeufe.length}** Läufe`} `
      + `protokolliert. Neue Umsätze insgesamt: **${neu}**. `
      + `SCA/TAN angefordert: **${sca ? 'ja' : 'nein'}**.`);
    z();
    z(`Buchungsbestand jetzt: **${b.anzahl}** Umsätze, jüngster **${nurDatum(b.juengster)}**; `
      + `davon heute importiert: **${b.heute_importiert}**.`);
  }
  z();
  z('---');
  z();

  z('## Läufe');
  z();
  if (!gelaufen) {
    z('_Keine Zeile für diesen Tag._');
  } else {
    z('| id | Start | Ende | Phase | Auslöser | Status | SCA | Alarm zugestellt | Konten | neue Umsätze | Fehler |');
    z('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of laeufe as any[]) {
      z(`| ${r.id} | ${berlinZeit(r.started_at)} | ${berlinZeit(r.finished_at)} | ${r.run_phase || '–'} `
        + `| ${r.trigger_source || '–'} | \`${r.status}\` | ${r.sca_required ? 'ja' : 'nein'} `
        + `| ${r.alert_delivered ? 'ja' : 'nein'} `
        + `| ${r.accounts_synced ?? '–'} | ${r.transactions_new ?? '–'} `
        + `| ${r.error_message ? String(r.error_message).slice(0, 120) : '–'} |`);
    }
  }
  z();

  z('## Sitzungen');
  z();
  if (sitzungen.length === 0) {
    z('_Keine Sitzung an diesem Tag berührt._');
  } else {
    z('| id | angelegt | zuletzt geändert | letzter Erfolg | gültig bis | offene Abfrage |');
    z('|---|---|---|---|---|---|');
    for (const s of sitzungen as any[]) {
      z(`| ${s.id} | ${berlinZeit(s.created_at)} | ${berlinZeit(s.updated_at)} `
        + `| ${berlinZeit(s.last_success_at)} | ${berlinZeit(s.session_expires_at)} `
        + `| ${s.pending_challenge_type || '–'} |`);
    }
  }
  z();

  z('## Buchungsbestand');
  z();
  z('| Kennzahl | Wert |');
  z('|---|---|');
  z(`| Umsätze gesamt | ${b.anzahl} |`);
  z(`| ältester | ${nurDatum(b.aeltester)} |`);
  z(`| jüngster | ${nurDatum(b.juengster)} |`);
  z(`| an diesem Tag importiert | ${b.heute_importiert} |`);
  z();
  if (konten.length > 0) {
    z('Konten mit Zugang an diesem Tag (nur die letzten vier Stellen):');
    z();
    z('| Konto | neue Umsätze |');
    z('|---|---|');
    for (const k of konten as any[]) z(`| ${kontoKurz(k.display_name)} | ${k.tx} |`);
    z();
  }

  z('## Journal (gefilterte Zeilen des Gateways)');
  z();
  const j = journal();
  if (j.length === 0) {
    z('_Keine passenden Journalzeilen gefunden (oder journalctl nicht lesbar)._');
  } else {
    z('```');
    for (const zeile of j) z(zeile.slice(0, 220));
    z('```');
  }
  z();

  z('## DIGEST');
  z();
  if (!gelaufen) {
    z(`- Montagslauf ${tag}: KEIN Lauf protokolliert.`);
    z(`- Buchungsbestand unverändert: ${b.anzahl} Umsätze, jüngster ${nurDatum(b.juengster)}.`);
    z('- Owner-Aktion: entscheiden, ob der Zeitplan nachgesehen werden soll.');
  } else {
    const neu = laeufe.reduce((s: number, r: any) => s + (r.transactions_new || 0), 0);
    const sca = laeufe.some((r: any) => r.sca_required);
    z(`- Montagslauf ${tag}: ${laeufe.length === 1 ? 'ein Lauf' : laeufe.length + ' Läufe'}, `
      + `${neu === 1 ? 'ein neuer Umsatz' : neu + ' neue Umsätze'}, `
      + `SCA ${sca ? 'angefordert' : 'nicht nötig'}.`);
    z(`- Buchungsbestand: ${b.anzahl} Umsätze, jüngster ${nurDatum(b.juengster)}.`);
    z(`- Owner-Aktion: ${sca ? 'TAN-Freigabe prüfen' : 'keine'}.`);
  }
  z();
  z('**Rote Zone berührt: nein** · **Rückweg: entfällt (keine Änderung)**');
  z(`**Owner-Aktion:** ${gelaufen ? 'Ergebnis zur Kenntnis nehmen.' : 'entscheiden, ob der Zeitplan nachgesehen wird.'}`);
  z();
} catch (e: any) {
  z(`# Montagslauf ${tag} — Auswertung fehlgeschlagen`);
  z();
  z('**Rote Zone berührt: nein** · **Rückweg:** entfällt (keine Änderung)');
  z();
  z('Die Auswertung konnte nicht durchgeführt werden:');
  z();
  z('```');
  z(String(e?.message || e).slice(0, 2000));
  z('```');
  z();
  z('## DIGEST');
  z();
  z(`- Auswertung des Montagslaufs ${tag} fehlgeschlagen: ${String(e?.message || e).slice(0, 160)}`);
  z('- Owner-Aktion: Auswertung von Hand anstoßen.');
  z();
}

mkdirSync(path.dirname(zielDatei), { recursive: true });
writeFileSync(zielDatei, zeilen.join('\n'), 'utf8');
process.stdout.write(`DONE → ${zielDatei}\n`);
process.exit(0);

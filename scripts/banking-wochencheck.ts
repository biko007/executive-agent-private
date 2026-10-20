#!/usr/bin/env bun
/**
 * Banking-Wochencheck — jeden Montag 13:45 Berliner Zeit, nach dem
 * Montagsabgleich um 13:00. Schreibt EINEN Report nach
 * `~/bikosoc-spec/report-banking-wochencheck-<YYYYMMDD>.md`; der Report-Watcher
 * stellt ihn zu.
 *
 * Streng lesend gegenüber Bank und Datenbank:
 *   - kein FinTS-Aufruf, kein Abgleich, keine TAN, keine Mail
 *   - nur SELECT auf banking_* und nk_period_obligations
 *   - einzige Schreibstelle: die eigene Merkdatei
 *     `artifacts/personal/banking-wochencheck/stand.json` (Zeitpunkt des letzten
 *     Checks und die Anfangswerte der Saldenprobe). Ohne sie ließe sich
 *     „seit dem letzten Check" und eine Verschiebung des Saldos nicht erkennen.
 *
 * Datenschutz (C5): keine vollen IBANs, keine Namen von Privatpersonen,
 * keine Gesundheitsdaten — Gegenparteien laufen durch `gegenparteiAnzeige`.
 *
 * Aufruf:
 *   bun scripts/banking-wochencheck.ts                 → Report + Merkdatei
 *   bun scripts/banking-wochencheck.ts --probe <datei> → Probelauf: Report in
 *                                                         <datei>, Merkdatei bleibt
 *   bun scripts/banking-wochencheck.ts --grundstand    → nur Merkdatei anlegen
 *                                                         (vor dem ersten Timerlauf)
 *
 * Saldenprobe: Die Merkdatei hält je Konto den ERSTEN gemessenen Anfangswert
 * (Banksaldo minus Summe aller Umsätze) als Bezug. Eine Abweichung wird so
 * lange gemeldet, bis der Bezug bewusst neu gesetzt wird (Eintrag in
 * stand.json löschen) — sonst verschwände sie nach einer Woche still.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { query } from '../src/shared/db/index.js';
import {
  anfangswert, ausgebliebeneSerien, euro, faelligeAbschlaege, gegenparteiAnzeige,
  kontoKurz, offeneAbschlaege, saldenUrteil, zweckAnzeige, zweckErlaubt, type Umsatz,
} from '../src/modules/banking-wochencheck/logik.js';

const LAUFZEIT = Date.now();
const ARBEITSORDNER = path.join(homedir(), '.openclaw/workspace/artifacts/personal/banking-wochencheck');
const MERKDATEI = path.join(ARBEITSORDNER, 'stand.json');
const REGELWERK = path.join(ARBEITSORDNER, 'regelwerk.py');
const KATEGORISIERER = path.join(path.dirname(new URL(import.meta.url).pathname), 'privatausgaben-kategorisieren.py');

/* --grundstand: nur die Merkdatei anlegen (Zeitpunkt + Anfangswerte), ohne
   Report. Für die Inbetriebnahme, damit der erste echte Montag nicht die
   Importe der Vorwochen als „neu" meldet. */
const nurGrundstand = process.argv.includes('--grundstand');
const probeIndex = process.argv.indexOf('--probe');
const probeZiel = probeIndex > 0 ? process.argv[probeIndex + 1] : null;
if (probeIndex > 0 && (!probeZiel || probeZiel.startsWith('--'))) {
  // Ohne Ziel würde ein Probelauf den echten Report und die Merkdatei schreiben.
  process.stderr.write('--probe braucht einen Dateipfad\n');
  process.exit(2);
}

const heute = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
const zielDatei = probeZiel
  || path.join(homedir(), 'bikosoc-spec', `report-banking-wochencheck-${heute.replace(/-/g, '')}.md`);

/* Konten, deren Abflüsse in die Privatausgaben-Auswertung gehören. Die
   Gesellschaftskonten (Sängerheim, bikolino) und das Stromkonto sind bewusst
   NICHT dabei — das Privat-Regelwerk würde dort Firmenausgaben als privat
   einordnen. Erkennung über die Endziffern, nicht über die interne id. */
const PRIVAT_KONTEN_ENDZIFFERN = ['9268', '4295', '0028'];

/* Mieterstrom-Kunden laut Lieferbestätigungen energiekonzept vom 17.02.2026
   (SharePoint MG24/Energiekonzept). Zahlungen werden über die Kundennummer im
   Verwendungszweck oder über den Nachnamen der Mieter der Einheit erkannt. */
const MIETERSTROM = [
  { objekt: 'MG24', kontoEndziffern: '8621', kunden: [
    { nr: '390-001', einheit: null, bezeichnung: 'Allgemeinstrom (Eigentümer)', abschlag: 135, ab: '2026-03-01' },
    { nr: '390-002', einheit: 'W1', bezeichnung: 'W1', abschlag: 71, ab: '2026-03-01' },
    { nr: '390-003', einheit: 'W2', bezeichnung: 'W2', abschlag: 71, ab: '2026-03-01' },
    { nr: '390-004', einheit: 'W3', bezeichnung: 'W3', abschlag: 71, ab: '2026-03-01' },
  ] },
  /* N24: Abschlagsplan noch nicht erhoben — das Konto …5844 ist nicht
     angebunden. Sobald es Umsätze hat, erscheint hier der Hinweis. */
  { objekt: 'N24', kontoEndziffern: '5844', kunden: [] as any[] },
];

interface Merkstand { letzterCheck?: string; anfangswerte?: Record<string, number> }

/* Fehlt die Merkdatei, ist das der erste Lauf. Ist sie da, aber unlesbar, wäre
   „erste Messung" bei jeder Saldenprobe irreführend — das muss in den Report. */
let merkdateiFehler = '';
function leseMerkstand(): Merkstand {
  if (!existsSync(MERKDATEI)) return {};
  try { return JSON.parse(readFileSync(MERKDATEI, 'utf8')); } catch (e: any) {
    merkdateiFehler = `Merkdatei unlesbar (${String(e?.message || e).slice(0, 80)}) — Saldenprobe ohne Bezug`;
    return {};
  }
}

function datum(d: unknown): string {
  const x = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(x.getTime()) ? String(d ?? '–') : x.toISOString().slice(0, 10);
}

function berlinZeit(d: unknown): string {
  if (!d) return '–';
  const x = d instanceof Date ? d : new Date(String(d));
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(x);
}

const zeilen: string[] = [];
const z = (s = '') => zeilen.push(s);

async function main() {
  const stand = leseMerkstand();
  const seit = stand.letzterCheck || new Date(LAUFZEIT - 7 * 86_400_000).toISOString();

  // ── 1. Abgleich je Institut ────────────────────────────────────────────
  const institute = (await query(
    `SELECT i.id, i.name, i.fints_url, i.sync_paused_status, i.sync_paused_since
       FROM banking_institutions i
      WHERE EXISTS (SELECT 1 FROM banking_accounts a WHERE a.institution_id = i.id AND a.status = 'active')
      ORDER BY i.id`)).rows;
  /* Nur Läufe von HEUTE (Berliner Zeit) zählen — sonst meldete ein
     ausgefallener Montagslauf mit dem Ergebnis der Vorwoche „ok". */
  const laeufe = (await query(
    `SELECT DISTINCT ON (institution_id) institution_id, status, sca_required, accounts_synced,
            transactions_new, started_at, finished_at
       FROM banking_sync_runs
      WHERE started_at >= (date_trunc('day', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin')
      ORDER BY institution_id, (status = 'RUNNING') ASC, started_at DESC`)).rows;
  const verwaist = (await query(
    `SELECT institution_id, count(*)::int AS n FROM banking_sync_runs
      WHERE status = 'RUNNING' AND started_at < now() - interval '1 hour' GROUP BY 1`)).rows;

  type Abgleich = { name: string; urteil: 'ok' | 'fehlgeschlagen' | 'TAN-Pause' | 'läuft noch' | 'kein Lauf' | 'nur PDF'; text: string };
  const abgleich: Abgleich[] = institute.map((i: any) => {
    if (!/^https?:\/\//.test(i.fints_url || '')) return { name: i.name, urteil: 'nur PDF', text: 'kein FinTS-Zugang, Umsätze nur per PDF-Import' };
    if (i.sync_paused_status) return { name: i.name, urteil: 'TAN-Pause', text: `pausiert seit ${berlinZeit(i.sync_paused_since)} (${i.sync_paused_status})` };
    const l = laeufe.find((r: any) => Number(r.institution_id) === Number(i.id));
    if (!l) return { name: i.name, urteil: 'kein Lauf', text: 'heute kein Abgleich protokolliert' };
    if (l.status === 'RUNNING') return { name: i.name, urteil: 'läuft noch', text: `seit ${berlinZeit(l.started_at)} nicht abgeschlossen — wartet vermutlich auf eine TAN` };
    if (l.status === 'TAN_REQUIRED' || l.status === 'AUTO_PAUSED_PENDING_TAN') return { name: i.name, urteil: 'TAN-Pause', text: `${berlinZeit(l.started_at)}: Bank verlangt TAN` };
    if (l.status !== 'SUCCESS_FULL') return { name: i.name, urteil: 'fehlgeschlagen', text: `${berlinZeit(l.started_at)}: ${l.status}` };
    return { name: i.name, urteil: 'ok', text: `${berlinZeit(l.started_at)}: erfolgreich, ${l.transactions_new} neue Umsätze` };
  });

  // ── 2. Konten, neue Umsätze, Saldenprobe ───────────────────────────────
  const konten = (await query(
    `SELECT a.id, a.iban, a.display_name, a.current_balance, a.last_sync_at, i.name AS institut,
            (SELECT count(*)::int FROM banking_transactions t WHERE t.account_id = a.id AND t.duplicate_of IS NULL AND t.imported_at > $1) AS neu,
            (SELECT coalesce(sum(t.amount), 0) FROM banking_transactions t WHERE t.account_id = a.id AND t.duplicate_of IS NULL) AS summe,
            (SELECT min(t.booking_date) FROM banking_transactions t WHERE t.account_id = a.id AND t.duplicate_of IS NULL) AS erster,
            (SELECT max(t.booking_date) FROM banking_transactions t WHERE t.account_id = a.id AND t.duplicate_of IS NULL) AS letzter
       FROM banking_accounts a JOIN banking_institutions i ON i.id = a.institution_id
      WHERE a.status = 'active' ORDER BY a.institution_id, a.id`, [seit])).rows;

  /* Konten mit bekanntem Anfangsstand: das Stromkonto MG24 wurde am 30.05.2025
     eröffnet, die erste Buchung ist ein Entgelt — Anfangsstand 0,00 €. */
  const BEKANNTER_ANFANG: Record<string, number> = { '8621': 0 };
  /* Bezug je Konto: der erste gemessene Anfangswert bleibt stehen; neu
     aufgenommen werden nur Konten, die noch keinen haben. */
  const neueAnfangswerte: Record<string, number> = { ...(stand.anfangswerte || {}) };
  const saldo = konten.filter((k: any) => k.current_balance !== null).map((k: any) => {
    const kurz = kontoKurz(k.iban);
    const a = anfangswert(Number(k.current_balance), Number(k.summe));
    const bezug = stand.anfangswerte?.[String(k.id)];
    if (bezug === undefined) neueAnfangswerte[String(k.id)] = a;
    return { id: Number(k.id), kurz, a, urteil: saldenUrteil(a, bezug, BEKANNTER_ANFANG[kurz.slice(1)]) };
  });
  const saldoAuffaellig = saldo.filter(s => s.urteil !== 'stimmt' && s.urteil !== 'erste Messung');

  // ── 3. Neue unklare Buchungen (Privatkonten) ───────────────────────────
  const privatIds = konten.filter((k: any) => PRIVAT_KONTEN_ENDZIFFERN.includes(String(k.iban).slice(-4))).map((k: any) => Number(k.id));
  const neuPrivat = privatIds.length === 0 ? [] : (await query(
    `SELECT account_id, booking_date, amount, coalesce(counterparty_name, '') AS g, coalesce(reference, '') AS z
       FROM banking_transactions
      WHERE duplicate_of IS NULL AND account_id = ANY($1) AND imported_at > $2 AND amount <= -25
      ORDER BY booking_date`, [privatIds, seit])).rows;
  let unklar: any[] = [];
  let regelwerkHinweis = '';
  if (neuPrivat.length > 0) {
    if (!existsSync(REGELWERK)) {
      regelwerkHinweis = 'Regelwerk nicht gefunden — keine Kategorisierung.';
    } else {
      /* Ein Fehler im Regelwerk darf nicht den ganzen Report kippen: Er wird
         im Abschnitt vermerkt, der Rest läuft weiter. -B: kein __pycache__
         neben dem Regelwerk. */
      try {
        const eingabe = neuPrivat.map((r: any) => ({ gegenpartei: r.g, zweck: r.z, konto: r.account_id, betrag: Number(r.amount) }));
        const kat: [string, string][] = JSON.parse(execFileSync('python3', ['-I', '-B', KATEGORISIERER, REGELWERK],
          { input: JSON.stringify(eingabe), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
        if (!Array.isArray(kat) || kat.length !== neuPrivat.length) throw new Error('Antwort des Regelwerks hat die falsche Länge');
        unklar = neuPrivat.filter((_: any, i: number) => kat[i][0] === 'Sonstiges/Unklar');
      } catch (e: any) {
        regelwerkHinweis = `Regelwerk nicht auswertbar (${String(e?.message || e).split('\n')[0].slice(0, 100)}) — keine Kategorisierung.`;
      }
    }
  }

  // ── 4. Mieterstrom Soll/Ist ────────────────────────────────────────────
  const mieterstrom: { objekt: string; zeilen: string[]; offen: number; fehlt390001: number; angebunden: boolean }[] = [];
  for (const o of MIETERSTROM) {
    const konto = konten.find((k: any) => String(k.iban).endsWith(o.kontoEndziffern));
    if (!konto) { mieterstrom.push({ objekt: o.objekt, zeilen: [], offen: 0, fehlt390001: 0, angebunden: false }); continue; }
    const zahlungen = (await query(
      `SELECT amount, coalesce(counterparty_name, '') AS g, coalesce(reference, '') AS z
         FROM banking_transactions WHERE account_id = $1 AND duplicate_of IS NULL AND amount > 0 AND booking_date >= '2026-03-01'`,
      [konto.id])).rows;
    const out: string[] = [];
    let offenSumme = 0; let fehlt390001 = 0;
    /* Jede Zahlung wird genau einem Kunden angerechnet: zuerst über die
       Kundennummer im Zweck, nur ohne Kundennummer über den Nachnamen —
       als ganzes Wort, damit „Ott" nicht in „Scott" trifft. */
    const vergeben = new Set<number>();
    const nummern = o.kunden.map((k: any) => k.nr);
    for (const k of o.kunden) {
      /* Nachnamen der aktuellen Mieter der Einheit — nur zum Erkennen, sie
         erscheinen nirgends im Report. */
      const namen = k.einheit ? (await query(
        `SELECT DISTINCT lower(t.last_name) AS n FROM leases l
           JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
           JOIN lease_tenants lt ON lt.lease_id = l.id JOIN tenants t ON t.id = lt.tenant_id
          WHERE lower(p.code) = lower($1) AND u.code = $2 AND l.status = 'active' AND t.last_name IS NOT NULL`,
        [o.objekt, k.einheit])).rows.map((r: any) => r.n).filter((n: string) => n.length >= 3) : [];
      const wort = (text: string, n: string) => new RegExp(`(^|[^a-zäöüß])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-zäöüß]|$)`, 'i').test(text);
      let gezahlt = 0;
      zahlungen.forEach((p: any, i: number) => {
        if (vergeben.has(i)) return;
        const traegtNummer = nummern.some((nr: string) => p.z.includes(nr));
        const passt = p.z.includes(k.nr) || (!traegtNummer && namen.some((n: string) => wort(p.g, n) || wort(p.z, n)));
        if (passt) { vergeben.add(i); gezahlt += Number(p.amount); }
      });
      const faellig = faelligeAbschlaege(k.ab, heute);
      const r = offeneAbschlaege(faellig, gezahlt, k.abschlag);
      offenSumme += r.offenEuro;
      if (k.nr === '390-001') fehlt390001 = r.offen;
      out.push(`| ${k.nr} | ${k.bezeichnung} | ${euro(k.abschlag)} | ${faellig} | ${euro(gezahlt)} | ${r.offen} | **${euro(r.offenEuro)}** |`);
    }
    mieterstrom.push({ objekt: o.objekt, zeilen: out, offen: offenSumme, fehlt390001, angebunden: true });
  }

  // ── 5. Ausgebliebene Daueraufträge/Lastschriften ───────────────────────
  const synchron = konten.filter((k: any) => k.last_sync_at && new Date(k.last_sync_at).getTime() > LAUFZEIT - 8 * 86_400_000).map((k: any) => Number(k.id));
  const verlauf = synchron.length === 0 ? [] : (await query(
    `SELECT account_id, booking_date, amount, coalesce(counterparty_name, '') AS g, coalesce(reference, '') AS z
       FROM banking_transactions
      WHERE duplicate_of IS NULL AND account_id = ANY($1) AND amount <= -10
        AND booking_date >= date_trunc('month', now()) - interval '3 months'`, [synchron])).rows;
  const umsaetze: Umsatz[] = verlauf.map((r: any) => ({ konto: Number(r.account_id), datum: datum(r.booking_date), betrag: Number(r.amount), gegenpartei: r.g, zweck: r.z }));
  const fehlend = ausgebliebeneSerien(umsaetze, heute);

  // ── 6. Große Abflüsse ──────────────────────────────────────────────────
  const gross = (await query(
    `SELECT t.account_id, a.iban, t.booking_date, t.amount, coalesce(t.counterparty_name, '') AS g, coalesce(t.reference, '') AS z
       FROM banking_transactions t JOIN banking_accounts a ON a.id = t.account_id
      WHERE t.duplicate_of IS NULL AND t.imported_at > $1 AND t.amount < -5000 ORDER BY t.amount`, [seit])).rows;

  // ── 7. Fristen NK ──────────────────────────────────────────────────────
  const fristen = (await query(
    `SELECT p.code AS objekt, o.year, u.code AS einheit, o.status, o.due_date, o.service_deadline_at
       FROM nk_period_obligations o JOIN properties p ON p.id = o.property_id JOIN units u ON u.id = o.unit_id
      WHERE o.status NOT IN ('served', 'expired')
        AND (o.due_date BETWEEN current_date AND current_date + 60 OR o.service_deadline_at BETWEEN current_date AND current_date + 60)
      ORDER BY least(coalesce(o.due_date, '9999-12-31'), coalesce(o.service_deadline_at, '9999-12-31'))`)).rows;

  if (nurGrundstand) {
    mkdirSync(ARBEITSORDNER, { recursive: true });
    writeFileSync(MERKDATEI, JSON.stringify({ letzterCheck: new Date(LAUFZEIT).toISOString(), anfangswerte: neueAnfangswerte }, null, 1), 'utf8');
    process.stdout.write(`GRUNDSTAND → ${MERKDATEI}\n`);
    return;
  }

  // ── Urteil und Kopf ────────────────────────────────────────────────────
  const tanPause = abgleich.filter(a => a.urteil === 'TAN-Pause' || a.urteil === 'läuft noch');
  const gescheitert = abgleich.filter(a => a.urteil === 'fehlgeschlagen' || a.urteil === 'kein Lauf');
  const neuGesamt = konten.reduce((s: number, k: any) => s + Number(k.neu), 0);
  const befunde = saldoAuffaellig.length + unklar.length + fehlend.length + gross.length + (merkdateiFehler ? 1 : 0);

  /* `fehler` bleibt dem Fall vorbehalten, dass der Check selbst scheitert.
     Ein ausgefallener Abgleich ist eine Owner-Aktion: nur er kann ihn
     anstoßen und eine TAN freigeben. */
  const status = (gescheitert.length > 0 || tanPause.length > 0) ? 'aktion' : befunde > 0 ? 'hinweis' : 'ok';
  const aktion = tanPause.length > 0
    ? 'In der S-pushTAN-App freigeben und in Telegram „TAN bestätigt → jetzt syncen" drücken'
    : gescheitert.length > 0 ? `Im Dashboard für ${gescheitert.map(g => g.name).join(', ')} „Abgleich jetzt" drücken` : 'keine';
  const ms = mieterstrom.find(m => m.objekt === 'MG24');
  const ergebnis = [
    `Abgleich: ${abgleich.filter(a => a.urteil !== 'nur PDF').map(a => `${a.name.split(' ')[0]} ${a.urteil}`).join(', ') || 'kein FinTS-Institut'}; ${neuGesamt} neue Umsätze`,
    `Saldenprobe ${saldoAuffaellig.length === 0 ? 'ohne Abweichung' : saldoAuffaellig.length + '× auffällig'}; ${unklar.length} neue unklare Buchungen ab 25 €; ${fehlend.length} erwartete Zahlungen ausgeblieben`,
    ms?.angebunden ? `Mieterstrom MG24: ${euro(ms.offen)} offen, davon Allgemeinstrom 390-001 ${ms.fehlt390001} Abschläge` : 'Mieterstrom MG24: Stromkonto nicht aktiv',
  ];
  const titel = status === 'ok' ? 'Wochencheck Banking – alles im Rahmen'
    : status === 'aktion' && gescheitert.length > 0 ? 'Wochencheck Banking – Abgleich fehlt'
    : status === 'aktion' ? 'Wochencheck Banking – TAN nötig'
    : `Wochencheck Banking – ${befunde} Punkte zum Ansehen`;

  z('---');
  z(`titel: ${titel}`);
  z(`status: ${status}`);
  z(`aufgabe: Wochencheck Banking ${heute} nach dem Montagsabgleich (automatisch, rein lesend)`);
  z(`ergebnis: [ ${ergebnis.map(e => JSON.stringify(e)).join(', ')} ]`);
  z(`aktion: ${aktion === 'keine' ? 'keine' : JSON.stringify(aktion)}`);
  z('tests: n/a');
  z('rote_zone: nein');
  z(`dauer_min: ${Math.max(1, Math.round((Date.now() - LAUFZEIT) / 60000))}`);
  z(`durchsuchte_quellen: "bikosoc-DB ${heute} (banking_sync_runs, banking_accounts, banking_transactions, leases, nk_period_obligations) · Regelwerk Privatausgaben (artifacts/personal) · kein Bankkontakt"`);
  z('---');
  z();
  z(`# Wochencheck Banking ${heute}`);
  z();
  z('**AUTO** (Timer, rein lesend) · **Datenklassifizierung:** intern · Konten nur mit Endziffern, keine Namen von Privatpersonen, Gesundheit ohne Namen');
  if (merkdateiFehler) { z(); z(`**Achtung:** ${merkdateiFehler}.`); }
  z();
  z(`Zeitraum „neu": seit ${berlinZeit(seit)}${stand.letzterCheck ? ' (letzter Check)' : ' (erster Check, 7 Tage)'}.`);
  z();

  z('## 1 Abgleich');
  z();
  z('| Institut | Ergebnis | Detail |');
  z('|---|---|---|');
  for (const a of abgleich) z(`| ${a.name} | ${a.urteil} | ${a.text} |`);
  if (verwaist.length > 0) {
    z();
    z(`_Hinweis: ${verwaist.reduce((s: number, v: any) => s + v.n, 0)} Laufzeilen stehen seit über einer Stunde auf RUNNING (verwaist, sperren nichts)._`);
  }
  z();

  z('## 2 Konten und Saldenprobe');
  z();
  z('| Konto | Institut | neu | Umsätze von–bis | Saldo Bank | Saldenprobe |');
  z('|---|---|---:|---|---:|---|');
  for (const k of konten as any[]) {
    const s = saldo.find(x => x.id === Number(k.id));
    z(`| ${kontoKurz(k.iban)} | ${k.institut} | ${k.neu} | ${datum(k.erster)} – ${datum(k.letzter)} | ${k.current_balance === null ? '–' : euro(Number(k.current_balance))} | ${s ? s.urteil : 'kein Banksaldo'} |`);
  }
  z();
  z('_Saldenprobe: Banksaldo minus Summe aller gespeicherten Umsätze muss dem Bezugswert der ersten Messung entsprechen. Weicht er ab, fehlen Umsätze oder sind doppelt — die Meldung bleibt, bis der Bezug bewusst neu gesetzt wird._');
  z();

  z('## 3 Neue unklare Buchungen ab 25 €');
  z();
  if (regelwerkHinweis) z(`_${regelwerkHinweis}_`);
  else if (unklar.length === 0) z('Keine.');
  else {
    z('| Datum | Konto | Betrag | Gegenpartei | Zweck | Vorschlag |');
    z('|---|---|---:|---|---|---|');
    for (const u of unklar) {
      const anzeige = gegenparteiAnzeige(u.g);
      const karte = /mc hauptkarte|kartenzahlung|girocard|debitk/i.test(u.z);
      const vorschlag = karte ? 'Kartenzahlung — Händler prüfen'
        : anzeige === 'Privatperson' ? 'Ihre Zuordnung (Überweisung an Privatperson)' : 'Regel für diese Gegenpartei ergänzen';
      /* Bei Privatpersonen, Gesundheit und unbekannter Gegenpartei steht im
         Zweck oft ein Name — dann kein Zweck im Report. Kartenumsätze zeigen
         nur Datum und Kartenart. */
      z(`| ${datum(u.booking_date)} | ${kontoKurz(konten.find((k: any) => Number(k.id) === Number(u.account_id))?.iban)} | ${euro(Number(u.amount))} | ${anzeige} | ${zweckErlaubt(anzeige) || karte ? zweckAnzeige(u.z, 50) : '–'} | ${vorschlag} |`);
    }
  }
  z();

  z('## 4 Mieterstrom Soll/Ist');
  z();
  for (const m of mieterstrom) {
    if (!m.angebunden) { z(`**${m.objekt}:** Stromkonto nicht in bikosoc aktiv — keine Prüfung.`); z(); continue; }
    z(`**${m.objekt}** (Stromkonto …${MIETERSTROM.find(x => x.objekt === m.objekt)!.kontoEndziffern}, Stichtag ${heute}):`);
    z();
    if (m.zeilen.length === 0) { z('Abschlagsplan nicht hinterlegt.'); z(); continue; }
    z('| Kunde | Einheit | Abschlag | fällig | gezahlt | offen (Anzahl) | offen |');
    z('|---|---|---:|---:|---:|---:|---:|');
    for (const r of m.zeilen) z(r);
    z();
    z('_Gezahlt enthält gegebenenfalls Mahngebühren; offen zählt nur volle Abschläge._');
    const kurz = '…' + MIETERSTROM.find(x => x.objekt === m.objekt)!.kontoEndziffern;
    if (saldoAuffaellig.some(s => s.kurz === kurz)) {  // Mieterstrom-Konten sind über die Endziffern konfiguriert
      z();
      z(`**Vorbehalt:** Die Saldenprobe von ${kurz} weicht ab — es fehlen Umsätze in bikosoc. Die Rückstände oben können deshalb zu hoch sein.`);
    }
    z();
  }

  z('## 5 Erwartete Zahlungen, die ausgeblieben sind');
  z();
  if (fehlend.length === 0) z('Keine. Alle Zahlungen, die in den drei Vormonaten jeden Monat liefen, sind im laufenden Monat gebucht oder noch nicht fällig.');
  else {
    z('| Konto | Gegenpartei | Betrag | sonst um den | lief in |');
    z('|---|---|---:|---:|---|');
    for (const f of fehlend) z(`| ${kontoKurz(konten.find((k: any) => Number(k.id) === f.konto)?.iban)} | ${gegenparteiAnzeige(f.gegenpartei)} | ${euro(f.betrag)} | ${f.tag}. | ${f.monate.slice(-3).join(', ')} |`);
  }
  z();
  z('_Geprüft werden nur Konten, die in den letzten 8 Tagen per FinTS abgeglichen wurden. Konten mit PDF-Import (Volksbank) fehlen, bis sie angebunden sind._');
  z();

  z('## 6 Große Abflüsse über 5.000 €');
  z();
  if (gross.length === 0) z('Keine.');
  else {
    z('| Datum | Konto | Betrag | Gegenpartei | Zweck |');
    z('|---|---|---:|---|---|');
    for (const g of gross) {
      const anzeige = gegenparteiAnzeige(g.g);
      z(`| ${datum(g.booking_date)} | ${kontoKurz(g.iban)} | ${euro(Number(g.amount))} | ${anzeige} | ${zweckErlaubt(anzeige) ? zweckAnzeige(g.z, 50) : '–'} |`);
    }
  }
  z();

  z('## 7 Fristen Nebenkosten (nächste 60 Tage)');
  z();
  if (fristen.length === 0) z('Keine.');
  else {
    z('| Objekt | Jahr | Einheit | Status | fällig | Zustellfrist |');
    z('|---|---|---|---|---|---|');
    for (const f of fristen) z(`| ${String(f.objekt).toUpperCase()} | ${f.year} | ${f.einheit} | ${f.status} | ${f.due_date ? datum(f.due_date) : '–'} | ${f.service_deadline_at ? datum(f.service_deadline_at) : '–'} |`);
  }
  z();

  z('## Rote Zone berührt');
  z();
  z('nein.');
  z();
  z('## Datenänderungen');
  z();
  z(probeZiel ? 'keine (Probelauf, Merkdatei unverändert).' : 'keine in der Datenbank. Merkdatei `artifacts/personal/banking-wochencheck/stand.json` fortgeschrieben.');
  z();
  z('## Rückweg');
  z();
  z('keiner nötig.');
  z();
  z('## Owner-Aktion');
  z();
  z(aktion === 'keine' ? 'keine.' : aktion + '.');
  z();
  z('## DIGEST');
  z();
  for (const e of ergebnis) z(`- ${e}`);
  z();

  mkdirSync(path.dirname(zielDatei), { recursive: true });
  writeFileSync(zielDatei, zeilen.join('\n'), 'utf8');

  /* Merkdatei erst NACH dem Report: scheitert der Report, misst der nächste
     Lauf wieder ab dem alten Zeitpunkt. */
  if (!probeZiel) {
    mkdirSync(ARBEITSORDNER, { recursive: true });
    writeFileSync(MERKDATEI, JSON.stringify({ letzterCheck: new Date(LAUFZEIT).toISOString(), anfangswerte: neueAnfangswerte }, null, 1), 'utf8');
  }
  process.stdout.write(`DONE → ${zielDatei}\n`);
}

main().then(() => process.exit(0)).catch((e: any) => {
  /* Auch ein Fehlschlag erzeugt einen Report mit Kopfblock — sonst bliebe der
     Montag stumm. */
  const text = String(e?.message || e).slice(0, 400).replace(/[A-Z]{2}\d{2}[\d ]{12,}/g, '(IBAN entfernt)');
  mkdirSync(path.dirname(zielDatei), { recursive: true });
  writeFileSync(zielDatei, [
    '---', 'titel: Wochencheck Banking – Auswertung fehlgeschlagen', 'status: fehler',
    `aufgabe: Wochencheck Banking ${heute} abgebrochen: ${text.split('\n')[0].slice(0, 120).replace(/"/g, "'")}`,
    `ergebnis: [ ${JSON.stringify(text)} ]`, 'aktion: keine', 'tests: n/a', 'rote_zone: nein', 'dauer_min: 1',
    'durchsuchte_quellen: "bikosoc-DB"', '---', '', `# Wochencheck Banking ${heute} — fehlgeschlagen`, '',
    '**Datenklassifizierung:** intern', '', '```', text, '```', '',
    '## Rote Zone berührt', '', 'nein.', '', '## Datenänderungen', '', 'keine.', '', '## Rückweg', '', 'keiner nötig.', '',
    '## Owner-Aktion', '', 'keine. Der Fehler steht oben; die Prüfung beauftragt der Chat.', '', '## DIGEST', '', `- Wochencheck fehlgeschlagen: ${text}`, '',
  ].join('\n'), 'utf8');
  process.stdout.write(`FEHLER → ${zielDatei}\n`);
  process.exit(1);
});

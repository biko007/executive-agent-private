import fs from 'node:fs';
import { titelAusAuftrag } from '../report-telegram/index.js';
import path from 'node:path';
import {
  sendPromptToBikosocTmux, lesePaneInhalt, sitzungLaeuft, starteCcSitzung, sitzungsZiel,
  type TmuxRunner,
} from '../cc-prompt-dispatch/index.js';
import {
  ladeRouting, regelFuer, type RoutingTabelle, type SitzungsRegel,
} from './routing.js';
import {
  pruefeBereitschaft, grundText, auftragsKennung, auftragsStamm,
  erkenneArmWartung, armMeldung, bewerteAnnahme, annahmeText,
  type Bereitschaft, type Annahme,
} from './bereitschaft.js';
import { pruefeArmBedarf } from '../arm-status/index.js';
import { query as dbAbfrageStandard } from '../../shared/db/index.js';

export interface PromptInboxResult {
  sourcePath: string;
  donePath: string;
  reportPath: string;
}

/** Eine Datei, die liegen geblieben ist, weil Claude Code nicht bereit war. */
export interface ZurueckgestelltResult {
  sourcePath: string;
  grund: string;
  beleg?: string;
}

export interface PromptInboxLauf {
  zugestellt: PromptInboxResult[];
  zurueckgestellt: ZurueckgestelltResult[];
  /** Stups des Leerlauf-Wächters, falls einer ausgelöst wurde. */
  stups?: { kennung: string; versuch: number; gemeldet: boolean };
  /** Eingetippt, aber von Claude Code nicht angenommen (Nachprüfung, 02.11.2026). */
  nichtUebergeben?: NichtUebergebenResult[];
}

export interface NichtUebergebenResult {
  sourcePath: string;
  grund: string;
  beleg?: string;
  /** Quittung geschrieben (= Telegram über den Report-Watcher)? Nur beim ersten
   *  Fehlschlag je Datei und Grund — sonst meldete jeder Versuch erneut. */
  gemeldet: boolean;
  reportPath?: string;
}

/**
 * Nachprüfung nach dem Eintippen (02.11.2026).
 *
 * ANLASS: Am 01.11.2026 21:11 wurde ein Auftrag eingetippt, Claude Code
 * antwortete „Login expired". Die Inbox quittierte „übergeben", verschob die
 * Datei nach done/ — der Auftrag lag unbearbeitet bis zum nächsten Morgen.
 *
 * Mit Nachprüfung wartet die Inbox nach dem Eintippen `warteMs` und liest das
 * Pane erneut (bewerteAnnahme). Erst dann wird die Datei verschoben und
 * quittiert. Nimmt Claude Code nicht an, bleibt die Datei in der
 * Warteschlange, die Quittung heißt „NICHT übergeben: <Grund>" (Status
 * fehler → Telegram dev über den Report-Watcher), und dieselbe Datei wird
 * frühestens nach `sperrMinuten` erneut versucht.
 */
export interface Nachpruefung {
  warteMs: number;
  /** Pane lesen; Standard: tmux capture-pane. Für Tests ersetzbar. */
  lesePane?: (target?: string) => string;
  /** Sperrfrist nach gescheiterter Übergabe (Standard 10 min). */
  sperrMinuten?: number;
}

/** Merkdatei der gescheiterten Übergaben, je Dateiname. */
interface FehlUebergabe { grund: string; seit: string; versuche: number; sperreBis: string }

function ladeFehlUebergaben(pfad: string): Record<string, FehlUebergabe> {
  try { return JSON.parse(fs.readFileSync(pfad, 'utf-8')) ?? {}; } catch { return {}; }
}

function speichereFehlUebergaben(pfad: string, z: Record<string, FehlUebergabe>): void {
  try {
    if (Object.keys(z).length === 0) { if (fs.existsSync(pfad)) fs.unlinkSync(pfad); return; }
    fs.writeFileSync(pfad, JSON.stringify(z, null, 2));
  } catch (e: any) {
    process.stderr.write(`Prompt-Inbox: Merkdatei nicht schreibbar: ${e.message}\n`);
  }
}

/** Synchrones Warten — der Lauf ist ein kurzer Einzelprozess (systemd oneshot). */
function warteSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Was der Owner bei welchem Grund tun muss — ein Satz für den Kopfblock. */
function aktionFuer(a: Annahme): string {
  if (a.angenommen) return 'keine';
  switch (a.grund) {
    case 'login_abgelaufen': return 'In tmux bikosoc /login ausführen oder Claude Code mit ~/bin/cc-start.sh neu starten; die Datei wird danach selbst erneut zugestellt.';
    case 'kein_fortschritt': return 'tmux bikosoc ansehen, ob Claude Code reagiert; die Datei wird in 10 Minuten erneut versucht.';
  }
}

// ── Admin-Kanal (Owner-Auftrag 26.10.2026) ────────────────────────────────
//
// Server- und Wartungsaufträge laufen nicht mehr durch den Fachstrang
// bikosoc, sondern in eine eigene Claude-Code-Instanz: tmux-Sitzung `admin`,
// Fenster `admin`, Arbeitsverzeichnis ~/admin (Start: ~/admin/start-admin.sh).
//
// WARUM EINE EIGENE SITZUNG UND KEIN FENSTER IN „bikosoc": Alle Kontrollwege
// (diese Inbox, /do, /ccstop, /ccgo, Wartemelder) zielen auf `bikosoc` — das
// heißt in tmux: auf das gerade AKTIVE Fenster dieser Sitzung. Ein Fenster
// „admin" darin würde all diese Wege umlenken, sobald es aktiv ist. In einer
// eigenen Sitzung bleibt jeder bestehende Weg, wie er ist.
//
// Erkannt wird ein Admin-Auftrag allein am Dateinamen: `prompt-admin-*.txt`,
// gegebenenfalls hinter den Transportvorsätzen der Dropbox-Inbox und des
// Mail-Eingangs. Groß-/Kleinschreibung zählt; „prompt-administration.txt"
// oder „PROMPT-ADMIN-…" gehen den bisherigen Weg.

export const ADMIN_TMUX_TARGET = 'admin:admin';

const ADMIN_DATEINAME =
  /^(\d{4}-\d{2}-\d{2}T[\d-]+Z-)?(dropbox-(\d{8}-\d{6}-)?)?(auftrag-mail-\d{8}-\d{4}-)?prompt-admin-[^/]+\.txt$/;
//  ^ Zeitstempel des Pollers  ^ Dropbox-Inbox           ^ Mail-Eingangskanal       ^ der eigentliche Name

export function istAdminAuftrag(dateiname: string): boolean {
  return ADMIN_DATEINAME.test(dateiname);
}

export function sanitizeDoneName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function formatBerlinDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatReportTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('year')}${value('month')}${value('day')}-${value('hour')}${value('minute')}${value('second')}`;
}

// ── Zustand des Leerlauf-Wächters ──────────────────────────────────────────
//
// Wenige Felder in einer JSON-Datei: Seit wann ist Claude Code untätig, und
// wie oft wurde zu welchem Auftrag schon gestupst. Eine Tabelle dafür wäre
// unverhältnismäßig — der Zustand ist Laufzeitinformation und darf bei einem
// Neustart verloren gehen.

interface WaechterZustand {
  /** ISO-Zeitpunkt, seit dem das Pane ununterbrochen bereit ist. */
  bereitSeit?: string;
  /** Je Auftragskennung die Zahl der Stupse und der letzte Zeitpunkt. */
  stupse: Record<string, { anzahl: number; zuletzt: string; gemeldet?: boolean }>;
  /** Zeitpunkt der Blockade, zu der schon eine Armierungsmeldung raus ist. */
  armGemeldetFuer?: string;
  /**
   * Ab wann der Wächter zuschaut. Aufträge, die davor zugestellt wurden, stupst
   * er nie — ob sie erledigt sind, hat er nicht miterlebt.
   */
  beobachtetSeit?: string;
}

function ladeZustand(pfad: string): WaechterZustand {
  try {
    const z = JSON.parse(fs.readFileSync(pfad, 'utf-8'));
    return {
      bereitSeit: z.bereitSeit,
      stupse: z.stupse || {},
      armGemeldetFuer: z.armGemeldetFuer,
      beobachtetSeit: z.beobachtetSeit,
    };
  } catch {
    return { stupse: {} };
  }
}

function speichereZustand(pfad: string, z: WaechterZustand): void {
  fs.mkdirSync(path.dirname(pfad), { recursive: true });
  fs.writeFileSync(pfad, JSON.stringify(z, null, 2) + '\n');
}

/**
 * Gibt es zu einem übergebenen Auftrag noch keinen Report?
 *
 * Die Berichte heißen `report-<kennung>-<datum>.md`. Fehlt einer, gilt der
 * Auftrag als nicht abgeschlossen. Das ist eine Annäherung — ein Nachtrag
 * bekommt oft keinen eigenen Report —, und genau deshalb hört der Wächter
 * nach zwei Stupsen auf und meldet stattdessen.
 */
export function offeneAuftraege(opts: {
  doneDir: string;
  reportDir: string;
  now: Date;
  /** Nur Aufträge aus den letzten n Tagen betrachten. */
  maxAlterTage?: number;
  /**
   * Aufträge, die vor diesem Zeitpunkt zugestellt wurden, bleiben außen vor.
   * Der Wächter hat nicht miterlebt, wie sie abgearbeitet wurden, und darf sie
   * deshalb nicht für offen halten.
   */
  nichtVor?: Date;
  /** Routing-Tabelle: Dateien anderer Sitzungen stupst der Wächter nicht. */
  routing?: RoutingTabelle;
}): { datei: string; kennung: string; uebergabe: Date }[] {
  const maxAlter = (opts.maxAlterTage ?? 3) * 86400000;
  let dateien: string[] = [];
  let berichte: string[] = [];
  try { dateien = fs.readdirSync(opts.doneDir); } catch { return []; }
  try { berichte = fs.readdirSync(opts.reportDir).filter(b => b.endsWith('.md')); } catch { berichte = []; }

  const offen: { datei: string; kennung: string; uebergabe: Date }[] = [];
  for (const datei of dateien) {
    if (!datei.endsWith('.txt')) continue;
    const kennung = auftragsKennung(datei);
    if (!kennung) continue;
    let st: fs.Stats;
    try { st = fs.statSync(path.join(opts.doneDir, datei)); } catch { continue; }
    if (opts.now.getTime() - st.mtimeMs > maxAlter) continue;
    if (opts.nichtVor && st.mtimeMs < opts.nichtVor.getTime()) continue;

    // Quittungen des Pollers selbst sind keine Aufträge.
    if (/^prompt-inbox/.test(kennung)) continue;
    /* Admin-Aufträge laufen in der Sitzung `admin`. Der Wächter stupst nur
       bikosoc — einen Admin-Auftrag dort als „offen" zu führen, hieße, ein
       „weiter mit prompt-admin-…" in den Fachstrang zu tippen. */
    if (istAdminAuftrag(datei)) continue;
    /* Dasselbe für geroutete Aufträge (§13.1): Sie laufen in ihrer eigenen
       Sitzung; ein Stups in bikosoc wäre dort falsch. */
    if (opts.routing && regelFuer(datei, opts.routing)) continue;

    if (!hatReport(berichte, kennung)) {
      offen.push({ datei, kennung, uebergabe: new Date(st.mtimeMs) });
    }
  }
  return offen.sort((a, b) => a.uebergabe.getTime() - b.uebergabe.getTime());
}

/** Zustellzeit des jüngsten abgelegten Auftrags, oder null bei leerem Ordner. */
export function juengsteZustellung(doneDir: string): number | null {
  let neuste: number | null = null;
  let dateien: string[];
  try { dateien = fs.readdirSync(doneDir); } catch { return null; }
  for (const datei of dateien) {
    if (!datei.endsWith('.txt')) continue;
    try {
      const ms = fs.statSync(path.join(doneDir, datei)).mtimeMs;
      if (neuste === null || ms > neuste) neuste = ms;
    } catch { /* verschwundene Datei überspringen */ }
  }
  return neuste;
}

/**
 * Gibt es zu dieser Auftragskennung einen Report?
 *
 * Verglichen wird gegen die Kennung UND gegen ihren Stamm ohne den
 * `prompt-`-Vorsatz: Die Datei heißt `prompt-golink-spacing2-20261008.txt`,
 * der Report dazu `report-golink-spacing2-20261008.md`. Die alte Prüfung
 * suchte `report-prompt-golink-spacing2-` und fand nie etwas; zwei längst
 * erledigte Aufträge wurden dadurch am 11.10.2026 erneut angestoßen.
 *
 * Das Datum im Reportnamen wird NICHT verglichen. Ein Report vom Vortag oder
 * ein Nachtrag (`report-<stamm>-nachzug-<datum>.md`) zählt genauso — er
 * belegt, dass der Auftrag bearbeitet wurde.
 */
export function hatReport(berichte: string[], kennung: string): boolean {
  const stamm = auftragsStamm(kennung);
  return berichte.some(b =>
    b.startsWith(`report-${kennung}-`) || b.startsWith(`report-${stamm}-`));
}

/**
 * Ein Durchlauf der Prompt-Inbox.
 *
 * ÄNDERUNG 11.10.2026 gegenüber der ersten Fassung:
 *
 *   - Zustellung NUR, wenn das Pane aufnahmebereit ist. Sonst bleibt die Datei
 *     liegen und wird beim nächsten Lauf erneut geprüft. Grund: Steht ein
 *     Dialog offen, wäre der getippte Text eine Antwort darauf und keine
 *     Nachricht — die erste Zeile eines Auftrags würde eine Option auswählen.
 *   - HÖCHSTENS EINE Datei pro Lauf. Nach der Zustellung arbeitet Claude Code;
 *     eine zweite Datei im selben Lauf träfe genau den Zustand, den die
 *     Prüfung oben verhindern soll.
 *   - Reihenfolge nach DATEIZEIT, nicht nach Name. Der Name trägt den
 *     Zeitstempel der Dropbox-Übergabe, nicht den der Ablage.
 */
export function processPromptInboxOnce(opts: {
  homeDir: string;
  inboxDir?: string;
  reportDir?: string;
  now?: Date;
  runner?: TmuxRunner;
  /** Pane-Text. Nur für Tests — in Produktion wird tmux gelesen. */
  paneText?: string;
  /** Pane-Text der Admin-Sitzung. Nur für Tests; '' = Sitzung läuft nicht. */
  adminPaneText?: string;
  /** Prüfung abschalten. Nur für Tests der alten Reihenfolge. */
  ohneBereitschaftspruefung?: boolean;
  /** Nachprüfung nach dem Eintippen; ohne Angabe wie bisher sofort quittiert. */
  nachpruefung?: Nachpruefung;
  /** Routing-Tabelle; ohne Angabe aus ~/.config/openclaw/inbox-sessions.conf. */
  routing?: RoutingTabelle;
  /** Zugriff auf Routing-Sitzungen. Nur für Tests ersetzbar. */
  sitzungen?: SitzungsZugriff;
}): PromptInboxLauf {
  const homeDir = opts.homeDir;
  const inboxDir = opts.inboxDir ?? path.join(homeDir, 'inbox');
  const doneDir = path.join(inboxDir, 'done');
  const reportDir = opts.reportDir ?? path.join(homeDir, 'bikosoc-spec');
  const now = opts.now ?? new Date();

  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(doneDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });

  const kandidaten = fs.readdirSync(inboxDir)
    .filter((name) => name.endsWith('.txt') && !name.startsWith('.'))
    .map((name) => {
      const p = path.join(inboxDir, name);
      try {
        const st = fs.statSync(p);
        return st.isFile() ? { name, p, mtimeMs: st.mtimeMs } : null;
      } catch { return null; }
    })
    .filter((x): x is { name: string; p: string; mtimeMs: number } => x !== null)
    // FIFO nach Dateizeit; bei gleicher Zeit nach Name, damit die Reihenfolge
    // auch auf Dateisystemen mit grober Zeitauflösung bestimmt ist.
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));

  const lauf: PromptInboxLauf = { zugestellt: [], zurueckgestellt: [] };
  if (kandidaten.length === 0) return lauf;

  /* Zwei Kanäle, getrennt geprüft und getrennt zugestellt (26.10.2026). Der
     Fachkanal bikosoc arbeitet exakt wie bisher, nur ohne die Admin-Dateien;
     der Admin-Kanal hat eigene Bereitschaft und eigene „eine Datei pro Lauf". */
  /* Session-Routing nach Präfix (Spec §13.1, 05.11.2026). Admin-Dateien
     zuerst und unverändert; danach entscheidet die Regel zum Präfix. Ohne
     Regel bleibt die Datei im Fachkanal bikosoc. */
  const routing = opts.routing ?? ladeRouting(homeDir);
  for (const f of routing.fehler) {
    process.stderr.write(`Prompt-Inbox: inbox-sessions.conf Zeile ${f.zeile} übersprungen (${f.grund})\n`);
  }
  const admin = kandidaten.filter(k => istAdminAuftrag(k.name));
  const ohneAdmin = kandidaten.filter(k => !istAdminAuftrag(k.name));
  const fach = ohneAdmin.filter(k => !regelFuer(k.name, routing));
  const geroutet = new Map<string, { regel: SitzungsRegel; dateien: typeof kandidaten }>();
  for (const k of ohneAdmin) {
    const regel = regelFuer(k.name, routing);
    if (!regel) continue;
    const g = geroutet.get(regel.sitzung) ?? { regel, dateien: [] };
    g.dateien.push(k);
    geroutet.set(regel.sitzung, g);
  }

  if (fach.length > 0) {
    const paneVorher = opts.paneText
      ?? (opts.ohneBereitschaftspruefung && !opts.nachpruefung ? '' : (opts.nachpruefung?.lesePane ?? lesePaneInhalt)());
    const bereitschaft: Bereitschaft = opts.ohneBereitschaftspruefung
      ? { bereit: true }
      : pruefeBereitschaft(paneVorher);
    kanalZustellen(lauf, fach, bereitschaft, {
      target: undefined, runner: opts.runner, doneDir, reportDir, now, kanal: 'fach',
      nachpruefung: opts.nachpruefung, paneVorher,
    });
  }

  if (admin.length > 0) {
    const adminText = opts.adminPaneText ?? lesePaneInhalt(ADMIN_TMUX_TARGET);
    /* Ohne laufende Admin-Sitzung bleibt die Datei liegen — sie fällt NIE auf
       den Fachkanal zurück. Ein Serverauftrag gehört nicht in bikosoc. */
    const sitzungFehlt = !adminText.trim();
    const bereitschaft: Bereitschaft = sitzungFehlt
      ? { bereit: false, grund: 'pane_leer' }
      : opts.ohneBereitschaftspruefung ? { bereit: true } : pruefeBereitschaft(adminText);
    kanalZustellen(lauf, admin, bereitschaft, {
      target: ADMIN_TMUX_TARGET, runner: opts.runner, doneDir, reportDir, now, kanal: 'admin',
      grundAnders: sitzungFehlt ? 'Admin-Sitzung läuft nicht — Start: ~/admin/start-admin.sh' : undefined,
      nachpruefung: opts.nachpruefung, paneVorher: adminText,
    });
  }

  for (const { regel, dateien } of geroutet.values()) {
    sitzungZustellen(lauf, regel, dateien, {
      homeDir, runner: opts.runner, doneDir, reportDir, now, nachpruefung: opts.nachpruefung,
      ohneBereitschaftspruefung: opts.ohneBereitschaftspruefung, zugriff: opts.sitzungen,
    });
  }
  return lauf;
}

/** tmux-Zugriff für Routing-Sitzungen; in Produktion echte tmux-Aufrufe. */
export interface SitzungsZugriff {
  pane?: (ziel: string) => string;
  laeuft?: (sitzung: string) => boolean;
  starte?: (regel: SitzungsRegel) => void;
  /** Höchstwartezeit auf den Prompt nach dem Autostart (Standard 60 s). */
  startWarteMs?: number;
  /** Abstand der Pane-Abfragen beim Warten (Standard 2 s). */
  startIntervallMs?: number;
}

/** Startskript des Autostarts — setzt die Anmeldung und startet claude.
 *  Fester Pfad im Repo (nicht relativ zur Quelldatei: dist/ liegt anders). */
export function startSkriptPfad(homeDir: string): string {
  return path.join(homeDir, '.openclaw', 'workspace', '.openclaw', 'extensions', 'executive-agent',
    'scripts', 'cc-sitzung-start.sh');
}

/**
 * Zeigt das Pane einen fertigen Claude-Code-Prompt? Textabgleich wie bei
 * /ccgo: Eingabezeiger `❯` bzw. `>` am Zeilenanfang oder die Statuszeile der
 * Rechtestufe — UND kein Durchgang/Dialog (pruefeBereitschaft). Eine nackte
 * Shell oder ein halb gezeichneter Startbildschirm zählt nicht.
 */
export function ccPromptBereit(pane: string): boolean {
  if (!pruefeBereitschaft(pane).bereit) return false;
  return /^\s*[❯>]\s*$/m.test(pane.replace(/\r/g, '')) || /bypass permissions on|for shortcuts/.test(pane);
}

/**
 * Zustellung in eine geroutete Sitzung, bei Bedarf mit Autostart.
 *
 * Fehlt die Sitzung, wird sie angelegt und bis zu 60 s auf den Prompt
 * gewartet. Scheitert das, bleibt der Auftrag in der Inbox und die Quittung
 * meldet den Fehler (einmal je Datei; neuer Versuch nach der Sperrfrist).
 */
function sitzungZustellen(
  lauf: PromptInboxLauf,
  regel: SitzungsRegel,
  dateien: { name: string; p: string }[],
  k: {
    homeDir: string; runner?: TmuxRunner; doneDir: string; reportDir: string; now: Date;
    nachpruefung?: Nachpruefung; ohneBereitschaftspruefung?: boolean; zugriff?: SitzungsZugriff;
  },
): void {
  const ziel = sitzungsZiel(regel.sitzung);
  const z = k.zugriff ?? {};
  const lese = z.pane ?? ((t: string) => lesePaneInhalt(t));
  const laeuft = z.laeuft ?? ((s: string) => sitzungLaeuft(s));
  let neuGestartet = false;
  let pane = '';

  if (!laeuft(regel.sitzung)) {
    /* Sperrfrist auch für den Autostart: Ein gescheiterter Start darf nicht
       alle zehn Sekunden wiederholt werden. */
    const merkPfad = path.join(path.dirname(k.doneDir), '.nicht-uebergeben.json');
    const fehl = ladeFehlUebergaben(merkPfad);
    const erste = dateien[0];
    const alt = fehl[erste.name];
    if (alt && Date.parse(alt.sperreBis) > k.now.getTime()) {
      for (const x of dateien) {
        lauf.zurueckgestellt.push({ sourcePath: x.p, grund: `wartet nach gescheitertem Autostart von ${regel.sitzung} bis ${alt.sperreBis}` });
      }
      return;
    }
    let startFehler: string | null = null;
    try {
      (z.starte ?? ((r: SitzungsRegel) => starteCcSitzung(r.sitzung, r.verzeichnis, startSkriptPfad(k.homeDir), k.runner)))(regel);
      neuGestartet = true;
      const bis = Date.now() + (z.startWarteMs ?? 60_000);
      for (;;) {
        pane = lese(ziel);
        if (ccPromptBereit(pane)) break;
        if (Date.now() >= bis) {
          const b = pruefeBereitschaft(pane);
          startFehler = `Claude Code in ${regel.sitzung} nach ${Math.round((z.startWarteMs ?? 60_000) / 1000)} s nicht bereit`
            + (b.bereit ? '' : ` (${grundText(b.grund)})`);
          break;
        }
        warteSync(z.startIntervallMs ?? 2_000);
      }
    } catch (e: any) {
      startFehler = `tmux-Sitzung ${regel.sitzung} nicht startbar: ${String(e?.message ?? e).slice(0, 160)}`;
    }
    if (startFehler) {
      const melden = !alt || alt.grund !== 'autostart';
      const sperre = new Date(k.now.getTime() + (k.nachpruefung?.sperrMinuten ?? 10) * 60_000);
      fehl[erste.name] = { grund: 'autostart', seit: alt?.seit ?? k.now.toISOString(), versuche: (alt?.versuche ?? 0) + 1, sperreBis: sperre.toISOString() };
      speichereFehlUebergaben(merkPfad, fehl);
      const reportPath = melden
        ? schreibeStartFehlQuittung(erste.name, regel, startFehler, dateien.length - 1, sperre, k)
        : undefined;
      (lauf.nichtUebergeben ??= []).push({ sourcePath: erste.p, grund: startFehler, gemeldet: melden, reportPath });
      for (const r of dateien.slice(1)) {
        lauf.zurueckgestellt.push({ sourcePath: r.p, grund: 'wartet hinter einer nicht übergebenen Datei' });
      }
      return;
    }
  } else {
    pane = lese(ziel);
  }

  const bereitschaft: Bereitschaft = k.ohneBereitschaftspruefung ? { bereit: true } : pruefeBereitschaft(pane);
  kanalZustellen(lauf, dateien, bereitschaft, {
    target: ziel, runner: k.runner, doneDir: k.doneDir, reportDir: k.reportDir, now: k.now,
    kanal: 'sitzung', sitzung: regel.sitzung, neuGestartet,
    nachpruefung: k.nachpruefung ? { ...k.nachpruefung, lesePane: k.nachpruefung.lesePane ?? ((t?: string) => lese(t ?? ziel)) } : undefined,
    paneVorher: pane,
  });
}

/** Eine Datei eines Kanals zustellen, die übrigen zurückstellen. */
function kanalZustellen(
  lauf: PromptInboxLauf,
  kandidaten: { name: string; p: string }[],
  bereitschaft: Bereitschaft,
  k: {
    target: string | undefined; runner?: TmuxRunner; doneDir: string; reportDir: string;
    now: Date; kanal: 'fach' | 'admin' | 'sitzung';
    /** Name der gerouteten Sitzung (nur kanal 'sitzung'). */
    sitzung?: string;
    /** In diesem Lauf per Autostart angelegt? */
    neuGestartet?: boolean;
    /** Eigener Grund statt des Standardtexts (fehlende Admin-Sitzung). */
    grundAnders?: string;
    nachpruefung?: Nachpruefung;
    /** Pane vor dem Eintippen — Vergleichsbasis der Nachprüfung. */
    paneVorher?: string;
  },
): void {
  if (!bereitschaft.bereit) {
    for (const x of kandidaten) {
      lauf.zurueckgestellt.push({
        sourcePath: x.p,
        grund: k.grundAnders ?? grundText(bereitschaft.grund),
        beleg: bereitschaft.beleg,
      });
    }
    return;
  }

  /* Nach einer gescheiterten Übergabe ruht dieselbe Datei für die Sperrfrist —
     sonst tippte die Inbox sie alle zehn Sekunden erneut in ein Pane, das
     nicht reagiert. Andere Dateien des Kanals warten dahinter (FIFO bleibt). */
  const merkPfad = path.join(path.dirname(k.doneDir), '.nicht-uebergeben.json');
  const fehl = k.nachpruefung ? ladeFehlUebergaben(merkPfad) : {};
  const gesperrt = kandidaten[0] && fehl[kandidaten[0].name]
    && Date.parse(fehl[kandidaten[0].name].sperreBis) > k.now.getTime();
  if (gesperrt) {
    const f = fehl[kandidaten[0].name];
    for (const x of kandidaten) {
      lauf.zurueckgestellt.push({
        sourcePath: x.p,
        grund: `wartet nach gescheiterter Übergabe (${f.grund}) bis ${f.sperreBis}`,
      });
    }
    return;
  }

  // Genau eine Datei zustellen.
  const [erste, ...rest] = kandidaten;
  const text = fs.readFileSync(erste.p, 'utf-8');
  sendPromptToBikosocTmux(text, { runner: k.runner, target: k.target });

  if (k.nachpruefung) {
    warteSync(k.nachpruefung.warteMs);
    const lese = k.nachpruefung.lesePane ?? lesePaneInhalt;
    const annahme = bewerteAnnahme(k.paneVorher ?? '', k.target ? lese(k.target) : lese());
    if (!annahme.angenommen) {
      const alt = fehl[erste.name];
      const melden = !alt || alt.grund !== annahme.grund;
      const sperre = new Date(k.now.getTime() + (k.nachpruefung.sperrMinuten ?? 10) * 60_000);
      fehl[erste.name] = {
        grund: annahme.grund, seit: alt?.seit ?? k.now.toISOString(),
        versuche: (alt?.versuche ?? 0) + 1, sperreBis: sperre.toISOString(),
      };
      speichereFehlUebergaben(merkPfad, fehl);
      const reportPath = melden ? schreibeFehlQuittung(erste.name, text, annahme, rest.length, sperre, k) : undefined;
      (lauf.nichtUebergeben ??= []).push({
        sourcePath: erste.p, grund: annahmeText(annahme), beleg: annahme.beleg, gemeldet: melden, reportPath,
      });
      for (const r of rest) {
        lauf.zurueckgestellt.push({ sourcePath: r.p, grund: 'wartet hinter einer nicht übergebenen Datei' });
      }
      return;
    }
    if (fehl[erste.name]) { delete fehl[erste.name]; speichereFehlUebergaben(merkPfad, fehl); }
  }

  const now = k.now;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const donePath = path.join(k.doneDir, `${stamp}-${sanitizeDoneName(erste.name)}`);
  fs.renameSync(erste.p, donePath);

  const reportDate = formatBerlinDate(now);
  const reportStamp = formatReportTimestamp(now);
  // Eigener Name für den Admin-Kanal: Beide Kanäle können im selben Lauf
  // zustellen, und ihre Quittungen dürfen sich nicht überschreiben.
  const reportName = k.kanal === 'admin'
    ? `report-prompt-inbox-admin-${reportStamp}.md`
    : k.kanal === 'sitzung'
      ? `report-prompt-inbox-${sanitizeDoneName(k.sitzung ?? 'sitzung')}-${reportStamp}.md`
      : `report-prompt-inbox-${reportStamp}.md`;
  const reportPath = path.join(k.reportDir, reportName);
  /* KOPFBLOCK ZUERST (Owner-Vorgabe 14.10.2026). Der Report-Watcher liest ihn
     und formt daraus die Telegram-Nachricht „Aufgabe uebernommen". Vorher las er
     den Fliesstext und schickte Dokument, Textvorschau und Quittung einzeln —
     drei Nachrichten fuer eine Uebergabe.

     Der Titel ist der Dateiname ohne Transportpraefixe; einen sprechenderen
     Titel kennt die Inbox an dieser Stelle nicht, und Raten waere schlechter
     als der Dateiname. */
  /* Der Titel kommt aus der ERSTEN ZEILE der Auftragsdatei, nicht aus dem
     Dateinamen — der steht ohnehin eine Zeile darunter. Liefert der Text
     nichts Brauchbares, bleibt der Titel leer und die Meldung zeigt nur die
     Dateizeile. */
  /* Quittung nennt die Ziel-Sitzung (Spec §13.1 Punkt 4). */
  const zielSitzung = k.kanal === 'admin' ? 'admin' : k.kanal === 'sitzung' ? (k.sitzung ?? '?') : 'bikosoc';
  const uebergabeText = `übergeben an ${zielSitzung}${k.neuGestartet ? ' (neu gestartet)' : ''}`;
  const titel = (k.kanal === 'admin' ? '[ADMIN] ' : '')
    + (k.kanal === 'sitzung' ? `[${uebergabeText}] ` : '')
    + (titelAusAuftrag(text) ?? '');
  const uhrzeit = new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
  }).format(now);
  const body = [
    '---',
    'typ: uebernahme',
    `titel: ${titel}`,
    'status: ok',
    `datei: ${erste.name}`,
    `ziel: ${zielSitzung}${k.neuGestartet ? ' (neu gestartet)' : ''}`,
    `zeit: "${uhrzeit}"`,
    `warteschlange: ${rest.length > 0 ? `${rest.length} wartend` : 'leer'}`,
    '---',
    '',
    `# Prompt-Inbox ${reportDate}`,
    '',
    '## Übergabe',
    '',
    `- Datei: ${erste.name}`,
    `- Verschoben nach: ${donePath}`,
    `- Ziel: ${uebergabeText}`,
    '- Status: Prompt uebergeben (Claude Code war aufnahmebereit).',
    rest.length > 0
      ? `- Noch in der Warteschlange: ${rest.length} (${rest.map(r => r.name).join(', ')})`
      : '- Noch in der Warteschlange: keine',
    '',
  ].join('\n');
  fs.writeFileSync(reportPath, body);

  lauf.zugestellt.push({ sourcePath: erste.p, donePath, reportPath });
  for (const r of rest) {
    lauf.zurueckgestellt.push({
      sourcePath: r.p,
      grund: 'eine Datei pro Lauf — kommt beim naechsten Durchgang',
    });
  }
}


/**
 * Leerlauf-Wächter.
 *
 * Steht Claude Code länger als `leerlaufMinuten` untätig und liegt ein
 * übergebener Auftrag ohne zugehörigen Report vor, wird ein „weiter mit …"
 * eingetippt. Beim ZWEITEN erfolglosen Stups zu demselben Auftrag geht
 * stattdessen eine Meldung an die operative Telegram-Rolle — danach ruht der
 * Wächter für diesen Auftrag.
 *
 * Warum nach zwei Stupsen Schluss ist: Die Zuordnung Auftrag → Report ist eine
 * Annäherung. Ein Nachtrag bekommt oft keinen eigenen Report und wäre sonst
 * ein Dauerstups. Zwei Versuche fangen den echten Stillstand; alles darüber
 * ist eine Sache für den Owner.
 *
 * Nachts gilt dasselbe — ein Stillstand um drei Uhr kostet genauso viel Zeit
 * wie einer um drei Uhr nachmittags.
 */
export async function leerlaufWaechter(opts: {
  homeDir: string;
  inboxDir?: string;
  reportDir?: string;
  zustandPfad?: string;
  now?: Date;
  runner?: TmuxRunner;
  paneText?: string;
  leerlaufMinuten?: number;
  /** Mindestabstand zwischen zwei Stupsen zum selben Auftrag. */
  stupsAbstandMinuten?: number;
  maxStupse?: number;
  melde?: (text: string) => void;
  /**
   * Eigener Weg fuer die Wartemeldung der Roten Zone.
   *
   * Sie traegt seit 14.10.2026 einen Knopf „Freigeben und übertragen". Den
   * Druck darauf muss der Prozess entgegennehmen, der die Kennung vergeben hat
   * — also das Gateway, nicht dieser Waechter. Deshalb meldet der Waechter die
   * Lage dorthin, statt den Text selbst zu formulieren. Fehlt der Weg, bleibt
   * es beim alten Textweg ueber `melde`.
   */
  meldeArm?: (w: { gegenstand?: string; zeitpunkt?: string }) => void;
  /** Hook-Protokoll. Nur für Tests — in Produktion wird ~/.claude/hooks.log gelesen. */
  hookProtokoll?: string;
  hookProtokollPfad?: string;
  /**
   * Tatsachenprüfung auf eine wartende Armierung. Wird sie nicht übergeben,
   * fragt der Wächter `arm-status` mit Git und Datenbank.
   */
  armBedarf?: () => Promise<{ wartet: boolean; gegenstand?: string; kennung?: string }>;
}): Promise<PromptInboxLauf['stups'] | { ruht: string } | { armWartung: string }> {
  const homeDir = opts.homeDir;
  const inboxDir = opts.inboxDir ?? path.join(homeDir, 'inbox');
  const reportDir = opts.reportDir ?? path.join(homeDir, 'bikosoc-spec');
  const zustandPfad = opts.zustandPfad
    ?? path.join(homeDir, '.openclaw', 'workspace', 'artifacts', 'personal',
      'prompt-inbox', 'waechter.json');
  const now = opts.now ?? new Date();
  const leerlauf = (opts.leerlaufMinuten ?? 10) * 60000;
  const abstand = (opts.stupsAbstandMinuten ?? 10) * 60000;
  const maxStupse = opts.maxStupse ?? 2;

  const zustand = ladeZustand(zustandPfad);
  const bereitschaft = pruefeBereitschaft(opts.paneText ?? lesePaneInhalt());

  // Arbeitet Claude Code oder wartet ein Dialog, ist nichts zu tun — und die
  // Leerlaufuhr beginnt danach neu.
  if (!bereitschaft.bereit) {
    if (zustand.bereitSeit) {
      delete zustand.bereitSeit;
      speichereZustand(zustandPfad, zustand);
    }
    return { ruht: grundText(bereitschaft.grund) };
  }

  /* Wartet eine Armierung, ist ein Stups sinnlos: Claude Code kann den roten
     Schritt nicht ausführen, und „weiter mit …" würde nur denselben
     blockierten Versuch wiederholen. Gebraucht wird der Owner — einmal und
     sofort, ohne die zehn Minuten Leerlauf abzuwarten. */
  const protokollPfad = opts.hookProtokollPfad
    ?? path.join(homeDir, '.claude', 'hooks.log');
  let protokoll = opts.hookProtokoll;
  if (protokoll === undefined) {
    try { protokoll = fs.readFileSync(protokollPfad, 'utf-8'); } catch { protokoll = ''; }
  }
  const arm = erkenneArmWartung(protokoll, now);
  if (arm.wartet) {
    if (zustand.armGemeldetFuer === arm.zeitpunkt) {
      return { ruht: 'Armierung wartet, bereits gemeldet' };
    }
    if (opts.meldeArm) opts.meldeArm({ gegenstand: arm.gegenstand, zeitpunkt: arm.zeitpunkt });
    else opts.melde?.(armMeldung(arm));
    zustand.armGemeldetFuer = arm.zeitpunkt;
    speichereZustand(zustandPfad, zustand);
    return { armWartung: arm.gegenstand || 'roter Pfad' };
  }

  /* Zweiter Weg über TATSACHEN statt über das Protokoll: Hat Claude Code den
     roten Schritt nie versucht, steht nichts im Protokoll. Dann zählt, ob
     ungepushte Arbeit an einem roten Pfad liegt oder eine Migrationsdatei
     ohne Eintrag in `schema_version`. Beides ist eine Abfrage mit eindeutiger
     Antwort — anders als das Durchsuchen von Berichtstexten, das auf Prosa
     anschlug und deshalb verworfen wurde. */
  const pruefung = opts.armBedarf ?? (() => pruefeArmBedarf({
    homeDir,
    dbAbfrage: async (sql) => (await dbAbfrageStandard<{ modul: string; version: number }>(sql)).rows,
  }));
  let bedarf: { wartet: boolean; gegenstand?: string; kennung?: string };
  try {
    bedarf = await pruefung();
  } catch {
    bedarf = { wartet: false };
  }
  if (bedarf.wartet) {
    const kennung = bedarf.kennung || bedarf.gegenstand || 'arm';
    if (zustand.armGemeldetFuer === kennung) {
      return { ruht: 'Armierung wartet, bereits gemeldet' };
    }
    if (opts.meldeArm) opts.meldeArm({ gegenstand: bedarf.gegenstand });
    else opts.melde?.(armMeldung({ wartet: true, gegenstand: bedarf.gegenstand }));
    zustand.armGemeldetFuer = kennung;
    speichereZustand(zustandPfad, zustand);
    return { armWartung: bedarf.gegenstand || 'roter Pfad' };
  }

  if (!zustand.bereitSeit) {
    zustand.bereitSeit = now.toISOString();
    speichereZustand(zustandPfad, zustand);
    return { ruht: 'Leerlauf beginnt gerade' };
  }

  const untaetigSeit = now.getTime() - new Date(zustand.bereitSeit).getTime();
  if (untaetigSeit < leerlauf) {
    return { ruht: `erst ${Math.round(untaetigSeit / 60000)} min untaetig` };
  }

  // Liegt noch eine Datei in der Inbox, erledigt das der normale Lauf.
  try {
    const wartend = fs.readdirSync(inboxDir).filter(n => n.endsWith('.txt') && !n.startsWith('.'));
    if (wartend.length > 0) return { ruht: 'Datei wartet in der Inbox' };
  } catch { /* Inbox fehlt — dann ist auch nichts zu tun */ }

  /* Beobachtungsbeginn: Der Wächter stupst nur Aufträge, die zugestellt wurden,
     seit er läuft. Beim ersten Lauf wird er auf die Zustellzeit des JÜNGSTEN
     Auftrags gesetzt — der gerade laufende zählt damit noch, alles Ältere nicht.
     Ohne diese Grenze holt ein frisch ausgerollter Wächter die Aufträge der
     letzten drei Tage nach, von denen er nicht weiß, wie sie ausgegangen sind. */
  const doneDir = path.join(inboxDir, 'done');
  if (!zustand.beobachtetSeit) {
    zustand.beobachtetSeit = new Date(juengsteZustellung(doneDir) ?? now.getTime()).toISOString();
    speichereZustand(zustandPfad, zustand);
  }

  const offen = offeneAuftraege({
    doneDir, reportDir, now, nichtVor: new Date(zustand.beobachtetSeit),
    routing: ladeRouting(homeDir),
  });
  if (offen.length === 0) return { ruht: 'kein offener Auftrag' };

  const ziel = offen[0];
  const bisher = zustand.stupse[ziel.kennung] || { anzahl: 0, zuletzt: '1970-01-01T00:00:00.000Z' };
  if (bisher.gemeldet) return { ruht: `Auftrag ${ziel.kennung} ist gemeldet` };
  if (now.getTime() - new Date(bisher.zuletzt).getTime() < abstand) {
    return { ruht: `Stups zu ${ziel.kennung} noch zu frisch` };
  }

  const versuch = bisher.anzahl + 1;

  if (versuch > maxStupse) {
    const text = `cc steht seit ${Math.round(untaetigSeit / 60000)} min bei Auftrag `
      + `${ziel.kennung} (uebergeben ${ziel.uebergabe.toISOString().slice(0, 16).replace('T', ' ')}), `
      + `${maxStupse} Stupse ohne Wirkung. Bitte selbst nachsehen.`;
    opts.melde?.(text);
    zustand.stupse[ziel.kennung] = { anzahl: bisher.anzahl, zuletzt: now.toISOString(), gemeldet: true };
    speichereZustand(zustandPfad, zustand);
    return { kennung: ziel.kennung, versuch: bisher.anzahl, gemeldet: true };
  }

  sendPromptToBikosocTmux(`weiter mit ${ziel.datei}`, { runner: opts.runner });
  zustand.stupse[ziel.kennung] = { anzahl: versuch, zuletzt: now.toISOString() };
  // Die Leerlaufuhr beginnt neu: Der Stups löst einen Durchgang aus.
  delete zustand.bereitSeit;
  speichereZustand(zustandPfad, zustand);
  return { kennung: ziel.kennung, versuch, gemeldet: false };
}


/**
 * Quittung einer gescheiterten Übergabe. Ein Ergebnisbericht mit Status
 * `fehler` — der Report-Watcher stellt ihn der dev-Gruppe zu. Keine
 * `uebernahme`: Die würde als „Aufgabe übernommen" erscheinen.
 */
function schreibeFehlQuittung(
  dateiname: string, text: string, annahme: Annahme, wartend: number, sperre: Date,
  k: { reportDir: string; now: Date; kanal: 'fach' | 'admin' | 'sitzung'; sitzung?: string },
): string {
  const ohneAnf = (t: string) => t.replace(/["\n\r]/g, ' ').trim();
  const grund = annahmeText(annahme);
  const titel = ohneAnf(`NICHT übergeben: ${titelAusAuftrag(text) ?? dateiname}`).slice(0, 90);
  const bis = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(sperre);
  const sitzung = k.kanal === 'admin' ? 'admin' : k.kanal === 'sitzung' ? (k.sitzung ?? '?') : 'bikosoc';
  const name = `report-prompt-inbox-nicht-uebergeben${k.kanal === 'fach' ? '' : `-${sanitizeDoneName(sitzung)}`}-${formatReportTimestamp(k.now)}.md`;
  const pfad = path.join(k.reportDir, name);
  const body = [
    '---',
    `titel: ${titel}`,
    'status: fehler',
    `aufgabe: Prompt-Inbox – NICHT übergeben: ${ohneAnf(grund)}`,
    `ergebnis: [ "Datei ${ohneAnf(dateiname)} bleibt in der Warteschlange", "Grund: ${ohneAnf(grund)}${annahme.angenommen ? '' : annahme.beleg ? ` – ${ohneAnf(annahme.beleg)}` : ''}", "neuer Versuch frühestens ${bis}, danach sobald tmux ${sitzung} bereit ist" ]`,
    `aktion: "${ohneAnf(aktionFuer(annahme))}"`,
    'tests: n/a',
    'rote_zone: nein',
    '---',
    '',
    `# Prompt-Inbox ${formatBerlinDate(k.now)} – NICHT übergeben`,
    '',
    `- Datei: ${dateiname} (bleibt in der Warteschlange)`,
    `- Grund: ${grund}`,
    annahme.angenommen || !annahme.beleg ? '' : `- Beleg (Pane): ${annahme.beleg}`,
    `- Noch dahinter in der Warteschlange: ${wartend}`,
    '',
  ].filter((z, i, a) => z !== '' || a[i - 1] !== '').join('\n');
  fs.writeFileSync(pfad, body);
  return pfad;
}


/** Quittung eines gescheiterten Autostarts (Status fehler → dev). */
function schreibeStartFehlQuittung(
  dateiname: string, regel: SitzungsRegel, grund: string, wartend: number, sperre: Date,
  k: { reportDir: string; now: Date },
): string {
  const ohneAnf = (t: string) => t.replace(/["\n\r]/g, ' ').trim();
  const bis = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(sperre);
  const name = `report-prompt-inbox-nicht-uebergeben-${sanitizeDoneName(regel.sitzung)}-${formatReportTimestamp(k.now)}.md`;
  const pfad = path.join(k.reportDir, name);
  const body = [
    '---',
    `titel: ${ohneAnf(`NICHT übergeben an ${regel.sitzung}: Autostart gescheitert`).slice(0, 90)}`,
    'status: fehler',
    `aufgabe: Prompt-Inbox – Autostart der Sitzung ${regel.sitzung} gescheitert`,
    `ergebnis: [ "Datei ${ohneAnf(dateiname)} bleibt in der Warteschlange", "Grund: ${ohneAnf(grund)}", "neuer Versuch frühestens ${bis}" ]`,
    `aktion: "tmux-Sitzung ${regel.sitzung} prüfen (tmux attach -t ${regel.sitzung}); die Datei wird danach selbst erneut zugestellt."`,
    'tests: n/a',
    'rote_zone: nein',
    '---',
    '',
    `# Prompt-Inbox ${formatBerlinDate(k.now)} – Autostart ${regel.sitzung} gescheitert`,
    '',
    `- Datei: ${dateiname} (bleibt in der Warteschlange)`,
    `- Ziel: ${regel.sitzung} in ${regel.verzeichnis}`,
    `- Grund: ${grund}`,
    `- Noch dahinter in der Warteschlange: ${wartend}`,
    '',
  ].join('\n');
  fs.writeFileSync(pfad, body);
  return pfad;
}

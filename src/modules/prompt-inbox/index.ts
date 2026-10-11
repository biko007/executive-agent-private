import fs from 'node:fs';
import path from 'node:path';
import {
  sendPromptToBikosocTmux, lesePaneInhalt, type TmuxRunner,
} from '../cc-prompt-dispatch/index.js';
import {
  pruefeBereitschaft, grundText, auftragsKennung,
  type Bereitschaft,
} from './bereitschaft.js';

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
}

function ladeZustand(pfad: string): WaechterZustand {
  try {
    const z = JSON.parse(fs.readFileSync(pfad, 'utf-8'));
    return { bereitSeit: z.bereitSeit, stupse: z.stupse || {} };
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
}): { datei: string; kennung: string; uebergabe: Date }[] {
  const maxAlter = (opts.maxAlterTage ?? 3) * 86400000;
  let dateien: string[] = [];
  let berichte: string[] = [];
  try { dateien = fs.readdirSync(opts.doneDir); } catch { return []; }
  try { berichte = fs.readdirSync(opts.reportDir); } catch { berichte = []; }

  const offen: { datei: string; kennung: string; uebergabe: Date }[] = [];
  for (const datei of dateien) {
    if (!datei.endsWith('.txt')) continue;
    const kennung = auftragsKennung(datei);
    if (!kennung) continue;
    let st: fs.Stats;
    try { st = fs.statSync(path.join(opts.doneDir, datei)); } catch { continue; }
    if (opts.now.getTime() - st.mtimeMs > maxAlter) continue;

    // Quittungen des Pollers selbst sind keine Aufträge.
    if (/^prompt-inbox/.test(kennung)) continue;

    const hatReport = berichte.some(b =>
      b.startsWith(`report-${kennung}-`) && b.endsWith('.md'));
    if (!hatReport) offen.push({ datei, kennung, uebergabe: new Date(st.mtimeMs) });
  }
  return offen.sort((a, b) => a.uebergabe.getTime() - b.uebergabe.getTime());
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
  /** Prüfung abschalten. Nur für Tests der alten Reihenfolge. */
  ohneBereitschaftspruefung?: boolean;
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

  const bereitschaft: Bereitschaft = opts.ohneBereitschaftspruefung
    ? { bereit: true }
    : pruefeBereitschaft(opts.paneText ?? lesePaneInhalt());

  if (!bereitschaft.bereit) {
    for (const k of kandidaten) {
      lauf.zurueckgestellt.push({
        sourcePath: k.p,
        grund: grundText(bereitschaft.grund),
        beleg: bereitschaft.beleg,
      });
    }
    return lauf;
  }

  // Genau eine Datei zustellen.
  const [erste, ...rest] = kandidaten;
  const text = fs.readFileSync(erste.p, 'utf-8');
  sendPromptToBikosocTmux(text, { runner: opts.runner });

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const donePath = path.join(doneDir, `${stamp}-${sanitizeDoneName(erste.name)}`);
  fs.renameSync(erste.p, donePath);

  const reportDate = formatBerlinDate(now);
  const reportStamp = formatReportTimestamp(now);
  const reportPath = path.join(reportDir, `report-prompt-inbox-${reportStamp}.md`);
  const body = [
    `# Prompt-Inbox ${reportDate}`,
    '',
    '## Übergabe',
    '',
    `- Datei: ${erste.name}`,
    `- Verschoben nach: ${donePath}`,
    '- Status: Prompt uebergeben (Claude Code war aufnahmebereit).',
    rest.length > 0
      ? `- Noch in der Warteschlange: ${rest.length} (${rest.map(r => r.name).join(', ')})`
      : '- Noch in der Warteschlange: keine',
    '',
    '## Nutzung',
    '',
    '- Telegram: `/do <text>`',
    '- Datei-Drop: `.txt` nach `~/inbox/` legen; Verarbeitung per systemd-user-Timer.',
    '- Zustellung erfolgt nur, wenn Claude Code gerade nichts abarbeitet; sonst',
    '  bleibt die Datei liegen und wird beim naechsten Lauf erneut geprueft.',
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
  return lauf;
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
export function leerlaufWaechter(opts: {
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
}): PromptInboxLauf['stups'] | { ruht: string } {
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

  const offen = offeneAuftraege({
    doneDir: path.join(inboxDir, 'done'), reportDir, now,
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

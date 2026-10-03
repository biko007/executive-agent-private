import { execFileSync } from 'node:child_process';

export type TmuxRunner = (file: string, args: string[], options?: { timeout?: number }) => void;

const DEFAULT_TMUX_TARGET = 'bikosoc';

/**
 * Pause zwischen Text und Enter.
 *
 * 400 ms, damit die Oberfläche den eingefügten Text sicher verarbeitet hat,
 * bevor der Wagenrücklauf eintrifft. Der bereits vorhandene Bypass-Pfad in
 * index.ts arbeitet mit 300 ms; etwas mehr Luft kostet nichts, weil der
 * Versand ohnehin nur einmal pro Auftrag stattfindet.
 */
const DEFAULT_ENTER_DELAY_MS = 400;

function defaultRunner(file: string, args: string[], options?: { timeout?: number }): void {
  execFileSync(file, args, {
    stdio: 'ignore',
    timeout: options?.timeout,
  });
}

/**
 * Blockierende Pause ohne Unterprozess und ohne Leerlaufschleife.
 *
 * `sendPromptToBikosocTmux` ist synchron und wird aus synchronen Aufrufern
 * heraus benutzt (Telegram-Handler, Prompt-Inbox-Poller). Ein Wechsel auf
 * async würde sich durch beide Kontrollflächen ziehen — bei C7-Pflicht für
 * jede Änderung daran die teurere Variante. `Atomics.wait` auf einem nicht
 * geteilten Puffer schläft definiert und belastet die CPU nicht.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * Einen Prompt an die tmux-Sitzung von Claude Code übergeben und abschicken.
 *
 * **Warum zwei getrennte send-keys-Aufrufe statt einem.**
 *
 * Bis 2026-10-03 lautete der Aufruf
 * `tmux send-keys -t <ziel> -- "<text>" Enter`. tmux schickt dabei Text und
 * Wagenrücklauf in **einem** Schub an das Programm im Pane. Nachgemessen mit
 * einem Protokollierer im Rohmodus:
 *
 *   ein Aufruf   → ein Leseschub:  "PROMPT-A\r"   (9 Byte)
 *   zwei Aufrufe → zwei Schübe:    "PROMPT-B", dann "\r"
 *
 * Für eine Shell ist beides gleichwertig — deshalb fiel der Fehler in den
 * bisherigen Tests nicht auf, die gegen eine Shell prüften. Eine TUI wie
 * Claude Code unterscheidet dagegen: ein Schub, der Text **und**
 * Wagenrücklauf enthält, ist ein Einfügevorgang und erzeugt einen Zeilenumbruch
 * im Eingabefeld; erst ein Wagenrücklauf in einem **eigenen** Schub ist ein
 * Tastendruck, der abschickt.
 *
 * Praktische Folge des Defekts: Datei-Drops nach `~/inbox/` und `/do <text>`
 * trugen den Auftrag in das Eingabefeld ein, schickten ihn aber nicht ab. Der
 * Poller verschob die Datei trotzdem nach `done/` und meldete „Prompt
 * uebergeben" — der Auftrag blieb unbemerkt liegen. Belegt am 2026-10-03 durch
 * `~/inbox/done/2026-10-03T19-51-20-907Z-wiki-import.txt`: verarbeitet, aber
 * nie ausgeführt.
 *
 * Derselbe Zweischritt wird im Bypass-Pfad (`index.ts`) bereits verwendet; die
 * Übergabe hatte ihn nur nie bekommen.
 */
export function sendPromptToBikosocTmux(
  text: string,
  opts: {
    runner?: TmuxRunner;
    target?: string;
    timeoutMs?: number;
    /** Pause zwischen Text und Enter in Millisekunden. 0 nur für Tests. */
    enterDelayMs?: number;
  } = {},
): void {
  if (!text.trim()) {
    throw new Error('Prompt ist leer.');
  }

  const runner = opts.runner ?? defaultRunner;
  const target = opts.target ?? DEFAULT_TMUX_TARGET;
  const timeout = opts.timeoutMs ?? 5000;
  const enterDelay = opts.enterDelayMs ?? DEFAULT_ENTER_DELAY_MS;

  // Schritt 1: Text einfügen. Der `--`-Trenner verhindert, dass ein Text, der
  // mit `-` beginnt, als tmux-Option gedeutet wird (Injektionsschutz).
  runner('tmux', ['send-keys', '-t', target, '--', text], { timeout });

  // Schritt 2: Wagenrücklauf als eigener Schub — das ist der Tastendruck.
  sleepSync(enterDelay);
  runner('tmux', ['send-keys', '-t', target, 'Enter'], { timeout });
}

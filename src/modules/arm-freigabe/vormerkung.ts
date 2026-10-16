/**
 * Die Vormerkung — was als Nächstes freizugeben ist.
 *
 * ANLASS (Owner, 16.10.2026): „/arm vs. /arm push klären". Die Diagnose ergab,
 * dass beide Varianten dieselbe Freigabe setzen — der Unterschied liegt allein
 * darin, ob die wartende Sitzung angestoßen wird. Der Owner konnte das nicht
 * wissen, weil die Quittung nur „Freigabe gesetzt" sagte, aber nie, WOFÜR.
 *
 * Damit die Antwort das sagen kann, braucht der Bot eine Angabe, die er selbst
 * nicht hat: welcher rote Schritt gerade wartet. Nur cc weiß das. cc legt sie
 * deshalb ab, wenn es vor einem roten Schritt stehen bleibt; der Bot liest sie
 * beim nächsten `/arm`.
 *
 * BEWUSST EINE DATEI, keine Tabelle und kein Dienst. Der Zustand ist ein
 * einziger Satz, lebt Minuten bis Stunden und darf bei einem Neustart
 * verlorengehen — dann fällt die Antwort auf den allgemeinen Text zurück, und
 * die Freigabe wirkt unverändert. Die Vormerkung ist eine Beschriftung, kein
 * Sicherheitsmerkmal: Sie erweitert keine Befugnis und ersetzt keine Prüfung.
 * Über die Freigabe entscheiden weiterhin allein Hook und Flag.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

/** Pfad der Vormerkung zu einem Strang-Flag (`~/.armed-bikosoc` → `…​.vormerkung`). */
export function vormerkungPfad(flagPfad: string): string {
  return `${flagPfad}.vormerkung`;
}

export interface Vormerkung {
  /** Was freigegeben wird, in einem Satz und in Owner-Sprache. */
  schritt: string;
  /**
   * Das Wort, das die wartende Sitzung anstößt. „push" für eine Übertragung,
   * „weiter" für alles andere. Leer = nichts anstoßen, nur freigeben.
   */
  anstoss: string;
  /** Wann cc sie abgelegt hat, in Millisekunden. */
  gestellt: number;
}

/**
 * Wie lange eine Vormerkung gilt.
 *
 * Großzügig, weil sie nichts freigibt — aber nicht unbegrenzt: Eine Woche alte
 * Beschriftung würde dem Owner einen Schritt nennen, den längst niemand mehr
 * vorhat. Dann lieber keine Angabe als eine falsche.
 */
export const VORMERKUNG_TTL_MS = 24 * 60 * 60 * 1000;

/** Höchstlänge des Satzes — die Quittung ist eine Telegram-Nachricht. */
export const SCHRITT_MAX = 200;

/** Erlaubte Anstoßwörter. Alles andere wäre eine Eingabe in eine fremde Sitzung. */
export const ANSTOSS_ERLAUBT = ['push', 'weiter', ''] as const;

/**
 * Die Vormerkung lesen. `null`, wenn keine da, unlesbar oder zu alt.
 *
 * Fehler werden geschluckt, nicht geworfen: Eine kaputte Beschriftung darf die
 * Freigabe nicht verhindern — sonst hätte eine unwichtige Datei Macht über den
 * wichtigen Vorgang.
 */
export function vormerkungLesen(
  flagPfad: string, jetzt: number = Date.now(),
): Vormerkung | null {
  const p = vormerkungPfad(flagPfad);
  try {
    if (!existsSync(p)) return null;
    const roh = JSON.parse(readFileSync(p, 'utf-8')) as Partial<Vormerkung>;
    const schritt = String(roh.schritt ?? '').trim();
    const gestellt = Number(roh.gestellt ?? 0);
    if (!schritt || !Number.isFinite(gestellt) || gestellt <= 0) return null;
    if (jetzt - gestellt > VORMERKUNG_TTL_MS) return null;
    const anstoss = String(roh.anstoss ?? '').trim().toLowerCase();
    return {
      schritt: schritt.slice(0, SCHRITT_MAX),
      anstoss: (ANSTOSS_ERLAUBT as readonly string[]).includes(anstoss) ? anstoss : '',
      gestellt,
    };
  } catch {
    return null;
  }
}

/**
 * Eine Vormerkung ablegen. Wirft bei unbrauchbarer Eingabe — hier ist ein
 * Fehler richtig, denn der Aufrufer ist cc und kann ihn beheben.
 */
export function vormerkungSchreiben(
  flagPfad: string, schritt: string, anstoss: string = 'weiter',
  jetzt: number = Date.now(),
): Vormerkung {
  const s = String(schritt || '').trim();
  if (!s) throw new Error('Vormerkung: der Schritt darf nicht leer sein.');
  const a = String(anstoss || '').trim().toLowerCase();
  if (!(ANSTOSS_ERLAUBT as readonly string[]).includes(a)) {
    throw new Error(`Vormerkung: Anstoss "${a}" nicht erlaubt (push, weiter oder leer).`);
  }
  const v: Vormerkung = { schritt: s.slice(0, SCHRITT_MAX), anstoss: a, gestellt: jetzt };
  writeFileSync(vormerkungPfad(flagPfad), JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  return v;
}

/** Die Vormerkung entfernen. Still, wenn keine da ist. */
export function vormerkungLoeschen(flagPfad: string): void {
  try { unlinkSync(vormerkungPfad(flagPfad)); } catch { /* war nicht da */ }
}

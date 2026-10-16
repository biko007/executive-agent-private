/**
 * Die Freigabe der Roten Zone — Texte, Knopf und Berechtigungspruefung.
 *
 * ANLASS (Owner, 14.10.2026): Im Chat stand „Armed + push dispatched." und als
 * Handlungsanweisung eine rohe URL
 * `https://t.me/share/url?url=%2Farm%20push`. Unklar blieb ausserdem, was
 * `/arm` allein gegenueber `/arm push` bewirkt — der Owner hat um 13:44 nur
 * `/arm` gesendet, weil die Meldung von 13:05 das nicht sagte.
 *
 * WAS SICH AENDERT
 *   - Deutsch, Telegram-HTML, Symbol und fetter Titel in der ersten Zeile.
 *   - Die Wartemeldung traegt einen Knopf „Freigeben und übertragen". Er loest
 *     dasselbe aus wie `/arm push`.
 *   - `/arm` allein sagt jetzt ausdruecklich, was es tut und was nicht.
 *
 * WAS SICH NICHT AENDERT — die Sicherheit
 *   - Nur der hinterlegte Owner darf den Knopf benutzen; jede andere
 *     Telegram-Benutzerkennung wird abgewiesen (`pruefeKnopf`).
 *   - Der Knopf gilt genau einmal: Die Kennung wird beim ersten Druck
 *     verbraucht (`verbraucht`), ein zweiter Druck laeuft ins Leere.
 *   - Die Freigabe selbst verfaellt unveraendert nach ARM_TTL_SEK Sekunden;
 *     darueber entscheidet weiterhin der Hook, nicht dieses Modul.
 *   - Nach Benutzung wird der Knopf entfernt und die Nachricht neu geschrieben.
 */
import { systemNachricht, freigabeZeile, uhrzeit } from '../system-telegram/index.js';

/** Lebensdauer einer Freigabe in Sekunden — Spiegel von ARM_TTL im Deny-Hook. */
export const ARM_TTL_SEK = 900;

/** Praefix der callback_data. Muss zu CALLBACK_PREFIXES in index.ts passen. */
export const KNOPF_PRAEFIX = 'armpush_';

/** Zeitpunkt, zu dem eine jetzt gesetzte Freigabe verfaellt. */
export function ablaufZeitpunkt(jetzt: Date | number = Date.now()): number {
  const t = typeof jetzt === 'number' ? jetzt : jetzt.getTime();
  return t + ARM_TTL_SEK * 1000;
}

/* ── Texte ────────────────────────────────────────────────────────────────── */

/**
 * Antwort auf `/arm` — ohne Argument wie mit `push`.
 *
 * GEAENDERT AM 16.10.2026. Bis dahin sagte die Quittung nur „Freigabe gesetzt"
 * und liess offen, WOFUER. Der Owner musste raten, ob `/arm` fuer eine
 * Migration, einen Push oder einen Neustart genuegt — und ob er `/arm push`
 * haette senden muessen. Jetzt nennt die Antwort den Schritt, sofern cc ihn
 * vorgemerkt hat, und sagt, was als Naechstes laeuft.
 *
 * @param schritt  Der vorgemerkte rote Schritt, oder null.
 * @param gestartet Wurde die wartende Sitzung angestossen?
 */
export function freigabeGesetztText(
  ablauf: Date | number, schritt: string | null, gestartet: boolean,
): string {
  const zeilen = schritt
    ? [`freigegeben: ${schritt}`]
    : ['gilt für den nächsten roten Schritt'];
  zeilen.push(gestartet
    ? 'cc führt ihn jetzt aus'
    : 'cc führt ihn beim nächsten Schritt aus');
  return systemNachricht({
    lage: gestartet ? 'ok' : 'freigabe',
    titel: gestartet ? 'Freigegeben und gestartet' : 'Freigabe gesetzt',
    zeilen,
    fuss: [freigabeZeile(ablauf)],
  });
}

/** Antwort auf `/arm push` und auf den Knopf, wenn nichts vorgemerkt ist. */
export function uebertragungGestartetText(ablauf: Date | number): string {
  return systemNachricht({
    lage: 'ok',
    titel: 'Freigegeben und gestartet',
    zeilen: ['die wartende Übertragung läuft'],
    fuss: [freigabeZeile(ablauf)],
  });
}

/** Die Freigabe steht, aber der Anstoss an die Sitzung schlug fehl. */
export function startFehlgeschlagenText(grund: string): string {
  return systemNachricht({
    lage: 'fehler',
    titel: 'Start fehlgeschlagen',
    zeilen: ['die Freigabe ist gesetzt', 'die Sitzung hat den Anstoß nicht angenommen'],
    fuss: [`Grund: ${grund}`, 'Bitte „push" in der Sitzung selbst eingeben.'],
  });
}

/** Fremde Benutzerkennung am Knopf. */
export function nichtOwnerText(): string {
  return systemNachricht({
    lage: 'fehler',
    titel: 'Nicht freigegeben',
    zeilen: ['dieser Knopf gehört zum Owner-Konto'],
  });
}

/** Zweiter Druck auf denselben Knopf. */
export function verbrauchtText(): string {
  return systemNachricht({
    lage: 'hinweis',
    titel: 'Knopf schon benutzt',
    zeilen: ['die Freigabe wurde bereits erteilt'],
  });
}

/** Falsche Nutzung von /arm. */
/* Seit 16.10.2026 sind beide gleichwertig; `push` bleibt nur, damit aeltere
   Texte und der Knopf weiter stimmen. */
export const NUTZUNG_TEXT = 'Nutzung: /arm  (oder gleichbedeutend /arm push)';

/* ── Knopf ────────────────────────────────────────────────────────────────── */

/**
 * Das Inline-Keyboard der Wartemeldung.
 *
 * Telegram begrenzt callback_data auf 64 Byte. Die Kennung ist deshalb kurz
 * und traegt keine Nutzdaten — sie zeigt nur auf den Eintrag im Server.
 */
export function knopfMarkup(kennung: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [[{
      text: '🔓 Freigeben und übertragen',
      callback_data: `${KNOPF_PRAEFIX}${kennung}`.slice(0, 64),
    }]],
  };
}

export interface KnopfPruefung {
  /** Kennung aus der callback_data. */
  kennung: string;
  /** Kennung, die der Server zuletzt vergeben hat. */
  erwartet: string | null;
  /** Telegram-Benutzerkennung des Druckenden. */
  senderId: string;
  /** Telegram-Benutzerkennung des hinterlegten Owners. */
  ownerId: string | null;
  /** Wurde die Kennung schon eingeloest? */
  verbraucht: boolean;
}

export type KnopfErgebnis =
  | { ok: true }
  | { ok: false; grund: 'fremder_nutzer' | 'unbekannt' | 'verbraucht'; antwort: string };

/**
 * Darf dieser Druck die Freigabe setzen?
 *
 * Reihenfolge ist Absicht: Erst der Nutzer, dann die Kennung. Ein Fremder soll
 * nicht aus der Antwort ablesen koennen, ob eine Freigabe aussteht.
 */
export function pruefeKnopf(p: KnopfPruefung): KnopfErgebnis {
  const sender = String(p.senderId || '').trim();
  const owner = String(p.ownerId || '').trim();
  if (!owner || !sender || sender !== owner) {
    return { ok: false, grund: 'fremder_nutzer', antwort: nichtOwnerText() };
  }
  if (!p.erwartet || !p.kennung || p.kennung !== p.erwartet) {
    return { ok: false, grund: 'unbekannt', antwort: verbrauchtText() };
  }
  if (p.verbraucht) {
    return { ok: false, grund: 'verbraucht', antwort: verbrauchtText() };
  }
  return { ok: true };
}

/** Text, der nach erfolgreicher Benutzung an die Stelle der Wartemeldung tritt. */
export function knopfErledigtText(ablauf: Date | number): string {
  return systemNachricht({
    lage: 'ok',
    titel: 'Freigegeben und gestartet',
    zeilen: ['die wartende Übertragung läuft'],
    fuss: [`🔓 Freigabe genutzt um ${uhrzeit(Date.now())}`, `gültig gewesen bis ${uhrzeit(ablauf)}`],
  });
}

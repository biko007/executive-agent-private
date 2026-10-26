/**
 * briefing/mail — Versand des Abendbriefings per Mail.
 *
 * ════════════════════════════════════════════════════════════════════════
 * AUSNAHME VON DER ENTWURFSREGEL (Owner-Freigabe 26.10.2026, Option A)
 *
 * Stehende Regel seit 19.10.2026: Agenten legen Mails nur als ENTWURF an und
 * senden nie. Diese Datei ist die EINZIGE Ausnahme, und sie ist bewusst eng:
 *
 *   - nur das Abendbriefing (diese eine Funktion, kein allgemeiner Versandweg),
 *   - nur an das eigene M365-Postfach des Owners — der Empfänger ist eine
 *     Konstante in dieser Datei, KEIN Parameter, nicht aus Einstellungen,
 *     Umgebung oder Nachrichtentext steuerbar,
 *   - nur über Microsoft Graph sendMail aus demselben Postfach.
 *
 * Wer hier einen zweiten Empfänger, einen Empfängerparameter oder einen
 * weiteren Mailtyp ergänzen will, braucht eine neue Owner-Freigabe. Der Test
 * `briefing.test.ts` hält fest, dass genau ein fester Empfänger verwendet wird.
 * Dokumentiert in CLAUDE.md §8 („Abendbriefing per Mail").
 * ════════════════════════════════════════════════════════════════════════
 */

/** Das eigene M365-Postfach des Owners. Fest verdrahtet — siehe oben. */
export const ABENDBRIEFING_EMPFAENGER = 'juergen.bickel@bikolino.com';

/** Graph-POST, vom Gateway übergeben (im Test ein Mock). */
export type GraphPost = (url: string, body: unknown) => Promise<unknown>;

export interface AbendMail {
  betreff: string;
  text: string;
}

/**
 * Betreff des Abendbriefings. `test` setzt die Kennzeichnung [TEST] davor —
 * für den einen verifizierten End-to-End-Lauf.
 */
export function abendBetreff(datumKurz: string, test = false): string {
  return `${test ? '[TEST] ' : ''}Abendbriefing ${datumKurz}`;
}

/** Der Graph-Aufruf als reine Datenstruktur — testbar ohne Netz. */
export function abendMailAnfrage(mail: AbendMail): { url: string; body: any } {
  const postfach = encodeURIComponent(ABENDBRIEFING_EMPFAENGER);
  return {
    // Gesendet wird AUS dem eigenen Postfach AN das eigene Postfach.
    url: `https://graph.microsoft.com/v1.0/users/${postfach}/sendMail`,
    body: {
      message: {
        subject: mail.betreff,
        body: { contentType: 'Text', content: mail.text },
        toRecipients: [{ emailAddress: { address: ABENDBRIEFING_EMPFAENGER } }],
      },
      saveToSentItems: true,
    },
  };
}

/** Abendbriefing an das eigene Postfach senden. Wirft bei Graph-Fehlern. */
export async function sendeAbendbriefingMail(graphPost: GraphPost, mail: AbendMail): Promise<void> {
  const { url, body } = abendMailAnfrage(mail);
  await graphPost(url, body);
}

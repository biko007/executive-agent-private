/**
 * Wohin welche Nachricht geht.
 *
 * ANLASS (Owner, 16.10.2026): „Der Chat fühlt sich nicht mehr wie ein
 * Assistent an." Die Bestandsaufnahme über sieben Tage gab ihm recht —
 * **30 von 31** ausgehenden Nachrichten landeten im Owner-DM, davon zwanzig
 * reine Freigabequittungen. Genau eine ging in die Dev-Gruppe.
 *
 * Seitdem gilt die Trennung aus Cowork-Platform.md § 7:
 *
 *   Dev-Gruppe  Entwicklung und Betrieb — Freigaben, Hooks, Übertragungen,
 *               Reports, Selbsttests, cc-Fortschritt
 *   Owner-DM    Gespräch, Briefing, operative Alarme mit Handlungsbedarf,
 *               ausdrücklich angeforderte Antworten
 *
 * Diese Tests prüfen die Entscheidung an der Quelle: an den Sendestellen in
 * index.ts und an der Vorgabe von `notify-system`. Ein Laufzeittest bräuchte
 * Telegram; der Fehler war aber einer der ZUORDNUNG, und genau die steht
 * hier.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const WURZEL = path.resolve(import.meta.dir, '..', '..');
const quelle = fs.readFileSync(path.join(WURZEL, 'index.ts'), 'utf-8');
const notify = fs.readFileSync(path.join(WURZEL, 'ops', 'bin', 'notify-system'), 'utf-8');

/** Den Block eines registrierten Befehls herausschneiden. */
function befehl(name: string): string {
  const start = quelle.indexOf(`    name: '${name}',`);
  expect(start, name).toBeGreaterThan(-1);
  const naechster = quelle.indexOf("    name: '", start + 20);
  return quelle.slice(start, naechster > -1 ? naechster : quelle.length);
}

describe('Ein Ziel für alle Plattformmeldungen', () => {
  test('es gibt genau einen Helfer dafür', () => {
    const treffer = quelle.match(/function plattformZiel\(\)/g) ?? [];
    expect(treffer).toHaveLength(1);
  });

  test('er zielt auf die Dev-Gruppe und fällt auf den DM zurück', () => {
    /* Der Rückfall ist Absicht: Eine verschluckte Freigabemeldung wäre
       schlimmer als eine an der falschen Stelle. */
    expect(quelle).toContain("getCachedTelegramTarget('dev', { fallbackToOperativ: true })");
  });
});

describe('Freigabe-Meldungen gehen in die Dev-Gruppe', () => {
  const arm = befehl('arm');

  test('die Quittung nicht mehr in den Chat des Absenders', () => {
    expect(arm).toContain('const ziel = plattformZiel();');
    /* Der frühere Weg schickte sie dorthin, wo der Befehl herkam — im
       Regelfall also in den Owner-DM. */
    expect(arm).not.toContain('sendTelegramHtmlWithMarkup(guard.chatId, text');
  });

  test('auch die Fehlermeldung des Anstoßes', () => {
    expect(arm).toContain('const fehlerZiel = plattformZiel();');
  });

  test('im DM bleibt nichts zurück', () => {
    /* `stillBeantwortet()` setzt suppressReply: Der Kern schiebt keinen
       Ersatztext nach, und der DM bleibt leer. */
    expect(arm).toContain('return stillBeantwortet();');
  });

  test('die Wartemeldung mit Knopf ebenfalls', () => {
    const block = quelle.slice(quelle.indexOf("path: '/api/internal/arm-wartet'"));
    expect(block.slice(0, 2000)).toContain('const chatId = plattformZiel();');
  });

  test('der Knopf antwortet dort, wo er steht', () => {
    const block = quelle.slice(quelle.indexOf('const armCb = parseCallbackEvent'),
      quelle.indexOf('const memdropCb = parseCallbackEvent'));
    expect(block).toContain('plattformZiel() ?? chatId');
  });
});

describe('Kontrollbefehle melden in die Dev-Gruppe', () => {
  test('/ccstop und /ccgo nicht mehr an operativ', () => {
    for (const name of ['ccstop', 'ccgo']) {
      const b = befehl(name);
      expect(b, name).not.toContain("notifyRoleUnlessOrigin('operativ'");
    }
  });

  test('die Umstellung ist vollständig', () => {
    expect(quelle).not.toContain("notifyRoleUnlessOrigin('operativ', guard.chatId");
    expect((quelle.match(/notifyRoleUnlessOrigin\('dev', guard\.chatId/g) ?? []).length)
      .toBeGreaterThanOrEqual(4);
  });
});

describe('Was ausdrücklich im Owner-DM bleibt', () => {
  /* Die Gegenprobe. Eine Trennung, die zu viel verschiebt, ist genauso
     falsch wie gar keine: Dann verpasst der Owner, was er sehen muss. */
  test('die Standortquittung', () => {
    expect(quelle).toContain("sendTelegramToRole('operativ', `📍 Standort gespeichert");
  });

  test('das Ergebnis einer Delegation', () => {
    expect(quelle).toContain("notifyOperativ: (text: string) => sendTelegramToRole('operativ', text)");
  });
});

describe('notify-system — die Hook-Meldungen', () => {
  test('Vorgabe ist dev, nicht operativ', () => {
    /* Hierüber laufen „Freigabe genutzt", „Übertragen", „Wartet auf Ihre
       Freigabe" und die Blockaden des Hooks. Alles Plattform. */
    expect(notify).toContain('ROLLE="dev"');
    expect(notify).not.toMatch(/^ROLLE="operativ"$/m);
  });

  test('der Weg zum Owner bleibt offen', () => {
    /* Wer ihn wirklich erreichen muss, sagt es ausdrücklich. */
    expect(notify).toContain('--rolle');
    expect(notify).toContain('operativ');
  });

  test('Repo und ausgespielte Fassung sind gleich', () => {
    const live = fs.readFileSync(path.join(process.env.HOME!, 'bin', 'notify-system'), 'utf-8');
    expect(live).toBe(notify);
  });
});

describe('Sofort-Kurz-Audit: Befehle in der Gruppe', () => {
  test('der Owner-Guard prüft Chat UND Benutzer', () => {
    /* Entscheidend für die Dev-Gruppe: Dort sitzen potenziell mehrere
       Personen. Die Bindung nennt einen Chat und EINEN Benutzer; nur deren
       Paarung gilt. Ein fremdes Mitglied löst nichts aus. */
    const bind = fs.readFileSync(
      path.join(WURZEL, 'src', 'modules', 'telegram-binding', 'index.ts'), 'utf-8');
    expect(bind).toContain('export async function isBoundTelegramOwner(chatId: string, userId: string)');
    expect(bind).toContain('binding.telegramUserId === userId');
  });

  test('jeder sicherheitsrelevante Befehl geht durch den Guard', () => {
    for (const name of ['arm', 'ccstop', 'ccgo', 'do', 'report']) {
      expect(befehl(name), name).toContain('assertBoundOwner');
    }
  });

  test('beim /arm steht der Guard vor jeder Wirkung', () => {
    const arm = befehl('arm');
    expect(arm.indexOf('assertBoundOwner')).toBeLessThan(arm.indexOf('plattformZiel'));
    expect(arm.indexOf('assertBoundOwner')).toBeLessThan(arm.indexOf('writeFileSync'));
  });
});

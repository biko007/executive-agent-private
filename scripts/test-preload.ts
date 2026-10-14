/**
 * Warnbanner fuer einen blanken `bun test`-Lauf.
 *
 * ANLASS (Owner, 14.10.2026): Ein Report nannte „Gesamtlauf 1.274 gruen,
 * 24 rot" und behauptete, die 24 seien vorbestehend. Beides war irrefuehrend.
 * Das Gate dieses Projekts ist `npm test` — scripts/run-tests.sh startet JEDE
 * Testdatei in einem EIGENEN bun-Prozess. Dort sind es 1.298 gruen, 0 rot.
 *
 * WARUM EIN BLANKER LAUF ROT WIRD: Rund zwanzig Testdateien setzen auf
 * Modulebene `process.env.POSTGRES_URL` auf eine eigene Wegwerf-Datenbank und
 * raeumen sie am Ende ab. In EINEM gemeinsamen Prozess gewinnt die zuletzt
 * geladene Datei; die anderen zeigen dann auf eine Datenbank, die es nicht
 * mehr gibt — „database … does not exist". Das ist kein Fehler im Code,
 * sondern die Eigenschaft, derentwegen es den isolierten Laeufer gibt.
 *
 * Dieses Banner macht den Unterschied sichtbar, damit niemand die Zahlen eines
 * blanken Laufs wieder fuer das Ergebnis des Gates haelt.
 */
if (!process.env.OPENCLAW_TEST) {
  // eslint-disable-next-line no-console
  console.error(
    '\n────────────────────────────────────────────────────────────\n'
    + '  ACHTUNG: `bun test` ist NICHT das Gate dieses Projekts.\n'
    + '  Alle Dateien laufen hier in EINEM Prozess; rund zwanzig\n'
    + '  Testdateien setzen dabei dieselbe Umgebungsvariable\n'
    + '  POSTGRES_URL um. Rote Tests aus diesem Lauf sind deshalb\n'
    + '  kein Befund.\n\n'
    + '  Das Gate ist:  npm test   (scripts/run-tests.sh,\n'
    + '                             ein Prozess je Testdatei)\n'
    + '────────────────────────────────────────────────────────────\n',
  );
}

# `/arm` — die Freigabe der Roten Zone

**Stand 16.10.2026.** Ersetzt alle früheren Beschreibungen des Unterschieds
zwischen `/arm` und `/arm push`.

---

## Die Regel in einem Satz

**Senden Sie `/arm`.** Das gibt den nächsten roten Schritt für 15 Minuten frei,
genau einmal, und startet ihn.

`/arm push` bedeutet dasselbe. Es bleibt erhalten, damit ältere Texte und der
Knopf an der Wartemeldung weiter stimmen — ein zweiter Befehl ist es nicht.

---

## Warum es diese Klärung brauchte

Bis zum 16.10.2026 gab es zwei Schreibweisen mit einem Unterschied, den die
Quittung nicht erklärte:

| | `/arm` | `/arm push` |
|---|---|---|
| Flag `~/.armed-bikosoc` | gesetzt | gesetzt |
| Inhalt, Frist, Einmaligkeit | identisch | identisch |
| wartende Sitzung angestoßen | **nein** | ja |

Die Freigabe war in beiden Fällen **dieselbe**. Es gab keinen roten Schritt,
den `/arm push` freigab und `/arm` nicht. Der einzige Unterschied war, ob das
Wort „push" in die wartende Sitzung getippt wurde — und das stand nirgends.

Am 14.10.2026 hat der Owner deshalb `/arm` gesendet, wo `/arm push` gemeint
war, und die Übertragung blieb liegen.

---

## Was jetzt gilt

`/arm` tut drei Dinge, in dieser Reihenfolge:

1. **Freigeben.** Das Flag `~/.armed-bikosoc` wird gesetzt: 15 Minuten gültig
   (`ARM_TTL`, Vorgabe 900 s), für **genau einen** roten Schritt.
2. **Starten.** Der wartende Schritt wird angestoßen — aber nur, wenn er
   angemeldet ist (siehe unten). Ist nichts angemeldet, bleibt es beim
   Freigeben.
3. **Quittieren.** Die Telegram-Antwort nennt den Schritt im Klartext und
   sagt, ob cc ihn jetzt ausführt oder beim nächsten Mal.

**Ein Tippfehler bleibt wirkungslos.** Jedes Argument außer `push` setzt
nichts, startet nichts und meldet die Nutzung — auch dann, wenn ein roter
Schritt angemeldet ist.

---

## Was „angemeldet" heißt

Der Bot weiß von sich aus nicht, ob gerade eine Migration, eine Übertragung
oder ein Neustart ansteht. Nur cc weiß das. cc legt den Schritt deshalb in
einem Satz ab, wenn es davor stehen bleibt:

```
bun run scripts/arm-vormerken.ts "Migration V043 anwenden und 104 Werte schreiben" weiter
bun run scripts/arm-vormerken.ts "vier Commits übertragen" push
```

Das zweite Wort sagt, womit die wartende Sitzung angestoßen wird: `push` für
eine Übertragung, `weiter` für alles andere, leer für „nur freigeben".

**Die Vormerkung ist eine Beschriftung, kein Schlüssel.** Sie gibt nichts
frei, verlängert keine Frist und ersetzt keine Prüfung. cc kann sich damit
nicht selbst scharfstellen; das Flag setzt weiterhin allein der Owner über
Telegram. Fehlt die Vormerkung, fällt die Quittung auf den allgemeinen Text
zurück — die Freigabe wirkt unverändert.

Sie verfällt nach 24 Stunden: Lieber keine Angabe als eine falsche.

---

## Was die Freigabe abdeckt — und was nicht

| Vorgang | braucht `/arm`? | geprüft von |
|---|---|---|
| Push, der einen **roten Pfad** berührt | **ja** | `deny-destructive.sh` prüft, `scripts/hooks/pre-push` verbraucht |
| **Roter Befehl** (`migrate … --apply`, `psql … openclaw_core`, `npm publish`, `docker push`, Löschungen gegen die Produktiv-DB) | **ja** | `deny-destructive.sh` prüft **und** verbraucht |
| **Dienst-Neustart** (`systemctl --user restart …`) | **nein** — nicht rot, siehe unten | Teil der Gate-Kette |
| Push ohne roten Pfad | nein | — |
| Harte Verbote (rekursives Löschen, Tabellen verwerfen, `git push --force`) | **nicht armbar** | `deny-destructive.sh`, unabhängig vom Flag |
| Push, dessen Ziel nicht bestimmbar ist | **nicht armbar** (fail-closed) | `deny-destructive.sh` / `pre-push` |

**Der Neustart ist nicht rot — entschieden am 16.10.2026.** Weder
`red-zone.conf` noch der Hook kennen `systemctl`, und das bleibt so: Nach
Cowork-Platform.md §14 gehört der Dienst-Neustart zur normalen Gate-Kette
(Build, Tests, Restart, Smoke), die cc nach grünen Gates selbst durchläuft.
Die zwischenzeitliche Arbeitsnotiz „Neustart nur nach `/arm`" ist damit
aufgehoben.

---

## Die drei Stolpersteine

**15 Minuten.** Zwischen `/arm` und dem roten Schritt dürfen nicht mehr als
900 Sekunden liegen. Eine ältere Freigabe wird nicht nur ignoriert, sondern
**gelöscht** — sie greift auch beim nächsten Versuch nicht mehr. Anlass: Am
13.10.2026 autorisierte eine Freigabe vom 11.10. einen Push, für den sie nie
gedacht war.

**Genau einmal.** Eine Freigabe deckt einen roten Schritt. Die einzige
Ausnahme ist der **Nachlauf für den Submodul-Zeiger**: Nach einer verbrauchten
Freigabe darf innerhalb von 300 Sekunden eine zweite Übertragung laufen, wenn
sie genau eine Ref betrifft, der Befund aus einem Submodul-Zeiger stammt,
**jeder** Zeiger auf einen eben freigegebenen Stand zeigt und daneben kein
roter Pfad liegt. Damit deckt eine Freigabe denselben Inhalt zweimal, aber nie
neuen.

**Fail-closed ist nicht armbar.** Lässt sich das Push-Ziel nicht bestimmen,
hilft keine Freigabe. Dann den Push mit absolutem Pfad wiederholen:
`git -C /abs/pfad push`.

---

## Abweichungen, die bei der Klärung auffielen

- **`Cowork-Platform.md` §14** nennt „`/arm` bzw. `/arm push`" nebeneinander,
  ohne den Unterschied zu benennen — genau die Lücke, die zur Verwechslung
  führte. Die Datei wird vom Claude-Chat gepflegt, nicht von cc; der Text für
  die Berichtigung steht im Report vom 16.10.2026.
- **§14 schreibt** „cc pusht nach grünen Gates (Build, Tests, **Dienst-Restart**,
  Smoke) selbst". Die zwischenzeitliche Arbeitsnotiz „Neustart nur nach `/arm`"
  stand dazu im Widerspruch; der Owner hat am 16.10.2026 zugunsten von §14
  entschieden. **Der Neustart braucht keine Freigabe.**
- **CLAUDE.md §8** sagte, `/arm push` arme „zusätzlich". Das war missverständlich:
  Es armt identisch und stößt zusätzlich an. Berichtigt.

---

## Drei Fehler, behoben am 16.10.2026

**Die Quittung log nicht mehr nach.** Nach jedem `/arm` stand im Chat
zusätzlich „No response generated. Please try again." — als wäre etwas
schiefgegangen. Ursache war nicht die Agentenschicht, sondern der Kern: Ein
Handler, der selbst sendet und dann eine leere Antwort zurückgibt, bekommt
einen Ersatztext untergeschoben. Dafür sieht der Kern `suppressReply` vor;
genau das setzt jetzt `stillBeantwortet()`.

**Eine Erwähnung verbraucht keine Freigabe mehr.** Rote Befehlsmuster greifen
nur noch an einer Befehlsposition: am Zeilenanfang, nach `;` `&` `|` `(` oder
`$(`, und nach den üblichen Vorsätzen (`sudo`, `env`, `timeout`, `nohup`,
`npx`, `bunx`, `bun run`, `node`, `tsx`, `bash -c`, `sh -c`, `VAR=wert`). Ein
Pfad davor ist erlaubt. Vorher genügte es, ein Muster irgendwo im Befehlstext
zu nennen — am 16.10.2026 haben so zwei Owner-Freigaben reine Lesebefehle
bezahlt.

Ein Muster, das **bewusst überall** greifen soll, trägt in `red-zone.conf`
eine vorangestellte Tilde. Das gilt für die Löschbefehle gegen die
Produktiv-Datenbank: Sie bleiben rot, auch als Argument, in Anführungszeichen
oder in einem Hier-Dokument.

**Die Verbrauchsquittung nennt den Befehl.** Früher stand dort eine allgemeine
Beschreibung — „Datenbank-Migration ausführen", auch wenn nichts migriert
wurde. Jetzt steht der tatsächlich auslösende Befehl dabei, auf 160 Zeichen
gekürzt und mit maskierten Geheimnissen.

### Eine Grenze, die bleibt

Ein Muster, das in einer **Markdown-Tabelle** direkt hinter einem `|` steht,
ist für den Hook von einer Shell-Pipe nicht zu unterscheiden — und `foo | psql
…` muss rot bleiben. Solche Zeilen lösen weiterhin aus.

Praktisch heißt das: **Reports und Commit-Nachrichten mit dem Schreibwerkzeug
schreiben, nicht über die Befehlszeile.** Ein Hier-Dokument mit einer
Mustertabelle blockiert sonst den eigenen Aufruf. Ein Test hält die Grenze
fest, damit sie nicht als Überraschung wiederkommt.

### Nebenbefund

Zwei der sechs roten Befehlsmuster waren **seit jeher wirkungslos**: Die
Konfigurationszeilen liefen durch `xargs`, und das entfernt Backslashes — aus
einem Muster mit `\s` wurde still eines ohne. Nachgewiesen gegen die alte
Fassung des Hooks. Behoben; das ist eine Verschärfung, keine Lockerung.

---

## Ein Hook, zwei Stränge — Sperre gegen das Überschreiben (16.10.2026)

`~/.claude/hooks/` ist für **alle** Stränge dieselbe Stelle. bikosoc und HDCC
pflegen den Deny-Hook aber in je eigenen Repos und spielen beide dorthin aus.
Wer zuletzt `install-hooks.sh` ausführte, gewann — und die Arbeit des anderen
war weg.

Am 16.10.2026 wäre es beinahe passiert: Die HDCC-Sitzung hatte den aktiven
Hook um 12:25 erweitert (strangabhängige Wahl der Rote-Zone-Konfiguration).
Ein `install-hooks.sh` aus bikosoc hätte das kommentarlos überschrieben.
Aufgefallen ist es nur, weil der Smoke-Test Drift meldete und jemand nachsah.

### Wie die Sperre arbeitet

Neben jedem Hook liegt eine Marke:

```
~/.claude/hooks/.<hookname>.<strang>-stand
```

Darin steht die Prüfsumme dessen, was **dieser Strang zuletzt selbst
ausgespielt** hat. Vor jedem Ausspielen vergleicht das Skript:

| Lage | Verhalten |
|---|---|
| aktiver Hook = eigene Marke | ausspielen, Marke nachziehen |
| Marke fehlt, aktiv = Repo | Marke einmalig anlegen, nichts überschreiben |
| Marke fehlt, aktiv ≠ Repo | **Abbruch** — der Urheber ist unbekannt |
| aktiv ≠ eigene Marke | **Abbruch** — ein anderer Strang war am Werk |

Der Abbruch nennt alle drei Prüfsummen (aktiv, eigene Marke, Repo) und den
Weg: **erst übernehmen, dann ausspielen.** Exit-Code 4.

Zwei Eigenschaften, auf die es ankommt:

- **Zwei Durchgänge.** Erst wird jeder Hook geprüft, dann erst kopiert. Bräche
  das Skript mitten im Kopieren ab, bliebe ein halb ausgespielter
  Schutzmechanismus zurück — die schlechteste aller Lagen.
- **Kein `--force` als Normalfall.** Der Ausweg heißt
  `--fremden-stand-verwerfen` und ist bewusst unbequem benannt. Ein
  unbekanntes Argument spielt gar nichts aus.

Der Smoke-Test meldet Drift unverändert weiter — die Sperre ersetzt ihn nicht,
sie fängt den Fall nur früher ab.

### Für HDCC (Paritätsauftrag, nicht von bikosoc umzusetzen)

Dieselbe Sperre gehört in das HDCC-Pendant. Zu ändern ist nur der Strangname;
die Marke heißt dort `.<hookname>.hdcc-stand`:

```bash
STRANG="hdcc"
pruefsumme() { sha256sum "$1" | cut -d' ' -f1; }
marke_von()  { echo "$LIVE_HOOKS/.$(basename "$1").$STRANG-stand"; }

# Durchgang 1: pruefen, nichts anfassen.
#   - Hook fehlt            → nichts zu schuetzen
#   - Marke da, aktiv=Marke → eigener Stand, weiter
#   - Marke fehlt, aktiv=Repo → weiter (Marke wird unten angelegt)
#   - sonst                 → in die Abbruchliste
# Ist die Liste nicht leer und --fremden-stand-verwerfen fehlt:
#   alle drei Pruefsummen ausgeben, Weg nennen, exit 4.
#
# Durchgang 2: kopieren wie bisher, danach IMMER
#   ( umask 077; pruefsumme "$dest" > "$marke" )
# auch bei „unchanged" — sonst fehlt die Marke weiterhin.
```

Die Marken beider Stränge liegen nebeneinander und stören sich nicht: Jeder
prüft nur gegen seine eigene. Wer übernimmt, holt die fremde Änderung ins
eigene Repo — genau das ist am 16.10.2026 geschehen und hat zum richtigen
Ergebnis geführt.

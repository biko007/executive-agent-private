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

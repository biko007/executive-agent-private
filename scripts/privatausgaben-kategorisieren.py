#!/usr/bin/env python3
"""Kategorisiert Umsaetze mit dem Regelwerk Privatausgaben — rein lesend.

Aufruf:  python3 -I privatausgaben-kategorisieren.py <regelwerk.py>  < umsaetze.json
Eingabe: JSON-Liste von {"gegenpartei", "zweck", "konto", "betrag"}
Ausgabe: JSON-Liste von [kategorie, art] in derselben Reihenfolge

Das Regelwerk liegt bewusst NICHT im Repository, sondern unter
artifacts/personal/ (gitignored): Seine Muster enthalten Namen von
Handwerkern und Privatpersonen.
"""
import importlib.util
import json
import sys


def lade_regelwerk(pfad):
    spec = importlib.util.spec_from_file_location("regelwerk", pfad)
    modul = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modul)
    return modul


def main():
    regelwerk = lade_regelwerk(sys.argv[1])
    umsaetze = json.load(sys.stdin)
    ergebnis = [
        list(regelwerk.kategorisiere(u.get("gegenpartei") or "", u.get("zweck") or "",
                                     str(u.get("konto") or ""), float(u.get("betrag") or 0)))
        for u in umsaetze
    ]
    json.dump(ergebnis, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()

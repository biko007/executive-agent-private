#!/usr/bin/env python3
"""Dropbox-Vollzugriff einrichten — OAuth2 mit PKCE, ohne App-Secret.

Die neue App "BikosOpenClawFA" (Scoped App, Full Dropbox) arbeitet ohne
Secret: Der Nachweis läuft über PKCE (RFC 7636). Damit liegt nirgendwo auf dem
Rechner ein dauerhaftes Geheimnis der App, und der Code-Verifier existiert nur
für die Dauer dieses Aufrufs im Arbeitsspeicher.

Ablauf:

  1. Das Skript zeigt eine Adresse an.
  2. Herr Bickel öffnet sie im Browser, meldet sich an und klickt "Zulassen".
  3. Dropbox zeigt einen Code an. Der wird hier eingegeben — verdeckt, also
     ohne Anzeige im Terminal und ohne Spur im Verlauf.
  4. Das Skript tauscht den Code gegen einen Refresh-Token und schreibt
     DROPBOX_APP_KEY und DROPBOX_REFRESH_TOKEN in die vorhandene Env-Datei.

Der Token wird NICHT angezeigt, nicht protokolliert und nicht in einen Report
geschrieben. Die Env-Datei bekommt die Rechte 600. Vorhandene Zeilen gleichen
Namens werden nicht gelöscht, sondern mit Datum auskommentiert — der Rückweg
ist ein Entfernen des Rautezeichens.

Aufruf:

    python3 scripts/dropbox_auth_pkce.py

Nichts davon berührt die alte App: Deren Werte (EA_DROPBOX_*) bleiben
unverändert stehen, bis Herr Bickel sie nach sieben fehlerfreien Tagen
freigibt.
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import json
import os
import secrets
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

APP_KEY = "4fm8hxopf6s4yx3"          # BikosOpenClawFA, Scoped App, Full Dropbox
ENV_DATEI = Path.home() / ".config" / "openclaw" / "env"
AUTORISIEREN = "https://www.dropbox.com/oauth2/authorize"
TOKEN = "https://api.dropboxapi.com/oauth2/token"
API = "https://api.dropboxapi.com/2"


def pkce_paar() -> tuple[str, str]:
    """Verifier und Challenge nach RFC 7636, Verfahren S256."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


def post(url: str, daten: dict[str, str]) -> dict:
    anfrage = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(daten).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(anfrage, timeout=30) as antwort:
            return json.loads(antwort.read().decode())
    except urllib.error.HTTPError as fehler:
        rumpf = fehler.read().decode(errors="replace")
        # Der Rumpf einer Token-Antwort kann den Code enthalten — nur die Art
        # des Fehlers ausgeben, nicht den ganzen Text.
        kurz = rumpf[:200].replace("\n", " ")
        raise SystemExit(f"Dropbox lehnt ab (HTTP {fehler.code}): {kurz}") from None


def api_aufruf(pfad: str, zugriffstoken: str, rumpf: dict | None) -> dict:
    anfrage = urllib.request.Request(
        f"{API}/{pfad}",
        data=json.dumps(rumpf).encode() if rumpf is not None else b"null",
        headers={
            "Authorization": f"Bearer {zugriffstoken}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(anfrage, timeout=30) as antwort:
        return json.loads(antwort.read().decode())


def env_schreiben(werte: dict[str, str]) -> list[str]:
    """Werte eintragen, alte Zeilen auskommentiert erhalten. Gibt die Notizen zurück."""
    if not ENV_DATEI.exists():
        raise SystemExit(f"Env-Datei fehlt: {ENV_DATEI}")

    zeilen = ENV_DATEI.read_text(encoding="utf-8").splitlines()
    heute = date.today().isoformat()
    notizen: list[str] = []
    neu: list[str] = []

    for zeile in zeilen:
        schluessel = zeile.split("=", 1)[0].strip() if "=" in zeile else ""
        if schluessel in werte and not zeile.lstrip().startswith("#"):
            neu.append(f"# {heute} ersetzt: {zeile}")
            notizen.append(f"{schluessel}: alter Wert als Kommentar gesichert")
        else:
            neu.append(zeile)

    for schluessel, wert in werte.items():
        neu.append(f"{schluessel}={wert}")
        notizen.append(f"{schluessel}: neu geschrieben")

    # Erst vollständig schreiben, dann die Rechte setzen — nie umgekehrt.
    temp = ENV_DATEI.with_suffix(".neu")
    temp.write_text("\n".join(neu) + "\n", encoding="utf-8")
    os.chmod(temp, stat.S_IRUSR | stat.S_IWUSR)  # 600
    temp.replace(ENV_DATEI)
    os.chmod(ENV_DATEI, stat.S_IRUSR | stat.S_IWUSR)
    return notizen


def main() -> int:
    verifier, challenge = pkce_paar()

    frage = urllib.parse.urlencode({
        "client_id": APP_KEY,
        "response_type": "code",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "token_access_type": "offline",
    })

    print()
    print("Schritt 1 — diese Adresse im Browser öffnen, anmelden, „Zulassen“ klicken:")
    print()
    print(f"    {AUTORISIEREN}?{frage}")
    print()
    print("Schritt 2 — Dropbox zeigt danach einen Code an. Diesen hier einfügen.")
    print("Die Eingabe bleibt unsichtbar; das ist Absicht.")
    print()

    try:
        code = getpass.getpass("Code: ").strip()
    except (EOFError, KeyboardInterrupt):
        print("\nAbgebrochen. Es wurde nichts geändert.")
        return 1

    if not code:
        print("Kein Code eingegeben. Es wurde nichts geändert.")
        return 1

    antwort = post(TOKEN, {
        "code": code,
        "grant_type": "authorization_code",
        "client_id": APP_KEY,
        "code_verifier": verifier,
    })

    refresh = antwort.get("refresh_token")
    zugriff = antwort.get("access_token")
    if not refresh:
        raise SystemExit(
            "Dropbox hat keinen Refresh-Token geliefert. Ursache ist fast immer "
            "ein fehlendes token_access_type=offline oder ein bereits benutzter Code."
        )

    # Probe, bevor etwas geschrieben wird.
    konto = api_aufruf("users/get_current_account", zugriff, None)
    name = (konto.get("name") or {}).get("display_name", "(ohne Namen)")

    wurzel = api_aufruf("files/list_folder", zugriff, {
        "path": "", "recursive": False, "limit": 200,
    })
    anzahl = len(wurzel.get("entries", []))
    weitere = " (weitere vorhanden)" if wurzel.get("has_more") else ""

    notizen = env_schreiben({
        "DROPBOX_APP_KEY": APP_KEY,
        "DROPBOX_REFRESH_TOKEN": refresh,
    })

    print()
    print("Fertig.")
    print(f"  Konto:        {name}")
    print(f"  Wurzel:       {anzahl} Einträge{weitere}")
    print(f"  Env-Datei:    {ENV_DATEI} (Rechte 600)")
    for notiz in notizen:
        print(f"  {notiz}")
    print()
    print("Der Refresh-Token steht nur in der Env-Datei — nicht hier, nicht im Protokoll.")
    print("Die Werte der alten App (EA_DROPBOX_*) sind unberührt.")
    print()
    print("Damit die Dienste ihn benutzen, ist ein Neustart nötig. Der läuft über /arm.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

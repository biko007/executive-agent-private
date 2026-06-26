# Shared Platform — Plattformvertrag (bikosoc + HDCC)

> **Geteilte Infrastruktur**, die OpenClaw/bikosoc **und** HDCC gemeinsam nutzen.
> Liegt physisch im bikosoc-Repo (`executive-agent/docs/`), ist aber **neutral**:
> beschreibt weder OpenClaw- noch HDCC-Fachlogik, nur die Plattform darunter.
>
> **Autoritativ.** Beide Architektur-Dokumente verweisen hierher statt zu duplizieren:
> `executive-agent/docs/ARCHITECTURE.md` (OpenClaw) · `hdcc/docs/ARCHITECTURE.md` (HDCC).
>
> **Cross-Repo-Hinweis:** Diese Datei lebt im bikosoc-Repo. cc kann sie bei HDCC-Arbeit
> nicht im selben Commit mitpflegen — Änderungen an Shared Infra laufen über bikosoc.

**Status-Konvention:** ✅ Verifiziert (Datum, Quelle) · ⏳ Zu verifizieren (Prüfschritt).
**Pässe:** 2026-06-26 · `archdoc-verify-20260626-1717.md` + `archdoc-verify2-20260626-1724.md`.

---

## 1. VPS / Host-Kontext

**Status:** ✅ verifiziert 2026-06-26

- Hetzner Cloud VPS **CCX33** (8 vCPU dediziert, **30 GiB** RAM), **Helsinki (hel1)**.
- OS **Ubuntu 24.04.4 LTS**, Kernel 6.8.0-110-generic. User `biko`. Domain `app.bikobickel.de`.
- Edge: nginx (HTTPS 443 auf `46.62.153.181`), Let's Encrypt — Zertifikat gültig bis
  **2026-07-29** (Auto-Renew). Firewall UFW + Fail2ban. SSH-Key only, Root-Login deaktiviert.
- **Tailscale-Mesh aktiv** (`tailscaled`, `100.121.45.4` / `fd7a:115c:…`). Reiner Peer-Mesh
  für Remote-Zugriff (SSH, Dashboard, Debug) — **keine advertised/accepted Routes, kein
  Exit-Node, kein Subnet-Routing**. Nodes (3): VPS `hetzner-vps` (100.121.45.4, online),
  MacBook Pro (100.67.173.54, offline >112d), iMac Pro (100.120.176.58).
  ✅ verifiziert 2026-06-26 (`tailscale status --json`).
- UFW erlaubt zusätzlich `60000:61000/udp` (Mosh über Mobilfunk).
  `8443/tcp`-Regel entfernt 2026-06-26 (nichts lauschte, keine Referenz).

---

## 2. Docker / Runtime-Konzept

**Status:** ✅ verifiziert 2026-06-26 (`docker ps`)

- OpenClaw-Services laufen **nativ** als systemd-User-Services (nicht containerisiert).
- Docker-Container (3): `n8n-docker-postgres-1` (postgres:16-alpine, **healthy**),
  `n8n-docker-n8n-1` (n8n:latest), `hdcc-minio-1` (minio:latest).

---

## 3. Gemeinsame Postgres-Instanz

**Status:** ✅ verifiziert 2026-06-26

- **Eine** Instanz: Docker `n8n-docker-postgres-1`, **PostgreSQL 16**.
- Hostet **mehrere getrennte DBs** (§4). Isolation strikt: OpenClaw und HDCC teilen die
  Instanz, **nicht** DBs/Rollen.
- Lesson learned: Bootstrap-Superuser nicht degradierbar → separate App-User pro DB.

---

## 4. Datenbanken und Rollen

**Status:** ✅ verifiziert 2026-06-26 (`\l`, `\du`) — Cruft bereinigt 2026-06-26

**Produktive DBs (7 total, inkl. System-DBs):**

| DB | Owner | App-Rolle | Inhalt |
|---|---|---|---|
| `n8n` | n8n | `n8n_app` | Workflow-Definitionen, Execution-History, Credentials |
| `openclaw_core` | openclaw | `openclaw` | OpenClaw-Anwendungsdaten (53 Tabellen) |
| `hdcc_core` | hdcc_owner | `hdcc_app` (DML) | HDCC-Produktivdaten |
| `hdcc_test` | hdcc_owner | `hdcc_app` | HDCC-Test-DB |
| `postgres` | n8n | — | System-DB (Maintenance) |
| `template0` | n8n | — | System-Template |
| `template1` | n8n | — | System-Template |

**Rollen:** `n8n` (Bootstrap-Superuser: Superuser/CreateRole/CreateDB/Replication/BypassRLS —
nur pg_dump) · `postgres` (Notfall-Superuser) · `openclaw` (CreateDB) · `n8n_app`, `hdcc_app`,
`hdcc_owner` (App/Owner, ohne Sonderrechte). Per-Table-GRANTs statt blanket
`ALTER DEFAULT PRIVILEGES`.

> **Cruft bereinigt 2026-06-26:** 9 verwaiste `openclaw_test_*` / `openclaw_test_nk_*`
> Test-Datenbanken gedroppt (0 Referenzen in Code/Config/n8n, pg_dump-Sicherung in
> `~/bikosoc-spec/cruft-dumps-20260626-2007/`). Keine `openclaw_test_*`-DBs mehr vorhanden.

---

## 5. nginx / externe Routen / Ports

**Status:** ✅ verifiziert 2026-06-26 (`nginx -T`, `ss -tlnp`)

server_names: `bikobickel.de`, `app.bikobickel.de`. Spezifische Routen vor generischem
Catch-All. Interne Endpunkte (`/api/internal/*`) via IP-Whitelist (127.0.0.1).

**Routen (Auszug):** `/api/internal/`→18789 · `/withings/callback`→18789 ·
`/location`→18790 · `/api/instagram/(token-health|token-refresh)`→18789 · `/api/`→18800 ·
`/dashboard`→18800 · `/n8n/`→5678 · `/static/instagram/` (OpenClaw) · **`/static/hdcc/`
(HDCC-Medien über geteilte nginx)**.

**Port-Gesamtallokation (verifiziert):**

| Port | Service | Bindung | System |
|---|---|---|---|
| 18789 | openclaw-gateway | 127.0.0.1 | OpenClaw |
| 18790 | location-endpoint | 127.0.0.1 | OpenClaw |
| 18792 | gateway-intern | 127.0.0.1 | OpenClaw |
| 18793 | openclaw-trading | 127.0.0.1 | OpenClaw |
| 18794 | banking-fints (python) | 127.0.0.1 | OpenClaw |
| 18800 | openclaw-dashboard | 127.0.0.1 | OpenClaw |
| 37777 | openclaw-pdf-worker (bun) | 127.0.0.1 | OpenClaw |
| 7497 | ibgateway (java) | `*` | OpenClaw |
| 5678 | n8n | 127.0.0.1 (docker-proxy) | geteilt |
| 5432 | Postgres 16 | 127.0.0.1 (docker-proxy) | geteilt |
| **9000/9001** | **MinIO** | **`0.0.0.0`** | geteilt (HDCC-primär) |
| 80/443 | nginx | `46.62.153.181` + Tailscale | geteilt |

---

## 6. MinIO

**Status:** ✅ verifiziert 2026-06-26 — extern dicht, Buckets dokumentiert

- Container `hdcc-minio-1` (minio:latest), S3-kompatibel. Uploads via
  `@aws-sdk/lib-storage` (Streaming).
- Ports 9000/9001 binden an `0.0.0.0`, sind aber **extern nicht erreichbar**: UFW ist
  aktiv (default-deny incoming) und gibt 9000/9001 **nicht** frei (verifiziert 2026-06-26).
  Kein Exposure-Problem.

**Buckets (verifiziert 2026-06-26):**

| Bucket | System | Inhalt |
|---|---|---|
| `hdcc-dev` | HDCC | HDCC-Mediendaten (einziger Bucket) |

OpenClaw/bikosoc nutzt MinIO **nicht** — kein `MINIO_ENDPOINT/BUCKET` in bikosoc-Code
oder `~/.config/openclaw/env`. MinIO ist **ausschließlich HDCC**.

---

## 7. ffmpeg und Concurrency

**Status:** ✅ Binary verifiziert — Concurrency-Modell korrigiert ggü. Annahme

- System-Binary **ffmpeg 6.1.1** (Ubuntu), von beiden Systemen genutzt.
- **Korrektur:** Das oft genannte „global concurrency 1" ist **nicht im bikosoc-Code**.
  bikosoc hat eine eigene Instagram-`edit-queue`; das globale Limit (concurrency 1) lebt in
  **HDCC**. Es gibt damit **keinen verifizierten geteilten Software-Lock** über beide
  Systeme — die gegenseitige Drosselung ist **CPU/Resource-Ebene** (8 vCPU geteilt).
- ⏳ Falls ein echter Cross-System-Lock gewünscht ist (z. B. `pg_advisory_lock`), wäre das
  eine bewusste Design-Entscheidung — aktuell nicht vorhanden.

---

## 8. Secrets / Credential-Grenzen

**Status:** ✅ verifiziert 2026-06-26 (Perms)

- Secrets je System getrennt: `~/.config/openclaw/env` (2933 B, chmod 600) und
  `~/.config/hdcc/env` (1460 B, chmod 600). 1Password als Master.
- Secrets nie nach stdout. Fail-closed-Defaults.

---

## 9. Backup / Restore / Migration

**Status:** ✅ verifiziert 2026-06-26 (Timer aktiv) — ⏳ nur letzter Restore-Drill (operativ)

- **Korrektur ggü. v32:** Borg läuft über **systemd-Timer**, nicht Cron (kein user-/root-Cron
  vorhanden). borg **1.2.8**. Units `openclaw-backup-{daily,weekly,monthly}`.
- Hetzner VPS-Snapshots (täglich, 7 Tage Retention). Borg-Repo auf Hetzner Storage Box.
- Git: drei OpenClaw-Repos + `biko007/hdcc` auf GitHub.
- Timer aktiv (verifiziert): `openclaw-backup-daily` (03:02 UTC, zuletzt 2026-06-26),
  `-weekly` (So), `-monthly` (1. d. Monats). ⏳ letzter Restore-Drill operativ bestätigen
  (zuletzt bekannt: 2026-05-11 passed).

---

## 10. Verifikationsstatus / offene Fakten

**Verifiziert 2026-06-26:** Host/OS/TLS · Docker · Postgres-Instanz · DBs/Rollen · Ports ·
nginx-Routen · UFW (MinIO dicht, 8443 entfernt) · Backup-Timer · Secrets-Perms ·
Tailscale-Mesh · MinIO-Buckets · Cruft-DBs bereinigt.

**Erledigt (Hygiene-Batch 2026-06-26):**
- ✅ `openclaw_test_*` Cruft-DBs (9 Stück) gedroppt, pg_dump-Sicherung vorhanden — §4
- ✅ MinIO-Buckets dokumentiert (1× `hdcc-dev`, HDCC-only) — §6
- ✅ Tailscale-Mesh dokumentiert (Peer-Mesh, keine Routen) — §1
- ✅ `8443/tcp` UFW-Regel entfernt (nichts lauschte, keine Referenz) — §1
- ✅ banking-fints `/health` Liveness-Endpoint hinzugefügt (kein Bank-Kontakt) — siehe ARCHITECTURE.md §3

**Offene Tails (nicht doku-blockierend):**
- letzter Restore-Drill (operativ) — §9

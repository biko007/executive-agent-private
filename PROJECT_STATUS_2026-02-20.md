Last updated: 2026-02-20 (Europe/Berlin)

============================================================
PURPOSE
============================================================

OpenClaw Executive System on Hetzner VPS.

Primary control surface: Telegram

Core capabilities:
- Unified Inbox (M365 + Yahoo, unread)
- Draft lifecycle with approval gate
- Fast draft creation/editing
- Calendar read + free/busy
- Meeting creation with robust conflict detection
- Natural-language meeting parsing
- Deterministic build & patch workflow

System goal:
Reliable executive assistant backend with deterministic deployment and zero manual corruption.

============================================================
INFRASTRUCTURE
============================================================

Server:
- Hetzner Cloud VPS (CCX33)
- Ubuntu 24.04 LTS
- Public IP: 46.62.153.181
- Tailscale IP: 100.121.45.4
- HTTPS via Tailscale Serve → 443 → 127.0.0.1:18789

Security:
- SSH key only
- Root disabled
- UFW active
- Fail2ban active
- Gateway auth mode = token
- Secrets single source of truth: ~/.config/openclaw/env
- No secrets in code, pluginConfig, workspace, chat

OpenClaw:
- Version 2026.2.14
- systemd user service: openclaw-gateway.service
- Sessions: ~/.openclaw/agents/main/sessions
- Logs: /tmp/openclaw/openclaw-YYYY-MM-DD.log

Workspace:
- ~/.openclaw/workspace
Extension:
- ~/.openclaw/workspace/.openclaw/extensions/executive-agent

============================================================
RUNTIME & BUILD
============================================================

Runtime:
- Node.js 22.x (ESM)
- TypeScript strict mode
- No external DB

Build:
- index.ts = source of truth
- dist/index.js = runtime
- openclaw.plugin.json → main = dist/index.js

NPM Scripts:
- build
- check:node
- dev:check
- clean

Gate (mandatory after each change):
1) npm run build
2) npm run check:node
3) systemctl --user restart openclaw-gateway.service
4) Telegram smoke test

Rollback:
- git reset --hard <commit>

============================================================
MODUS OPERANDI (MANDATORY)
============================================================

NO manual large nano edits.

Workflow:
1) Git snapshot
2) Deterministic scripted change
3) Build gate
4) Restart gate
5) Telegram smoke test
6) Commit

Objectives:
- Small diffs
- Deterministic changes
- No file corruption
- No secret leakage

============================================================
MAIL
============================================================

Yahoo:
- IMAP unread (ImapFlow)
- SMTP send (Nodemailer v8.0.1)
- /yinbox
- /yverify
- /ytest

M365:
- Graph token cache
- Retry layer
- 20s fetch timeout (AbortController)

Unified Inbox:
- /inbox [n]
- Unread only
- Combined sources
- Sorted desc

Draft Lifecycle:
- draft → approved → sent
- Storage: artifacts/mail-drafts
- requireApproval = true

Commands:
- /draftlist
- /draftcreate
- /draftedit
- /draftshow
- /draftapprove
- /draftsend

============================================================
CALENDAR
============================================================

Read:
- /calendar (7 days)
- Berlin timezone formatting

Free:
- /free DD.MM HH:MM-HH:MM

Meet:
- /meet
- /meetf

Conflict detection:
- ±12h scan window
- Local overlap logic

Online meeting:
- Teams auto-enabled

Natural parsing supports:
- heute 14:00 1h
- morgen 9:30 45min
- mo 10:00 30
- Default duration 60min
- Default title if omitted

============================================================
GRAPH HARDENING
============================================================

All Graph calls use:
fetchWithTimeout(..., 20000)

Prevents:
- Hanging /meet
- Silent Telegram waits

============================================================
SYSTEM STATUS
============================================================

- Stable
- Deterministic
- Natural meeting parsing active
- Graph timeouts active
- Telegram responsive
- No hanging commands


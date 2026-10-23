#!/usr/bin/env bash
# scripts/deploy-rueckfall.sh — Arbeitsstand für den Rückfall in deploy.sh
#
# ANLASS (23.10.2026, report-banking-paket-abend-20261023): Der Rückfall lief
# nur `git checkout <LAST_GOOD> -- .`. Das stellt die Dateien wieder her, die
# es im Rückfallpunkt gab, lässt aber Dateien liegen, die erst danach
# hinzukamen. Eine neue Testdatei für neuen Code blieb so neben dem alten Code
# stehen, der Testlauf des Rückfalls scheiterte zwangsläufig, und Telegram
# meldete zweimal falsch „ROLLBACK FAILED — ALARM“.
#
# Jetzt entspricht der Arbeitsstand nach dem Rückfall exakt dem Rückfallpunkt:
# alle Dateien des Rückfallpunkts wiederhergestellt, versionierte Dateien, die
# es dort nicht gab, aus Arbeitsstand und Index entfernt.
# Nicht versionierte und ignorierte Dateien (Laufzeitdaten, artifacts/,
# node_modules/, dist/) werden NICHT angefasst — gelöscht wird nur, was git
# im Deploy-Stand selbst führt und im Rückfallpunkt nicht.
#
# Nur zum Einbinden (source), führt selbst nichts aus.

# rueckfall_arbeitsstand <repo-dir> <last-good-sha> <deploy-sha>
# Exit 0 = Arbeitsstand entspricht dem Rückfallpunkt, sonst 1.
rueckfall_arbeitsstand() {
  local dir="$1" ziel="$2" stand="$3"
  # `restore --staged --worktree` stellt Index und Arbeitsstand für alle
  # versionierten Pfade unter dir auf den Rückfallpunkt — Dateien, die es dort
  # nicht gibt, verschwinden aus beiden. Pfade gelten relativ zu dir, also auch
  # für Dienste in einem Unterordner (trading-agent im workspace-Repo), und
  # „Ordner wird Datei" in beide Richtungen geht ohne Sonderfall (Review
  # 23.10.2026). Nicht versionierte Dateien bleiben unberührt.
  # Der Deploy-Stand wird nur zur Prüfung gebraucht, dass er bekannt ist.
  git -C "$dir" rev-parse -q --verify "${stand}^{commit}" >/dev/null || return 1
  git -C "$dir" restore --source="$ziel" --staged --worktree -- . || return 1

  # Probe: Index und Arbeitsstand entsprechen dem Rückfallpunkt
  git -C "$dir" diff --quiet "$ziel" -- . || return 1
  git -C "$dir" diff --cached --quiet "$ziel" -- . || return 1
}

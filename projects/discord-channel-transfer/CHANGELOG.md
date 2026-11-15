# Änderungen

## 1.3.0 — 2026-11-15

- Unabhängiger systemd-Statusdienst: Online, dauerhaft „Spielt mrgbbn.Studio“, wechselnder Textstatus.
- Autostart, Wiederverbindung, kontrollierter Neustart nach Updates und lokalen Token-/Statusänderungen.
- Windows-Starter setzt den Terminaltyp explizit, damit tmux auch aus CMD startet.

## 1.2.0 — 2026-11-15

- Neue Terminal-Oberfläche mit Pfeiltasten, Serverauswahl, Archivübersicht, Fortschrittsansicht und verdeckter Token-Eingabe.
- Rückkehr zum Hauptmenü nach jedem Vorgang; bestehende CLI-Befehle bleiben erhalten.
- Windows-Installer für den kurzen CMD-Befehl `dct`, Verbindung über SSH mit verifiziertem Hostschlüssel.

## 1.1.1 — 2026-11-15

- systemd-Arbeitsverzeichnis ohne unzulässige Anführungszeichen erzeugen; auf Raspberry Pi/Debian 13 festgestellt.
- Linux-Test validiert die erzeugte Service-Datei mit `systemd-analyze verify`.

## 1.1.0 — 2026-11-15

- Projekt in ein öffentliches Sammel-Repository unter `projects/discord-channel-transfer` eingeordnet.
- Automatische Git-Updates beim Start und optionaler systemd-Timer für Raspberry Pi/Linux.
- Gemeinsame Sperre für laufende Sitzungen und Updates, Fast-forward-Prüfung, Schutz lokaler Dateien und Reparatur nach unterbrochener Installation.
- Open-Source-Lizenz GNU GPL v3, Mitwirkungsanleitung und CI für Linux/Windows.

## 1.0.0 — 2026-11-15

- Konsolenmenü, Export und Import von Channel-Strukturen und Nachrichtenarchiven.
- Vorschau, private Ziel-Channels, Anhänge und gespeicherter Übertragungsstand.

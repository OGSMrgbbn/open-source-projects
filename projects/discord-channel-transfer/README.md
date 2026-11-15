# Channel Transfer

Ein Konsolen-Tool für Raspberry Pi 5 (8 GB), Linux und Windows. Exportiert die für dein Konto sichtbare Discord-Serverstruktur samt lesbaren Nachrichten und überträgt das Archiv auf einen anderen Server.

Verwendet `discord.js-selfbot-v13` 3.7.1. Diese Bibliothek ist eingestellt und kann bei Discord-Änderungen ausfallen. Discord untersagt die Automatisierung von Benutzerkonten und kann Konten sperren: [offizieller Hinweis](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots). Nur Inhalte übertragen, für deren Kopie und Weitergabe du berechtigt bist.

## Start auf dem Raspberry Pi

Voraussetzung: Raspberry Pi OS **64 Bit**, **Git**, Node.js **24 LTS** (mindestens 22.12), npm und genügend freien Speicher für Anhänge. Node.js gibt es für Linux ARM64 auf der [offiziellen Downloadseite](https://nodejs.org/en/download). Node-Version mit `node --version` prüfen.

Per SSH verbinden und das öffentliche Repository klonen:

```bash
git clone https://github.com/OGSMrgbbn/open-source-projects.git
cd open-source-projects/projects/discord-channel-transfer
npm ci --ignore-scripts
cp .env.example .env
chmod 600 .env
nano .env
npm start
```

Den eigenen Token ausschließlich lokal als `DISCORD_TOKEN=...` in `.env` eintragen. Das Tool liest keine Zugangsdaten aus Browsern. Token niemals im Chat posten. Das Konto muss Mitglied beider Server sein. Für die Übertragung ist ein eigener Zielserver am einfachsten. Ansonsten benötigt das Konto dort die im Fehlertext genannten Channel-, Nachrichten-, Anhangs- und Thread-Rechte einschließlich `MANAGE_CHANNELS` und `MANAGE_ROLES`.

Das Menü bietet Serverliste, Export, Import-Vorschau und Übertragung. IDs zeigt die Serverliste an; alternativ in Discord den Entwicklermodus einschalten und die Server-ID kopieren.

Für lange Übertragungen in einer bestehenden `tmux`-Sitzung arbeiten, damit eine SSH-Unterbrechung den Prozess nicht beendet. Es ist ein einmaliger Transferjob, kein ständig laufender Dienst.

## Automatische Git-Updates

`npm start` prüft vor dem Start den Remote-Tracking-Branch des Git-Clones (normalerweise `origin/main`). Gibt es neue Commits, übernimmt es diese per Fast-forward, führt `npm ci --ignore-scripts`, Syntaxprüfungen und Tests aus und startet anschließend den neuen Code. Updates werden repositoryweit übernommen; die Installation/Prüfung betrifft dieses Projekt. Die genutzten Git- und npm-Verfahren sind in der [Git-Dokumentation](https://git-scm.com/docs/git-merge) und [npm-Dokumentation](https://docs.npmjs.com/cli/v11/commands/npm-ci/) beschrieben.

Eine laufende Sitzung hält `.repo-runtime.lock` im Repository-Hauptordner. Ein gleichzeitig gestarteter Updater wartet bis zum nächsten Timerlauf; eine zweite Sitzung wird abgewiesen. Dadurch werden weder Code noch Abhängigkeiten während eines Transfers ersetzt. Das gilt bei Aufrufen über `npm start`; `node src/cli.js` umgeht den Launcher und darf nicht parallel zum Updater laufen.

Auf dem Pi optional Updates auch im Hintergrund aktivieren:

```bash
npm run updates:enable
loginctl enable-linger "$USER"
```

Der systemd-**Benutzer**-Timer prüft alle 15 Minuten, mit bis zu 30 Sekunden zusätzlichem Versatz. `enable-linger` hält den Benutzerdienst nach dem Abmelden am Leben und kann je nach System Administratorrechte benötigen. Der Timer führt nur Updates aus, keine Discord-Transfers. Die Installationspfade werden beim Einrichten gespeichert; nach einem Node-Upgrade oder Verschieben des Projekts `npm run updates:enable` erneut ausführen.

```bash
npm run update                                      # jetzt prüfen/installieren
systemctl --user status channel-transfer-update.timer
journalctl --user -u channel-transfer-update.service -n 50
systemctl --user disable --now channel-transfer-update.timer
```

Mit `AUTO_UPDATE=false` in `.env` werden sowohl Start- als auch Timer-Updates ausgesetzt. Lokale Quellcodeänderungen, neue unversionierte Dateien und abweichende Git-Verläufe blockieren automatische Übernahmen; sie werden nicht zurückgesetzt oder automatisch zusammengeführt. `.env`, `data/`, `node_modules/` und lokale Update-Dateien sind vom Repository ausgeschlossen. Archive deshalb unter `data/` speichern oder zusätzliche Ablageorte in einer lokalen Git-Exclude-Regel ausschließen.

Ohne Internet startet eine zuvor funktionsfähige Installation weiter. Bricht eine Installation oder Prüfung nach Übernahme des neuen Codes ab, bleibt `.update-pending.json` bestehen und der Anwendungsstart wird blockiert. Nach Beheben des Problems `npm run update` wiederholen; eine neu veröffentlichte Korrektur kann dabei ebenfalls übernommen werden. Es gibt keinen automatischen Rollback. Die Markierung nicht löschen, um einen fehlerhaften Stand dennoch zu starten. Die gemeinsame Sperrdatei nur nach einem harten Abbruch entfernen, wenn sicher kein Tool-/Updateprozess mehr läuft.

Updates entstehen durch **Commit und Push** auf den Tracking-Branch. Änderungen, die nur auf einem Entwicklungsrechner liegen, erreichen den Pi nicht. Ein ZIP ohne `.git` unterstützt keine Git-Updates: dafür das Repository klonen und vorhandene `.env` sowie `data/` in den Projektordner übernehmen. Es werden nur die im Lockfile festgelegten Abhängigkeiten installiert, keine beliebigen neuen npm-Versionen.

## Befehle ohne Menü

Platzhalter durch echte Discord-Server-IDs ersetzen:

```bash
npm start -- servers
npm start -- export --source QUELLSERVER_ID --archive data/backup
npm start -- inspect --archive data/backup
npm start -- import --target ZIELSERVER_ID --archive data/backup
npm start -- import --target ZIELSERVER_ID --archive data/backup --apply
```

Der Import ohne `--apply` ist eine Vorschau. Im interaktiven Menü wird vor dem echten Import die Ziel-ID abgefragt. Bestehende Channels werden nicht gelöscht oder als Importziel benutzt. Neue Channels bleiben zunächst privat für das angemeldete Konto und Zielserver-Administratoren. Nach dem Prüfen die gewünschten Rollenfreigaben in Discord setzen.

Exportoptionen:

```bash
# Zuerst mit einem kleinen Archiv prüfen: neueste 50 Nachrichten je Channel
npm start -- export --source QUELLSERVER_ID --archive data/test --max-messages 50

# Alle Nachrichten, Anhänge bis 25 MiB lokal speichern
npm start -- export --source QUELLSERVER_ID --archive data/backup --max-attachment-mb 25
```

Standard: alle Nachrichten vor dem Startzeitpunkt des Exports, Downloads bis 10 MiB je Anhang. Größere oder nicht mehr erreichbare Anhänge werden mit Link und Hinweis archiviert. Auch mit größerem Downloadlimit lädt der Import höchstens 10 MiB pro Datei hoch; größere lokale Dateien bleiben im Archiv. Bei abgelaufenen Discord-Links können diese Links später unbrauchbar sein.

## Was übertragen wird

- Kategorien, Text-, Sprach-, Ankündigungs-, Stage-, Forum- und Medien-Channels, soweit Discord deren Erstellung im Ziel unterstützt.
- Sichtbare aktive und archivierte Threads/Forum-Beiträge, welche die Thread-Suche des Kontos zurückgibt.
- Namen, Kategoriezuordnung und Erstellungsreihenfolge entsprechend der Quellpositionen; Themen, NSFW, Sprachlimits, Regionen und weitere unterstützte Channel-Einstellungen. Bitrate wird auf das Ziellimit begrenzt; Slowmode wird nach der Nachrichtenübertragung wieder gesetzt.
- Nachrichten chronologisch, mit Autorname und Originalzeit als Textvermerk. Der tatsächliche Absender ist dein Konto und die tatsächliche Discord-Zeit ist der Importzeitpunkt. Lange Nachrichten werden aufgeteilt.
- Lokal gespeicherte Anhänge; Einbettungen als lesbarer Text, Sticker als Links, Reaktionszahlen und Anheftungen als Textvermerk. Antworten enthalten die Original-ID.
- Erwähnungen lösen beim Import keine Pings aus.

Rollen, Mitglieder, Rollenrechte, Webhooks, Einladungen und Servereinstellungen werden nicht geklont. Die Quellberechtigungen werden **nicht** auf Zielrollen abgebildet. Original-Autoren, IDs, echte Reaktionen, Originalzeitstempel, native Antworten, Poll-Interaktion und originale Embed-Darstellung können nicht identisch wiederhergestellt werden. Custom-Emojis und Verweise auf Quell-Channels werden nicht neu zugeordnet. Forum-Tags werden als Definitionen kopiert; ihre Zuordnung an einzelne Beiträge wird nicht nachgebildet. Forum-/Medien-Beiträge bekommen eine zusätzliche Einleitungsnachricht. Private Thread-Mitgliedschaften und Thread-Sperren werden nicht übernommen.

Ankündigungs-, Stage- und Forum-Channels brauchen einen Community-Zielserver. Medien-Channels können zusätzliche serverseitige Features benötigen; Discord entscheidet über die Unterstützung. Nicht unterstützte Typen und fehlende Leserechte werden im Archiv als Hinweise vermerkt. Ein Export mit Hinweisen ist kein vollständiges Abbild aller Quellinhalte. Während eines Exports gelöschte oder veränderte Inhalte lassen sich nicht konsistent einfrieren.

## Fortsetzen und Fehlerbehebung

`Ctrl+C` fordert einen Stopp nach dem laufenden Schritt an. Denselben Befehl mit denselben Optionen und demselben Archivordner erneut ausführen. Fortschritt wird nach jeder Nachrichtenseite, Channel-Erstellung und jedem gesendeten Nachrichtenteil gespeichert. Ein fertiges Archiv bleibt unverändert; für einen neuen Zeitpunkt einen neuen Ordner verwenden.

Bei einem Verbindungsabbruch **nach** einer Discord-Schreiboperation bleibt diese als unklar markiert. Beim nächsten Lauf sucht das Tool den neu erstellten Channel bzw. den eindeutigen Archivmarker unter den letzten 100 Nachrichten. Ist der Erfolg nicht eindeutig feststellbar, stoppt es. Nur nachdem du im Ziel überprüft hast, dass die betreffende Aktion nicht ausgeführt wurde, mit `--retry-uncertain` wiederholen. Es gibt keine absolute Exactly-once-Garantie über die Discord-API. Archivmarker nicht bearbeiten und importierte Channels während einer laufenden Übertragung nicht verändern.

Falls ein Prozess hart beendet wurde, kann `data/backup/.lock` zurückbleiben. Erst sicherstellen, dass kein Transfer mehr auf dieses Archiv zugreift, dann **nur diese Sperrdatei** entfernen. Die Dateien `import-ZIELSERVER_ID.json` aufbewahren; sie verhindern Doppelimporte. Archive enthalten private Inhalte und sollten geschützt gespeichert werden. Nur eigene, vertrauenswürdige Archive importieren.

Rate Limits wartet die Bibliothek ab; zusätzlich erfolgen Schreiboperationen einzeln mit Pause. Captchas, MFA-Anforderungen oder fehlende Rechte werden nicht umgangen. API-Fehler stoppen den Lauf mit einem gespeicherten Fortsetzungsstand. Die neue private Struktur bleibt dabei erhalten.

## Optional: Docker auf dem Pi

Das offizielle Node-Image unterstützt ARM64. Docker muss bereits installiert sein:

Der Container nutzt einen festen Image-Stand und führt keine Git-Updates durch. Nach Änderungen das Image neu bauen. Für die automatische Git-Aktualisierung die oben beschriebene direkte Node.js-Installation verwenden.

```bash
docker build -t channel-transfer .
mkdir -p data
# Containerprozess läuft als UID 1000; dieser Nutzer braucht Schreibrechte auf data.
docker run --rm -it --env-file .env -v "$PWD/data:/app/data" channel-transfer
```

Falls der Pi-Benutzer eine andere UID hat: `--user "$(id -u):$(id -g)"` an `docker run` ergänzen. `.env` und Archive werden nicht ins Image kopiert.

## Prüfung

```bash
npm test
npm run check
```

Die automatisierten Tests prüfen Export, Chronologie, Sichtbarkeit, privaten Import, Ping-Unterdrückung, Fortsetzen nach erfolgreichen aber unterbrochenen API-Aufrufen, Dateipfade und Größenlimits mit simuliertem Discord. Ein echter Discord-Transfer sowie ein Lauf auf Raspberry-Pi-Hardware sind ohne Zugang zum Konto bzw. Gerät nicht geprüft.

Zusätzliche Git-Integrationstests verwenden echte lokale Repositories und prüfen Updates, unveränderte lokale Daten, Konfliktschutz, Offline-Verhalten und Reparatur nach fehlgeschlagener Installation. Der systemd-Timer muss auf dem Pi eingerichtet werden; er wurde nicht auf dieser Windows-Entwicklungsmaschine aktiviert.

## Open Source

GNU GPL v3.0: [Lizenz](LICENSE), [Drittanbieterhinweise](NOTICE.md), [Changelog](CHANGELOG.md). Beiträge sind willkommen; siehe [Mitwirkungsanleitung](../../CONTRIBUTING.md).

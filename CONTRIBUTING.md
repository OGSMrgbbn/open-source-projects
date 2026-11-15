# Mitmachen

1. Repository forken und einen Branch für die Änderung anlegen.
2. Im betroffenen Projekt Abhängigkeiten mit `npm ci --ignore-scripts` installieren.
3. Quellcode und bei verändertem Verhalten passende Tests ergänzen.
4. `npm test` und `npm run check` im Projektordner ausführen.
5. Pull Request mit Änderung, Anlass und Prüfergebnis öffnen.

Beim Entwickeln `AUTO_UPDATE=false` in der lokalen `.env` setzen. Der automatische Updater überspringt Arbeitsordner mit lokalen Änderungen; er pusht keine Änderungen und führt keine automatischen Konfliktlösungen durch.

Beiträge werden unter der Lizenz des betroffenen Projekts eingereicht. Niemals Tokens, `.env`-Dateien oder echte Discord-Archive veröffentlichen.

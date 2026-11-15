# Open Source Projects

Öffentliche Projekte von **OGSMrgbbn**. Jedes Projekt hat einen eigenen Ordner mit Quellcode, Anleitung und Tests.

| Projekt | Beschreibung | Start |
| --- | --- | --- |
| [Discord Channel Transfer](projects/discord-channel-transfer) | Konsolen-Tool für Discord-Archive und Übertragungen, vorbereitet für Raspberry Pi 5 | [Anleitung](projects/discord-channel-transfer/README.md) |

## Installation

```bash
git clone https://github.com/OGSMrgbbn/open-source-projects.git
cd open-source-projects/projects/discord-channel-transfer
npm ci --ignore-scripts
cp .env.example .env
chmod 600 .env
nano .env
npm start
```

Node.js 24 und Git werden benötigt. Die genaue Konfiguration steht beim jeweiligen Projekt.

## Automatische Updates

Das Discord-Tool prüft beim Start den Tracking-Branch des Git-Clones. Veröffentlichte Commits werden automatisch übernommen, sofern der Arbeitsordner unverändert ist und Git ohne Konflikte vorspulen kann. Ein optionaler systemd-Timer prüft auch im Hintergrund alle 15 Minuten. Eine laufende Sitzung sperrt Updates bis zu ihrem Ende.

Änderungen auf einem Entwicklungsrechner müssen zuerst mit Git committed und auf GitHub gepusht werden. Rein lokale Änderungen können andere Geräte nicht abrufen. Der Standardbranch ist die Updatequelle; Änderungen dort sollten vor Veröffentlichung getestet werden.

## Weitere Projekte

Neue Projekte unter `projects/<projektname>/` ablegen, eine eigene README und Tests ergänzen und hier verlinken. Zugangsdaten, lokale Konfiguration, Archive und Abhängigkeiten gehören nicht ins Repository.

## Lizenz

Der eigene Quellcode dieses Repositorys steht unter [GNU GPL v3.0](LICENSE), sofern ein Projekt nichts anderes angibt. Drittanbieter-Abhängigkeiten behalten ihre jeweiligen Lizenzen. Das Repository enthält keine Discord-Zugangsdaten oder Nachrichtenarchive.

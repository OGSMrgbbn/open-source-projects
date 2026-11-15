# Terminal-Oberfläche

Native Terminal-Oberfläche, optimiert für Windows CMD/Windows Terminal über SSH, Raspberry Pi Connect und tmux. Keine Webansicht und keine zusätzliche Grafikabhängigkeit.

- Dunkelblauer Hintergrund, helle Schrift, gedämpfte Statuszeilen; Cyan markiert die Auswahl, Amber einen Fehler.
- Kopf: Produkt, Version und tatsächlicher Verbindungszustand. Mitte: eine Liste oder ein Arbeitsablauf. Fuß: Auswahlbeschreibung und Tastenkürzel.
- Farben sind zentral im Terminal-Renderer hinterlegt. Die Schrift folgt dem Terminal des Nutzers; empfohlen ist dessen normale Monospace-Schrift.
- Pfeiltasten und Enter für Navigation; Esc/0 zurück. Zahlen wählen eine Zeile, Enter führt sie aus. PgUp/PgDn für lange Serverlisten.
- Keine Animationen: entfernte Sitzungen bleiben ruhig, schnell und gut lesbar. Größenänderungen zeichnen den Bildschirm neu.
- Vollbild über den alternativen Terminalpuffer. Beim Verlassen werden Cursor, Eingabemodus und vorheriger Bildschirm wiederhergestellt.
- Mindestgröße 36 × 16 Zeichen, breite Ansichten nutzen höchstens 100 Spalten. Lange Namen werden begrenzt; Terminal-Steuerzeichen aus fremden Inhalten werden entfernt.
- Token-Eingaben werden maskiert. Vorschau und bewusste Bestätigung bleiben vor schreibenden Importen erhalten.

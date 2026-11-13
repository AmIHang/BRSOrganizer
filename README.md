# AmINeeded

Lokale Windows-App, die eigene Todos, offene GitHub-PRs (vor allem Review-Anfragen) und anstehende
Kalendertermine in einer Liste zusammenführt. Sie beantwortet die Frage: **„Wo werde ich gerade gebraucht?“**
Claude und GitHub Copilot lesen und schreiben über MCP.

## App

Die Tauri-App zeigt die Liste, legt Todos an, verwaltet Token und Kalender-URL und sitzt im Tray.

- **Fenster:** Schließen blendet es nur aus. Ein-/Ausblenden mit **Strg+Alt+N** oder Klick aufs Tray-Icon.
- **Tray-Menü:** Öffnen, Jetzt synchronisieren, Beenden.
- **Benachrichtigungen:** für neue Review-Anfragen und 10 Minuten vor Terminen.
- **Autostart:** beim ersten Start eingeschaltet, abschaltbar in den Einstellungen. Die App startet dann
  unsichtbar im Tray.
- **Daemon:** Die App startet ihn, falls er nicht läuft. Er läuft auch nach dem Beenden der App weiter,
  damit MCP-Clients ihn weiter erreichen.
- **Einstellungen:** zeigen die fertigen MCP-Befehle mit den Pfaden der Installation zum Kopieren.

### Installer bauen

Voraussetzungen: Rust (rustup, Toolchain `stable-x86_64-pc-windows-msvc`) und Visual Studio bzw. Build Tools
mit „Desktopentwicklung mit C++“ samt Windows SDK. WebView2 ist unter Windows 11 vorinstalliert.

```bash
pnpm install
pnpm --filter @amineeded/app tauri:build
```

`tauri:build` ruft zuerst `scripts/build-sidecar.mjs` auf. Das Skript bündelt Daemon und `mcp-stdio` mit
esbuild, kopiert die nativen Module (better-sqlite3, keyring) und legt die `node.exe` der Build-Maschine als
`amineeded-node.exe` bei. Ergebnis ist ein NSIS-Installer unter
`packages/app/src-tauri/target/release/bundle/nsis/`, der ohne Admin-Rechte nach
`%LOCALAPPDATA%\AmINeeded` installiert. Nutzer brauchen weder Node noch Rust.

### Entwicklung

```bash
pnpm --filter @amineeded/app tauri:dev
```

Debug-Builds sind von der echten Installation getrennt:

- Datenordner `%LOCALAPPDATA%\AmINeeded-dev`
- Credential-Dienst `AmINeeded-dev`
- Port 47822
- Der Vite-Origin `http://127.0.0.1:1420` ist für den Daemon freigeschaltet.

### Tickets (BSM / OTMA)

An Todos und PRs lassen sich ein BSM- und ein OTMA-Ticket hinterlegen: über „…“ → „Tickets …“, beim
Anlegen eines Todos oder per MCP (`set_tickets`, `add_todo`).

- **BSM:** Es genügt der Schlüssel, z. B. `BRS_PWg0127`. Daraus wird
  `https://bsm.boomsoftware.com/indication/BRS_PWg0127`.
- **OTMA:** erwartet eine URL.
- **Anzeige:** Beide erscheinen als Bubble in der Zeile, BSM mit dem Schlüssel, OTMA mit „OTMA …“. Ein Klick
  öffnet das Ticket.
- **Sync:** Ticket-Links bleiben bei jedem Sync erhalten, auch an PRs aus TFS oder GitHub.

### PR-Arbeitsbereich (PR-Manager)

Ein TFS-PR lässt sich in der Liste über ▸ aufklappen. Dort stehen:

- **Details:** Branch → Ziel, Status, Merge-Status, Autor, Reviewer mit Stimme
- **Lokaler Stand:** geklont oder nicht, letzter Commit, neue Commits auf dem Server, Solution und Web-Apps
- **Aktionen:**
  - **Klonen & bauen / Aktualisieren & bauen:** `Clone-Branch.ps1` in einem eigenen PowerShell-Fenster.
    Es klont nach `<Kunde>\PR<Nr>`, richtet den IIS-App-Pool `PR<Nr>` ein (UAC), holt die
    BORA-Referenzen (Cache `_refcache`), stellt NuGet wieder her und baut.
  - **Solution, Ordner, Web-App:** öffnen
  - **Lokal löschen:** `Remove-PrClone.ps1` (UAC). Betroffen sind nur Ordner, die das Skript angelegt hat.
  - **PR abschließen:** optional vorher genehmigen, dann Squash-Merge in den Ziel-Branch und Source-Branch
    löschen. Danach bietet die App an, den Klon zu löschen.

Voraussetzung ist der **Projektordner** in den Einstellungen, z. B. `C:\projects-git`. Darunter liegt pro Kunde
ein Ordner mit dem Repo. Der passende Kundenordner wird über die Remote-URL gefunden, die Ordnernamen
sind also frei wählbar.

Die Skripte werden mit der App ausgeliefert (`packages/daemon/scripts/pr`), es muss nichts kopiert werden.
Diese Aktionen gibt es nur in der App. Claude und Copilot können über MCP weder Skripte starten noch mergen
oder löschen.

## MCP einrichten

**Mit installierter App:** In den Einstellungen unter „MCP für Claude & Copilot“ stehen die Befehle mit den
richtigen Pfaden zum Kopieren. Sie rufen die mitgelieferte `amineeded-node.exe` mit `runtime\mcp-stdio.mjs` auf.

**Aus dem Repo (Entwicklung):** wie folgt beschrieben.

Empfohlen ist für alle Clients die stdio-Brücke `mcp-stdio`:

- Sie liest das Zugriffstoken aus der Windows-Anmeldeinformationsverwaltung. **In keiner
  Client-Konfiguration steht ein Secret.**
- Läuft der Daemon nicht, startet sie ihn.
- Startet der Daemon neu, baut sie die Sitzung transparent wieder auf.
- Sie funktioniert auch aus WSL heraus.

Voraussetzung ist ein Build (`pnpm install && pnpm build`). Im Folgenden steht `<repo>` für den Repo-Pfad,
z. B. `C:\projects-git\AmINeeded\AmINeeded`.

Die Option `--client claude|copilot` legt fest, was in `created_by` landet. Ohne sie wird der Wert aus dem
Client-Namen abgeleitet.

### Claude Code (Windows)

```bash
claude mcp add amineeded --scope user -- node "<repo>\packages\mcp-stdio\dist\main.js" --client claude
```

### Claude Code in WSL

In WSL zeigt `127.0.0.1` (NAT-Modus) nicht auf Windows. Deshalb startet Claude Code die **Windows**-`node.exe`
per Interop. Der Pfad zum Skript wird als Windows-Pfad übergeben:

```bash
claude mcp add amineeded --scope user -- "/mnt/c/Program Files/nodejs/node.exe" 'C:\projects-git\AmINeeded\AmINeeded\packages\mcp-stdio\dist\main.js' --client claude
```

So laufen Proxy und Daemon in Windows, mit Zugriff auf `%LOCALAPPDATA%` und die Anmeldeinformationsverwaltung.
Netzwerkkonfiguration ist nicht nötig.

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "amineeded": {
      "command": "node",
      "args": ["<repo>\\packages\\mcp-stdio\\dist\\main.js", "--client", "claude"]
    }
  }
}
```

### VS Code / GitHub Copilot

In diesem Repo ist [.vscode/mcp.json](.vscode/mcp.json) schon eingerichtet. Für alle Projekte fügst du den
Server über „MCP: Open User Configuration“ hinzu:

```json
{
  "servers": {
    "amineeded": {
      "type": "stdio",
      "command": "node",
      "args": ["<repo>\\packages\\mcp-stdio\\dist\\main.js", "--client", "copilot"]
    }
  }
}
```

### Optionen von `mcp-stdio`

| Option                     | Bedeutung                                                  |
| -------------------------- | ---------------------------------------------------------- |
| `--client claude\|copilot` | Wert für `created_by`                                      |
| `--port <n>`               | Daemon-Port (sonst `AMINEEDED_PORT`, `daemon.json`, 47821) |
| `--no-start-daemon`        | Daemon nicht automatisch starten                           |
| `--daemon-main <pfad>`     | Anderer Daemon-Einstiegspunkt (sonst der Build im Repo)    |

Diagnosemeldungen gehen nach stderr, stdout gehört dem Protokoll.

### Alternative: HTTP direkt

Clients mit Streamable-HTTP-Unterstützung können `http://127.0.0.1:47821/mcp` direkt ansprechen.
Dann muss das Token als Header `Authorization: Bearer <token>` in der Client-Konfiguration stehen, also im
Klartext (z. B. in `~/.claude.json`). Deshalb ist diese Variante nicht empfohlen. Aus WSL geht sie nur mit
`networkingMode=mirrored` in `%USERPROFILE%\.wslconfig`.

## Voraussetzungen

- Windows 10/11
- Node.js 24 LTS (22.12+ und 25 funktionieren ebenfalls)
- pnpm 10: `npm install -g pnpm@10` (Node 25 bringt kein Corepack mehr mit)
- Für die App später: Rust (rustup, MSVC Build Tools) und WebView2

## Entwicklung

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

## Daemon

```bash
pnpm build
node packages/daemon/dist/main.js            # Port aus den Settings, Standard 47821
node packages/daemon/dist/main.js --port 48000 --no-sync --log-level debug
```

- Lauscht nur auf `127.0.0.1`. Ein zweiter Start erkennt den laufenden Daemon und beendet sich mit Code 0.
- Beim ersten Start wird das lokale Zugriffstoken erzeugt und in der Anmeldeinformationsverwaltung abgelegt
  (Dienst `AmINeeded`, Konto `local-access-token`).
- `%LOCALAPPDATA%\AmINeeded\daemon.json` enthält PID und Port (kein Secret), Logs liegen unter `logs\`.
- Für die Entwicklung: `AMINEEDED_KEYRING_SERVICE=AmINeeded-dev` trennt die Secrets von der echten Installation,
  `AMINEEDED_ALLOWED_ORIGINS=http://localhost:1420` erlaubt den Vite-Dev-Server.

### Sicherheit

Jede Anfrage muss drei Prüfungen bestehen: `Host` ist `127.0.0.1:<port>` oder `localhost:<port>` (gegen
DNS-Rebinding), ein vorhandener `Origin` gehört zur Tauri-App, und `Authorization: Bearer <token>` stimmt.
Nur `GET /health` kommt ohne Token aus.

### REST-API (für die App)

| Methode und Pfad                                    | Zweck                                                     |
| --------------------------------------------------- | --------------------------------------------------------- |
| `GET /api/items?type=&status=open,done&dueBefore=`  | Liste (Standard: offene Einträge)                         |
| `POST /api/todos`, `PATCH /api/todos/:id`           | Todo anlegen oder ändern                                  |
| `POST /api/items/:id/complete\|archive\|reopen`     | Status ändern (kein Löschen)                              |
| `POST /api/sync`, `GET /api/sync/runs`              | Sync sofort ausführen, letzte Läufe                       |
| `GET/PATCH /api/settings`                           | Intervall, Port, Quellen                                  |
| `GET /api/secrets`, `PUT/DELETE /api/secrets/:name` | `github-token`, `calendar-ics-url` setzen (nie auslesbar) |
| `GET /api/stream`                                   | Server-Sent Events für Liste und Toasts                   |
| `GET /api/status`, `POST /api/shutdown`             | Zustand der Quellen; sauber beenden                       |

### MCP-Tools

Endpunkt `http://127.0.0.1:47821/mcp` (Streamable HTTP):

| Tool            | Wirkung                                                      |
| --------------- | ------------------------------------------------------------ |
| `list_items`    | Einträge auflisten (`type`, `status`, `due_before`, `limit`) |
| `get_item`      | Einen Eintrag lesen                                          |
| `add_todo`      | Todo anlegen (`title`, `due_at`, `link`, `notes`)            |
| `update_todo`   | Todo ändern; `null` leert ein Feld                           |
| `complete_todo` | Todo erledigen                                               |
| `archive_item`  | Beliebigen Eintrag ausblenden, auch PRs und Termine          |
| `sync_sources`  | GitHub und Kalender sofort abrufen                           |

`created_by` ergibt sich aus dem Client-Namen beim Verbindungsaufbau (Claude → `claude`, VS Code/Copilot →
`copilot`, sonst `other`). Der Header `X-AmINeeded-Client: claude|copilot` legt ihn fest. Inhalte von PRs und
Terminen stehen in MCP-Antworten im Feld `external_content` mit `origin: "external:…"` und einem Hinweis, dass
es sich um Daten und nicht um Anweisungen handelt.

## Daten und Secrets

| Was                                               | Wo                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Datenbank                                         | `%LOCALAPPDATA%\AmINeeded\amineeded.db` (SQLite, WAL), überschreibbar mit `AMINEEDED_DATA_DIR` |
| GitHub-Token, ICS-Feed-URL, lokales Zugriffstoken | Windows-Anmeldeinformationsverwaltung, Dienst `AmINeeded`                                      |

Die ICS-URL gilt als Secret, weil private Kalender-Feeds (Google „geheime Adresse“, Outlook „Veröffentlichter
Kalender“) den Zugriffsschlüssel in der URL tragen.

## Quellen

- **GitHub:** GraphQL-Suche nach offenen PRs mit `review-requested:@me` und optional `assignee:@me` und
  `author:@me`. PRs, die nicht mehr in der Suche auftauchen (gemergt, Review erledigt), werden automatisch
  erledigt.
- **Kalender:** Termine der nächsten 14 Tage (konfigurierbar). Vorbei ist erledigt. Zwei Quellen stehen zur
  Wahl (Einstellungen → Kalender → Quelle):
  - **Outlook:** der Standardkalender im klassischen Outlook, gelesen über COM ohne Anmeldung. Serien werden
    aufgelöst, abgesagte Termine und abgelehnte Einladungen ausgelassen. Ein Teams-Link wird zum Klick-Ziel,
    verschobene Termine werden aktualisiert.
  - **ICS-Feed:** eine URL aus der Anmeldeinformationsverwaltung, inklusive Serien, Ausnahmen und Absagen.

- **TFS / Azure DevOps:** aktive PRs über die REST-API, mit zwei Abfragen auf Collection-Ebene (du als
  Reviewer, eigene PRs). Ein Abschluss oder Abbruch entfernt den PR beim nächsten Sync.
  - **Anmeldung:** Ohne Token wird die Windows-Anmeldung genutzt (integrierte Authentifizierung), es ist
    also kein Secret nötig. Ein optionaler PAT kommt in die Anmeldeinformationsverwaltung, etwa für
    dev.azure.com oder außerhalb der Domäne.
  - **Kennzeichnung:** `Review`, solange du noch nicht abgestimmt hast; danach `abgestimmt` mit deiner
    Stimme. Eigene PRs heißen `eigener PR`. Dass du dich selbst als Reviewer einträgst, zählt dabei nicht
    als Review-Anfrage.
- **PR-Mails (Fallback, Azure DevOps Server über Outlook):** läuft nur, solange TFS nicht eingerichtet ist.
  Beide Quellen verwenden dieselben IDs, beim Umschalten entstehen also keine doppelten Einträge. Liest einen Ordner im klassischen Outlook, Standard
  `Posteingang/PR`, über COM. Dafür ist keine Anmeldung nötig, es wird das laufende Outlook-Profil genutzt.
  Einschalten in der App unter Einstellungen → „PR-Mails (Outlook)“.
  - Jede PR-Benachrichtigung von Azure DevOps Server zählt, also z. B. „erstellt“, „Reviewer hinzugefügt“
    oder „Push“. Ein PR erscheint ab der ersten solchen Mail.
  - Ein PR verschwindet, sobald eine Mail „abgeschlossen“ meldet, egal in welcher Reihenfolge die Mails
    ankommen. Bei „aufgegeben“ verschwindet er auch, außer ein späteres „reaktiviert“ hebt das auf.
  - Erkannt wird, ob du als Reviewer eingetragen bist (`Review`, mit Benachrichtigung), ob der PR von dir ist
    (`eigener PR`) oder ob du nur informiert wirst (`Info`).
  - Berücksichtigt werden Mails der letzten 90 Tage (einstellbar). Ein älterer PR ohne Abschluss-Mail fällt
    aus dem Zeitraum und damit aus der Liste.
  - Ist Outlook nicht lesbar, wird nichts geschlossen.

Archivierte Einträge bleiben archiviert, auch wenn die Quelle sie weiter liefert.

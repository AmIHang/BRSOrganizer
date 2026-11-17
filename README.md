# BRSOrganizer

Lokale Windows-App, die eigene Todos, offene GitHub-PRs (vor allem Review-Anfragen) und anstehende
Kalendertermine in einer Liste zusammenführt. Sie beantwortet die Frage: **„Wo werde ich gerade gebraucht?“**
Claude und GitHub Copilot lesen und schreiben über MCP.

## Installieren und loslegen

1. **Installer herunterladen:** `BRSOrganizer_<Version>_x64-setup.exe` unter
   [Releases](https://github.com/AmIHang/BRSOrganizer/releases).
2. **Ausführen.** Admin-Rechte sind nicht nötig, installiert wird nach `%LOCALAPPDATA%\BRSOrganizer`. Der Installer
   ist nicht signiert, SmartScreen warnt deshalb: „Weitere Informationen“ → „Trotzdem ausführen“.
3. **Die App startet.** Beim ersten Start richtet sie selbst ein:
   - **Autostart:** an. Die App sitzt danach im Tray, **Strg+Alt+N** blendet sie ein und aus.
   - **Kalender:** dein Outlook-Kalender, wenn das klassische Outlook installiert ist.
   - **Projektordner für Klonen + Build:** `C:\projects-git`, `D:\projects-git` oder
     `%USERPROFILE%\source\repos`, je nachdem, wo Kunden-Repos liegen.
   - **TFS:** eingeschaltet, angemeldet wird mit deinem Windows-Konto, ohne Token.
4. **Einmal eintragen:** ⚙ → „TFS / Azure DevOps“ → **Collection**, z. B.
   `https://tfs.boomsoftware.com/tfs/boom`. Danach erscheinen deine PRs.
5. **Optional:**
   - **Projektordner** (⚙ → „PR-Arbeitsbereich“), falls er nicht gefunden wurde.
   - **GitHub-Token** für GitHub-PRs.
   - **PR-Mails** als Ersatz für TFS.
6. **Claude / Copilot anbinden:** ⚙ → „MCP für Claude & Copilot“ zeigt die fertigen Befehle zum Kopieren.
   Dazu gehört der Anweisungstext unter
   [PRs an BRSOrganizer melden](#anweisung-für-claude-und-copilot-prs-an-brsorganizer-melden).

Alles für Klonen, Update + Build und Merge ist im Installer enthalten, auch die PowerShell-Skripte
(`Clone-Branch.ps1`, `PrIis.ps1`, `Remove-PrClone.ps1`). Auf dem Rechner müssen nur die Werkzeuge vorhanden
sein, die das Bauen ohnehin braucht:

- **Git**
- **Visual Studio** (MSBuild)
- **BORA Designer:** für die BORA-Referenzen
- **IIS:** nur für die Web-Apps eines PRs

`nuget.exe` lädt das Skript bei Bedarf selbst.

**Update:** den neuen Installer einfach darüber installieren. Er beendet den laufenden Hintergrunddienst
selbst; Einstellungen, Todos und Tickets bleiben erhalten.

**Umstieg von AmINeeded** (früherer Name): den BRSOrganizer-Installer einfach ausführen. Er deinstalliert
AmINeeded still, beim ersten Start übernimmt BRSOrganizer Datenbank, Einstellungen und gespeicherte Tokens. Die
alten Daten unter `%LOCALAPPDATA%\AmINeeded` bleiben unangetastet liegen und können später gelöscht werden.
Danach den MCP-Server neu eintragen (⚙ → „MCP für Claude & Copilot“), Name ist jetzt `brsorganizer`; den alten
Eintrag entfernen, z. B. `claude mcp remove amineeded --scope user`.

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
pnpm --filter @brsorganizer/app tauri:build
```

`tauri:build` ruft zuerst `scripts/build-sidecar.mjs` auf. Das Skript bündelt Daemon und `mcp-stdio` mit
esbuild, kopiert die nativen Module (better-sqlite3, keyring) und legt die `node.exe` der Build-Maschine als
`brsorganizer-node.exe` bei. Ergebnis ist ein NSIS-Installer unter
`packages/app/src-tauri/target/release/bundle/nsis/`, der ohne Admin-Rechte nach
`%LOCALAPPDATA%\BRSOrganizer` installiert. Nutzer brauchen weder Node noch Rust.

Auf GitHub baut die Action `.github/workflows/build-installer.yml` den Installer nur für Release-Tags (`v*`)
oder von Hand gestartet („Run workflow“, ohne Release). Vorher laufen Lint, Typecheck und Tests. Den Installer
gibt es als Artefakt „BRSOrganizer-installer“ am Workflow-Lauf. Er enthält die `node.exe` des Runners (Node aus
`.nvmrc`, also LTS).

**Release:** einen Release-Branch anlegen, dort den Tag `v<Version>` setzen und beides pushen (nur der Tag
startet den Build), z. B.

```bash
git branch release/0.2.0 main
git tag -a v0.2.0 -m "BRSOrganizer 0.2.0" release/0.2.0
git push origin release/0.2.0 v0.2.0
```

Die Action übernimmt die Version aus dem Tag in den Installer (`BRSOrganizer_0.2.0_x64-setup.exe`) und legt ein
GitHub-Release mit der `.exe` und automatisch erzeugten Release-Notes an.

### Entwicklung

```bash
pnpm --filter @brsorganizer/app tauri:dev
```

Debug-Builds sind von der echten Installation getrennt:

- Datenordner `%LOCALAPPDATA%\BRSOrganizer-dev`
- Credential-Dienst `BRSOrganizer-dev`
- Port 47822
- Der Vite-Origin `http://127.0.0.1:1420` ist für den Daemon freigeschaltet.

### Tickets (BSM / OTMA)

An Todos und PRs lassen sich ein BSM- und ein OTMA-Ticket hinterlegen: über „…“ → „Tickets …“, beim
Anlegen eines Todos oder per MCP (`set_tickets`, `add_todo`).

- **BSM:** Es genügt der Schlüssel, z. B. `BRS_PWg0127`. Daraus wird
  `https://bsm.boomsoftware.com/indication/BRS_PWg0127`.
- **OTMA:** Es genügt die Nummer, z. B. `148082`. Daraus wird `https://otma.boomsoftware.com/ap/148082`.
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

Todos lassen sich über ⋯ → **In Projekt verschieben** einem Projekt (Kunde wie bei den PRs) zuordnen.
Für solche Todos gibt es **An Agent weitergeben**: `Start-TodoAgent.ps1` legt im Repo des Projekts einen
Worktree `<Kunde>\Todo-<id>` auf einem neuen Branch vom Standard-Branch an und startet dort `claude`
(Claude Code CLI muss installiert sein) mit Notiz, BSM- und OTMA-Ticket. Der Agent liest die Tickets,
setzt die Lösung um und erstellt den PR. Der Worktree bleibt danach stehen.

Der Agent läuft ohne Fenster als Hintergrundsitzung (`claude --bg`, Berechtigungsmodus `auto`: Claude
erlaubt die üblichen Schritte selbst und hält Riskantes an). Reinschauen und eingreifen:
`claude agents` bzw. `claude attach Todo-<id>`. Voraussetzung: Claude vertraut dem Projektordner (einmal
`claude` z. B. in `C:\projects-git` starten und bestätigen). Sonst startet `claude` wie früher in einem
eigenen Fenster. Fehler beim Anlegen des Worktrees zeigt die App direkt an.

Vor dem Start liest BRSOrganizer BSM- und OTMA-Ticket (Text, Kommentare, eingefügte Bilder) über ein
eigenes Edge-Profil im Datenordner und gibt den Inhalt dem Agenten mit. Beide hängen am selben
Keycloak-Login: Ist der BSM/OTMA-Account hinterlegt, meldet sich BRSOrganizer damit unsichtbar an (nur auf
`auth.boomsoftware.com`, einmal pro Versuch); sonst oder wenn das scheitert, öffnet sich ein Edge-Fenster.
Klappt das Lesen nicht, bekommt der Agent nur den Link. Die Dokumentliste von OTMA wird noch nicht gelesen.

Hat ein Todo oder PR nur eines der beiden Tickets (beim Anlegen oder nachträglich gesetzt, über App oder
MCP), ergänzt BRSOrganizer im Hintergrund das andere: das BSM-Ticket, das im OTMA-Ticket steht, bzw. das
OTMA-Ticket des Hauptarbeitspakets im BSM-Ticket.

Der **BSM/OTMA-Account** (ein Login für beide) wird in den Einstellungen gepflegt und liegt in der
Windows-Anmeldeinformationsverwaltung. Der Agent bekommt ihn nur über die Umgebungsvariablen
`BRS_TICKET_USER` / `BRS_TICKET_PASSWORD` seines Fensters, nie über Datei oder Kommandozeile.

Sobald der Sync den PR des Agenten findet (gleicher Source-Branch im gleichen Projekt), wird aus dem
Todo der PR-Eintrag: Der PR übernimmt BSM- und OTMA-Ticket, das Todo ist erledigt.

Voraussetzung ist der **Projektordner** in den Einstellungen, z. B. `C:\projects-git`. Darunter liegt pro Kunde
ein Ordner mit dem Repo. Der passende Kundenordner wird über die Remote-URL gefunden, die Ordnernamen
sind also frei wählbar.

Die Skripte werden mit der App ausgeliefert (`packages/daemon/scripts/pr`), es muss nichts kopiert werden.
Diese Aktionen gibt es nur in der App. Claude und Copilot können über MCP weder Skripte starten noch mergen
oder löschen.

## MCP einrichten

**Mit installierter App:** In den Einstellungen unter „MCP für Claude & Copilot“ stehen die Befehle mit den
richtigen Pfaden zum Kopieren. Sie rufen die mitgelieferte `brsorganizer-node.exe` mit `runtime\mcp-stdio.mjs` auf.

**Aus dem Repo (Entwicklung):** wie folgt beschrieben.

Empfohlen ist für alle Clients die stdio-Brücke `mcp-stdio`:

- Sie liest das Zugriffstoken aus der Windows-Anmeldeinformationsverwaltung. **In keiner
  Client-Konfiguration steht ein Secret.**
- Läuft der Daemon nicht, startet sie ihn.
- Startet der Daemon neu, baut sie die Sitzung transparent wieder auf.
- Sie funktioniert auch aus WSL heraus.

Voraussetzung ist ein Build (`pnpm install && pnpm build`). Im Folgenden steht `<repo>` für den Repo-Pfad,
z. B. `C:\projects-git\BRSOrganizer\BRSOrganizer`.

Die Option `--client claude|copilot` legt fest, was in `created_by` landet. Ohne sie wird der Wert aus dem
Client-Namen abgeleitet.

### Claude Code (Windows)

```bash
claude mcp add brsorganizer --scope user -- node "<repo>\packages\mcp-stdio\dist\main.js" --client claude
```

### Claude Code in WSL

In WSL zeigt `127.0.0.1` (NAT-Modus) nicht auf Windows. Deshalb startet Claude Code die **Windows**-`node.exe`
per Interop. Der Pfad zum Skript wird als Windows-Pfad übergeben:

```bash
claude mcp add brsorganizer --scope user -- "/mnt/c/Program Files/nodejs/node.exe" 'C:\projects-git\BRSOrganizer\BRSOrganizer\packages\mcp-stdio\dist\main.js' --client claude
```

So laufen Proxy und Daemon in Windows, mit Zugriff auf `%LOCALAPPDATA%` und die Anmeldeinformationsverwaltung.
Netzwerkkonfiguration ist nicht nötig.

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "brsorganizer": {
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
    "brsorganizer": {
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
| `--port <n>`               | Daemon-Port (sonst `BRSORGANIZER_PORT`, `daemon.json`, 47821) |
| `--no-start-daemon`        | Daemon nicht automatisch starten                           |
| `--daemon-main <pfad>`     | Anderer Daemon-Einstiegspunkt (sonst der Build im Repo)    |

Diagnosemeldungen gehen nach stderr, stdout gehört dem Protokoll.

### Anweisung für Claude und Copilot: PRs an BRSOrganizer melden

Damit Claude oder Copilot neue PRs gleich an BRSOrganizer übertragen, kopierst du den folgenden Text in die
Anweisungen des Assistenten:

- **Claude Code:** `~/.claude/CLAUDE.md`, gilt für alle Projekte, oder die `CLAUDE.md` eines Repos
- **GitHub Copilot:** `.github/copilot-instructions.md` im Repo

Voraussetzung: BRSOrganizer ist dort als MCP-Server eingerichtet (siehe oben).

```markdown
## Pull Requests und BRSOrganizer

Vor dem Erstellen eines Pull Requests nach dem BSM-Ticket fragen (z. B. `BRS_PWg0127`); keine Angabe = ohne
Ticket weitermachen, nicht erneut fragen. Ein angegebenes Ticket kommt als Link in die PR-Beschreibung
(`https://bsm.boomsoftware.com/indication/<Schlüssel>`).

Direkt nach dem Erstellen des PRs die Infos an BRSOrganizer übertragen (MCP-Server `brsorganizer`):

1. `sync_sources` aufrufen, damit BRSOrganizer den neuen PR aus TFS/GitHub holt.
2. Den PR mit `list_items` (type `pr`) anhand von Repo und PR-Nummer finden.
3. Ist ein BSM- oder OTMA-Ticket bekannt: `set_tickets` mit `bsm_url` (Schlüssel genügt) bzw. `otma_url`
   (Nummer genügt, z. B. `148082`).
4. Klappt ein Schritt nicht (BRSOrganizer nicht erreichbar, PR noch nicht synchronisiert), das dem Benutzer sagen.

Commit-Messages mit bekanntem BSM-Ticket nutzen den Schlüssel als Scope, z. B. `feat(BRS_PWg0127): …`,
`fix(BRS_PWg0127): …`, `chore(BRS_PWg0127): …`.
```

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
  (Dienst `BRSOrganizer`, Konto `local-access-token`).
- `%LOCALAPPDATA%\BRSOrganizer\daemon.json` enthält PID und Port (kein Secret), Logs liegen unter `logs\`.
- Für die Entwicklung: `BRSORGANIZER_KEYRING_SERVICE=BRSOrganizer-dev` trennt die Secrets von der echten Installation,
  `BRSORGANIZER_ALLOWED_ORIGINS=http://localhost:1420` erlaubt den Vite-Dev-Server.

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
`copilot`, sonst `other`). Der Header `X-BRSOrganizer-Client: claude|copilot` legt ihn fest. Inhalte von PRs und
Terminen stehen in MCP-Antworten im Feld `external_content` mit `origin: "external:…"` und einem Hinweis, dass
es sich um Daten und nicht um Anweisungen handelt.

## Daten und Secrets

| Was                                               | Wo                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Datenbank                                         | `%LOCALAPPDATA%\BRSOrganizer\brsorganizer.db` (SQLite, WAL), überschreibbar mit `BRSORGANIZER_DATA_DIR` |
| GitHub-Token, ICS-Feed-URL, lokales Zugriffstoken | Windows-Anmeldeinformationsverwaltung, Dienst `BRSOrganizer`                                      |

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

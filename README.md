# AmINeeded

Lokale Windows-App, die eigene Todos, offene GitHub-PRs (vor allem Review-Anfragen) und anstehende
Kalendertermine in einer Liste zusammenführt. Sie beantwortet die Frage: **„Wo werde ich gerade gebraucht?“**
Claude und GitHub Copilot lesen und schreiben über MCP.

> Status: `core` und `daemon` (REST, MCP, Sync) sind fertig. `mcp-stdio` und die App folgen.
> Die empfohlene MCP-Einrichtung über `mcp-stdio` (ohne Token in Konfigurationsdateien, auch aus WSL)
> kommt mit `mcp-stdio` in diese Datei.

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
- **Kalender:** ICS-Feed, Termine der nächsten 14 Tage (konfigurierbar), inklusive Serien, Ausnahmen und
  Absagen. Vorbei ist erledigt.

Archivierte Einträge bleiben archiviert, auch wenn die Quelle sie weiter liefert.

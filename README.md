# AmINeeded

Lokale Windows-App, die eigene Todos, offene GitHub-PRs (vor allem Review-Anfragen) und anstehende
Kalendertermine in einer Liste zusammenführt. Sie beantwortet die Frage: **„Wo werde ich gerade gebraucht?“**
Claude und GitHub Copilot lesen und schreiben über MCP.

> Status: `core` ist fertig (Datenbank, Regeln, Sync). Daemon mit MCP, `mcp-stdio` und App folgen.
> Die MCP-Einrichtung für Claude Code, Claude Desktop und VS Code kommt mit dem Daemon in diese Datei.

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

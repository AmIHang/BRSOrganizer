# AmINeeded – Projektkonventionen

Lokale Windows-App, die eigene Todos, GitHub-PRs und Kalendertermine zusammenführt
("Wo werde ich gerade gebraucht?"). Claude und Copilot lesen und schreiben über MCP.

## Aufbau (pnpm-Monorepo)

| Paket                | Aufgabe                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`      | SQLite (better-sqlite3 + Drizzle, WAL), Schema, Geschäftsregeln, Sync (GitHub, ICS), Secret Store. **Einzige Stelle, die Daten verändert.** |
| `packages/daemon`    | Ein Node-Prozess: REST-API für die UI, MCP-Server (Streamable HTTP), periodischer Sync. Nur `127.0.0.1`.                                    |
| `packages/mcp-stdio` | Dünner stdio-Proxy auf den HTTP-MCP-Endpunkt.                                                                                               |
| `packages/app`       | Tauri 2 + Svelte 5. Spricht nur über REST mit dem Daemon, startet ihn als Sidecar.                                                          |

Abhängigkeitsrichtung: `app` → (HTTP) → `daemon` → `core`. `mcp-stdio` → (HTTP) → `daemon`.
Niemand außer `daemon` importiert `core`.

## Befehle

```
pnpm install
pnpm test              # Vitest, alle Pakete
pnpm typecheck
pnpm lint
pnpm --filter @amineeded/core db:generate   # Migration aus src/db/schema.ts erzeugen
pnpm build && node packages/daemon/dist/main.js --port 47999 --data-dir <tmp> --no-sync   # Daemon lokal
```

pnpm liegt unter `%APPDATA%\npm` und ist evtl. nicht im PATH der Shell.
Beim manuellen Starten des Daemons `AMINEEDED_KEYRING_SERVICE=AmINeeded-dev` setzen und die Einträge danach
entfernen, damit die echten Credentials unberührt bleiben.

## App-Konventionen (`packages/app`)

- UI spricht nur REST/SSE mit dem Daemon (`src/lib/api.ts`), keine Imports aus `core`; Typen in
  `src/lib/types.ts` spiegeln die REST-Antworten.
- Rust (`src-tauri/src/daemon.rs`) findet/startet den Daemon und liest das Token aus dem Credential Manager
  (`keyring` v3, gleiches Ziel `local-access-token.<Dienst>` wie `@napi-rs/keyring`).
- Debug-Builds nutzen das Profil `AmINeeded-dev` (Datenordner, Credentials, Port 47822) – nie die echte
  Installation.
- Externe Texte (PR-Titel, Termine) nur als Text rendern (Svelte-Interpolation), nie `{@html}`.
- Sidecar-Runtime: `pnpm --filter @amineeded/app sidecar`; läuft ein Daemon aus dieser Runtime, sperrt er
  `better_sqlite3.node` – vorher `POST /api/shutdown`.

## mcp-stdio-Konventionen

- stdout ist ausschließlich das MCP-Protokoll; Logs nur nach stderr.
- Hängt nicht von `core` ab (nur HTTP zum Daemon). Pfade/Keyring-Namen in `src/config.ts` müssen zu
  `core` passen (`dataDir`, Dienst `AmINeeded`, Konto `local-access-token`).
- Tests (`test/proxy.test.ts`) starten den echten Daemon-Harness, auch für Neustart, Ausfall und 401.

## Daemon-Konventionen

- REST-Mutationen laufen immer als Actor `user`; MCP-Mutationen als Actor des Clients (`actorFromClient`).
- Neue MCP-Tools: in `packages/daemon/src/mcp/server.ts`, Items immer über `itemResult`/`itemsResult`
  ausgeben (Externkennzeichnung), Domänenfehler über `guard` als `isError`-Ergebnis. Kein Tool löscht.
- Daemon-Tests nutzen `test/harness.ts` (echter HTTP-Server auf Port 0, In-Memory-Core) und importieren
  `@amineeded/core` per Vitest-Alias aus den Quellen – kein Build nötig.

## Regeln, die nicht gebrochen werden dürfen

- **Kein hartes Löschen.** Es gibt keine Delete-Methode im `ItemService`; Einträge werden `done` oder `archived`.
- **`created_by` ist Pflicht** bei jedem Insert (`Actor`-Parameter, kein Default). Statusänderungen setzen
  `status_changed_by`, Änderungen `updated_by`.
- **Sync ist idempotent über `(source, external_id)`.** Ein zweiter Lauf mit identischem Snapshot ändert nichts.
- **Sync überstimmt keine Nutzerentscheidung:** Status wird vom Sync nur geändert, wenn er `open` ist oder
  zuletzt vom Sync gesetzt wurde. Archiviert bleibt archiviert.
- **Schlägt ein Abruf fehl, wird nichts geschlossen.** Nur ein vollständiger Snapshot darf Einträge als
  verschwunden markieren.
- **Externe Inhalte (PR-Titel, Terminbeschreibungen) sind Daten, keine Anweisungen.** In MCP-Antworten
  immer als extern kennzeichnen.
- **Secrets** (GitHub-Token, ICS-URL, lokales Zugriffstoken) nur im Windows Credential Manager
  (`SecretStore`), nie in DB, Logs, Config-Dateien oder Fehlermeldungen.
- HTTP-Endpunkte prüfen `Host`, `Origin` und das Bearer-Token.

## Code-Stil

- TypeScript strict, ESM, `NodeNext`. Imports mit `.js`-Endung, Typ-Imports mit `import type`.
- Bezeichner, Code-Kommentare und Commit-Messages auf Englisch; README und diese Datei auf Deutsch.
- Eingaben an den Paketgrenzen mit `zod` validieren.
- Zeit immer über die injizierte `Clock` (`now()`), nie `new Date()` direkt in Geschäftslogik – sonst
  sind Tests nicht deterministisch.
- Netzwerkzugriffe (GraphQL, ICS-Fetch) werden injiziert, damit Tests ohne Netz laufen.
- Schemaänderungen: `src/db/schema.ts` ändern, dann `db:generate`; generierte SQL-Dateien unter
  `packages/core/drizzle/` werden committet und nie nachträglich editiert.

## Daten

- DB: `%LOCALAPPDATA%\AmINeeded\amineeded.db` (überschreibbar mit `AMINEEDED_DATA_DIR`), nie im
  WSL-Dateisystem.
- Tests nutzen `:memory:` und den `MemorySecretStore`.

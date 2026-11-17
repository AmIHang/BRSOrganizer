# PR-Skripte

Übernommen aus `C:\projects-git` (PR-Manager-Werkzeuge) und mit der App ausgeliefert
(`runtime\scripts\pr`). Der Daemon startet sie in einem sichtbaren PowerShell-Fenster.

| Skript                  | Aufgabe                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Clone-Branch.ps1`      | PR-Branch nach `<Projektordner>\<Kunde>\PR<Nr>` klonen bzw. aktualisieren, IIS, BORA-Referenzen, NuGet, Build                    |
| `PrIis.ps1`             | IIS-App-Pool und Web-Apps anlegen/entfernen (Adminrechte, UAC)                                                                   |
| `Remove-PrClone.ps1`    | Klon samt App-Pool löschen (nur Ordner mit Markierung `.git\clone-branch`)                                                       |
| `Open-AgentSession.ps1` | Sitzung eines Todo-Agenten im Konsolenfenster öffnen (`claude attach Todo-<id>`)                                                 |
| `Start-TodoAgent.ps1`   | Todo „An Agent weitergeben“: Worktree `<Kunde>\Todo-<id>` anlegen, dort `claude` mit dem Auftrag starten (Agent erstellt den PR) |

Die App ruft `Clone-Branch.ps1` immer mit `-Root <Projektordner>` auf. Dort liegen auch `_refcache`
und ein bei Bedarf geladenes `nuget.exe` – nie im Programmordner.

`_refcache` hält BORA-Referenzen pro Modul und Version (`<Modul>\<Version>`, kundenübergreifend).
Gepatchte Module – ein `ReferenceProjectItem` mit `HintPath` auf ein `.bfpackage` im Repo – haben bei
gleicher Versionsnummer anderen Inhalt: Sie liegen unter `_patched\<Projekt>\<Modul>\<Version>-<Hash>`
(Hash des Pakets), landen nie im kundenübergreifenden Teil und werden bei jedem Lauf frisch eingesetzt.

Die Skripte müssen für Windows PowerShell 5.1 lesbar bleiben: ASCII oder UTF-8 mit BOM.

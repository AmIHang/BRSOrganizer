# PR-Skripte

Übernommen aus `C:\projects-git` (PR-Manager-Werkzeuge) und mit der App ausgeliefert
(`runtime\scripts\pr`). Der Daemon startet sie in einem sichtbaren PowerShell-Fenster.

| Skript                      | Aufgabe                                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Clone-Branch.ps1`          | PR-Branch nach `<Projektordner>\<Kunde>\PR<Nr>` klonen bzw. aktualisieren, IIS, BORA-Referenzen, NuGet, Build                                                                            |
| `PrIis.ps1`                 | IIS-App-Pool und Web-Apps anlegen/entfernen, App-Pool recyceln (Adminrechte, UAC)                                                                                                        |
| `Restart-PrAppPool.ps1`     | App-Pool `PR<Nr>` eines Klons recyceln (startet `PrIis.ps1 -Action Recycle` mit UAC)                                                                                                     |
| `Set-IisUrls.ps1`           | IIS-URLs der Web-Projekte mit Suffix `-<Name>` (von Clone-Branch und Start-TodoAgent genutzt)                                                                                            |
| `Update-BoraReferences.ps1` | BORA-Modulreferenzen mit `_refcache` holen (von Clone-Branch und Start-TodoAgent genutzt)                                                                                                |
| `Remove-PrClone.ps1`        | Klon samt App-Pool löschen (nur Ordner mit Markierung `.git\clone-branch`)                                                                                                               |
| `Open-AgentSession.ps1`     | Sitzung eines Todo-Agenten im Konsolenfenster öffnen (`claude attach Todo-<id>`)                                                                                                         |
| `Start-TodoAgent.ps1`       | Todo „An Agent weitergeben“: Worktree `<Kunde>\Todo-<id>` anlegen, IIS-URLs (nur lokal) und BORA-Referenzen wie beim Klon, dann `claude` mit dem Auftrag starten (Agent erstellt den PR) |

Die App ruft `Clone-Branch.ps1` immer mit `-Root <Projektordner>` auf. Dort liegen auch `_refcache`
und ein bei Bedarf geladenes `nuget.exe` – nie im Programmordner.

`_refcache` hält BORA-Referenzen pro Modul und Version (`<Modul>\<Version>`, kundenübergreifend).
Gepatchte Module – ein `ReferenceProjectItem` mit `HintPath` auf ein `.bfpackage` im Repo – haben bei
gleicher Versionsnummer anderen Inhalt: Sie liegen unter `_patched\<Projekt>\<Modul>\<Version>-<Hash>`
(Hash des Pakets), landen nie im kundenübergreifenden Teil und werden bei jedem Lauf frisch eingesetzt.

Beim Worktree von „An Claude“ bleibt die IIS-URL lokal: ein Clean-Filter (`filter.brsorganizer-iisurl` in der
Repo-Config, `*.csproj` in `.git\info\attributes`) entfernt den Suffix `-Todo-<id>` beim Stagen. Er greift
nur auf diesen Suffix und ändert in anderen Klonen nichts.

Wird ein Element erledigt oder archiviert (auch durch den Sync), räumt der Daemon auf: PR-Klon samt
App-Pool (`Remove-PrClone.ps1`, UAC) und den Worktree des Agenten – nie, wenn noch Arbeit drin ist
(geänderte Dateien, nicht gepushte Commits).

Die Skripte müssen für Windows PowerShell 5.1 lesbar bleiben: ASCII oder UTF-8 mit BOM.

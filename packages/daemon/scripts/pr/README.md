# PR-Skripte

Übernommen aus `C:\projects-git` (PR-Manager-Werkzeuge) und mit der App ausgeliefert
(`runtime\scripts\pr`). Der Daemon startet sie in einem sichtbaren PowerShell-Fenster.

| Skript               | Aufgabe                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Clone-Branch.ps1`   | PR-Branch nach `<Projektordner>\<Kunde>\PR<Nr>` klonen bzw. aktualisieren, IIS, BORA-Referenzen, NuGet, Build |
| `PrIis.ps1`          | IIS-App-Pool und Web-Apps anlegen/entfernen (Adminrechte, UAC)                                                |
| `Remove-PrClone.ps1` | Klon samt App-Pool löschen (nur Ordner mit Markierung `.git\clone-branch`)                                    |

Die App ruft `Clone-Branch.ps1` immer mit `-Root <Projektordner>` auf. Dort liegen auch `_refcache`
und ein bei Bedarf geladenes `nuget.exe` – nie im Programmordner.

Die Skripte müssen für Windows PowerShell 5.1 lesbar bleiben: ASCII oder UTF-8 mit BOM.

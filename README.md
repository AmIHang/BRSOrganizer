# BRSOrganizer

Lokale Windows-App, die eigene Todos, offene Pull Requests (TFS/Azure DevOps, GitHub) und anstehende
Kalendertermine in einer Liste zusammenführt. Sie beantwortet die Frage: **„Wo werde ich gerade gebraucht?“**

Dazu kommen ein PR-Arbeitsbereich (Klonen, Bauen, Mergen), die Anbindung an BSM- und OTMA-Tickets und die
Übergabe von Aufgaben an Claude, der sie im Hintergrund analysiert oder umsetzt. Claude und GitHub Copilot
lesen und schreiben über MCP.

**Inhalt**

1. [Installieren und loslegen](#1-installieren-und-loslegen)
2. [Die Oberfläche](#2-die-oberfläche)
3. [Todos und Termine anlegen](#3-todos-und-termine-anlegen)
4. [Tickets: BSM und OTMA](#4-tickets-bsm-und-otma)
5. [Projekte](#5-projekte)
6. [Der OTMA-Tab](#6-der-otma-tab)
7. [Pull Requests](#7-pull-requests)
8. [Aufgaben an Claude übergeben](#8-aufgaben-an-claude-übergeben)
9. [Benachrichtigungen](#9-benachrichtigungen)
10. [Einstellungen](#10-einstellungen)
11. [Claude und Copilot über MCP](#11-claude-und-copilot-über-mcp)
12. [Quellen im Detail](#12-quellen-im-detail)
13. [Daten, Secrets und Sicherheit](#13-daten-secrets-und-sicherheit)
14. [Für Entwickler](#14-für-entwickler)

---

## 1. Installieren und loslegen

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
5. **Empfohlen:** ⚙ → „BSM/OTMA-Account“ ausfüllen. Damit liest BRSOrganizer Tickets ohne Login-Fenster,
   und Claude kann sie bei einer Übergabe lesen.
6. **Optional:**
   - **Projektordner** (⚙ → „PR-Arbeitsbereich“), falls er nicht gefunden wurde.
   - **GitHub-Token** für GitHub-PRs.
   - **PR-Mails** als Ersatz für TFS.
7. **Claude / Copilot anbinden:** ⚙ → „MCP für Claude & Copilot“ zeigt die fertigen Befehle zum Kopieren
   (siehe [Abschnitt 11](#11-claude-und-copilot-über-mcp)).

Alles für Klonen, Update + Build und Merge ist im Installer enthalten, auch die PowerShell-Skripte. Auf dem
Rechner müssen nur die Werkzeuge vorhanden sein, die das Bauen ohnehin braucht:

- **Git**
- **Visual Studio** (MSBuild)
- **BORA Designer:** für die BORA-Referenzen
- **IIS:** nur für die Web-Apps eines PRs
- **Claude Code CLI** (`claude`): nur für „An Claude“ und Claude-Sitzungen zu PRs

`nuget.exe` lädt das Skript bei Bedarf selbst.

**Update:** Ist eine neue Version auf GitHub, erscheint in der Kopfzeile ein Hinweis zum Herunterladen. Den
neuen Installer einfach darüber installieren. Er beendet den laufenden Hintergrunddienst selbst; Einstellungen,
Todos und Tickets bleiben erhalten.

**Umstieg von AmINeeded** (früherer Name): den BRSOrganizer-Installer einfach ausführen. Er deinstalliert
AmINeeded still, beim ersten Start übernimmt BRSOrganizer Datenbank, Einstellungen und gespeicherte Tokens. Die
alten Daten unter `%LOCALAPPDATA%\AmINeeded` bleiben unangetastet liegen und können später gelöscht werden.
Danach den MCP-Server neu eintragen (⚙ → „MCP für Claude & Copilot“), Name ist jetzt `brsorganizer`; den alten
Eintrag entfernen, z. B. `claude mcp remove amineeded --scope user`.

---

## 2. Die Oberfläche

### Fenster und Tray

- **Schließen** blendet das Fenster nur aus. Ein-/Ausblenden mit **Strg+Alt+N** oder Klick aufs Tray-Icon.
- **Tray-Menü:** Öffnen, Jetzt synchronisieren, Beenden.
- **Als Administrator:** Die installierte App läuft immer mit Adminrechten. So brauchen die IIS-Schritte
  (Klonen, App-Pool recyceln, Lokal löschen) keine UAC-Abfrage mehr, und Visual Studio startet für die
  IIS-Web-Projekte gleich als Admin. Ein manueller Start fragt einmal per UAC. Links (Tickets, Web-Apps) öffnen
  trotzdem im normalen Browser. Startet ein MCP-Client den Daemon vor der App, läuft er ohne Adminrechte, bis
  er neu startet.
- **Autostart:** beim ersten Start eingeschaltet, abschaltbar in den Einstellungen. Die App startet dann
  unsichtbar im Tray, über die Aufgabenplanung (Aufgabe `BRSOrganizer`, beim Anmelden, ohne UAC-Abfrage).
- **Hintergrunddienst (Daemon):** Die App startet ihn, falls er nicht läuft. Er läuft auch nach dem Beenden der
  App weiter, damit Claude und Copilot ihn über MCP erreichen.

### Kopfzeile

| Element              | Wirkung                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Liste** / **OTMA** | Umschalten zwischen der Hauptliste und dem [OTMA-Tab](#6-der-otma-tab). Die Zahl am Tab zählt neue OTMA-Tickets. |
| Pin                  | „Immer im Vordergrund“ ein/aus (bleibt gespeichert)                                                              |
| ⟳                    | Jetzt synchronisieren (im OTMA-Tab: OTMA-Tickets neu laden)                                                      |
| Update-Hinweis       | Erscheint nur, wenn es eine neuere Version gibt; Klick lädt sie herunter                                         |
| ⚙                    | [Einstellungen](#10-einstellungen)                                                                               |
| **+** (unten rechts) | Neues Todo oder neuer Termin                                                                                     |

Fehlt noch etwas Wichtiges, zeigt die Liste oben einen Hinweis: keine Quelle eingerichtet, oder TFS-PRs ohne
Projektordner.

### Bereiche der Liste

Die Einträge sind nach Dringlichkeit in Bereiche sortiert:

| Bereich            | Inhalt                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Überfällig**     | Todos, deren Fälligkeit vorbei ist (rot)                                                                             |
| **Jetzt**          | Termine, die gerade laufen oder in der nächsten Stunde beginnen; Todos, die in der nächsten Stunde fällig sind (rot) |
| **Aufgaben**       | Alle Pull Requests und alle Todos, die einem Projekt zugeordnet sind, gruppiert nach Kunde                           |
| **Heute**          | Was heute noch fällig ist oder beginnt                                                                               |
| **Ohne Termin**    | Todos ohne Fälligkeit und ohne Projekt                                                                               |
| **Nächste 7 Tage** | Was in den nächsten sieben Tagen ansteht                                                                             |
| **Später**         | Alles danach                                                                                                         |

Termine erscheinen erst 48 Stunden vor Beginn und verschwinden, sobald sie vorbei sind.

**Einklappen:** Ein Klick auf eine Bereichs- oder Kunden-Überschrift klappt sie ein oder aus. Das bleibt
gespeichert.

### Der Bereich „Aufgaben“

- **Kunden-Gruppen:** Pull Requests und Projekt-Todos stehen unter ihrem Kunden. Die Kunden sind alphabetisch
  sortiert, „Sonstige“ (kein Kunde erkennbar) kommt zuletzt.
- **Reihenfolge in einer Gruppe:** zuerst Review-Anfragen, dann aktive PRs (neueste zuerst), dann Entwürfe.
  Einträge auf [On hold](#on-hold) stehen immer ganz unten.
- **+ an der Kunden-Überschrift:** neues Todo direkt in diesem Projekt.
- **Filter:** Der Button „Filter“ rechts in der Überschrift öffnet eine Liste aller Kunden mit Checkboxen.
  Ohne Haken ist der Kunde ausgeblendet. Ausgeblendete Kunden zeigt der Button an („Filter (2 ausgeblendet)“),
  „Alle anzeigen“ hebt den Filter auf. Die Zahl neben „Aufgaben“ zählt nur Sichtbares. Die Auswahl bleibt
  gespeichert.

### Eine Zeile

- **Titel:** Klick öffnet den Link (PR, Teams-Link eines Termins …).
- **PR-Nummer:** Klick kopiert sie in die Zwischenablage.
- **Chips** in der Zeile darunter:
  - Grund bei PRs: `Review`, `abgestimmt`, `eigener PR`, `zugewiesen`, `Info`
  - deine Stimme bei TFS-PRs: `genehmigt`, `genehmigt mit Vorschlägen`, `wartet auf Autor`, `abgelehnt`
  - `Entwurf` bei Draft-PRs
  - BSM- und OTMA-Ticket (Klick öffnet das Ticket, siehe [Abschnitt 4](#4-tickets-bsm-und-otma))
  - `von claude` / `von copilot`, wenn ein Assistent das Todo angelegt hat
  - Status und Aktionen von Claude (siehe [Abschnitt 8](#8-aufgaben-an-claude-übergeben))
- **Anweisung:** Bei Todos steht die Anweisung für Claude (falls vorhanden) unter der Zeile.
- **Checkbox** (Todos): erledigt / wieder offen.
- **„…“-Menü:** alle Aktionen des Eintrags (siehe unten).

### Das „…“-Menü

| Eintrag                         | Für                  | Wirkung                                                    |
| ------------------------------- | -------------------- | ---------------------------------------------------------- |
| Klonen + Build / Update + Build | TFS-PRs              | siehe [Abschnitt 7](#7-pull-requests)                      |
| Solution öffnen                 | geklonte TFS-PRs     | öffnet die PR-Solution in Visual Studio                    |
| Accept & Merge                  | TFS-PRs              | genehmigen, Squash-Merge, Branch löschen                   |
| Details                         | TFS-PRs              | klappt das PR-Panel auf                                    |
| Tickets …                       | Todos, PRs           | BSM- und OTMA-Ticket setzen oder entfernen                 |
| In Projekt verschieben …        | Todos                | Projekt zuordnen oder entfernen                            |
| On hold / On hold aufheben      | offene Todos und PRs | siehe [On hold](#on-hold)                                  |
| An Claude abbrechen             | Todos bei Claude     | stoppt die Sitzung, das Todo wird wieder ein normales Todo |
| Worktree entfernen              | Todos nach Claude    | räumt den Worktree des Agenten weg                         |
| Archivieren                     | alle                 | blendet den Eintrag aus (nichts wird gelöscht)             |

### On hold

PRs und offene Todos, an denen gerade nichts passiert, lassen sich über „…“ → **On hold** zurückstellen:

- Sie werden **ausgegraut** und **kompakt** dargestellt: Titel in einer Zeile, daneben nur noch der Chip
  „On hold“, die PR-Nummer und die Tickets.
- Sie stehen **immer unten** in ihrer Kunden-Gruppe bzw. ihrem Bereich.
- Ein Klick auf den Chip „On hold“ (oder „…“ → „On hold aufheben“) holt sie zurück.

„On hold“ ist eine Ansicht der App. Der Sync behandelt den Eintrag ganz normal: Ein gemergter PR verschwindet
trotzdem. Claude und Copilot sehen über MCP nicht, dass ein Eintrag zurückgestellt ist.

### Archivieren statt Löschen

BRSOrganizer löscht nie etwas. Erledigte Todos und archivierte Einträge verschwinden aus der Liste, bleiben aber
in der Datenbank. Archiviert bleibt archiviert, auch wenn eine Quelle den Eintrag weiter liefert.

---

## 3. Todos und Termine anlegen

Über **+** unten rechts (oder **+** an einer Kunden-Überschrift, dann gleich im Projekt).

### Todo

| Feld                 | Pflicht | Bedeutung                                            |
| -------------------- | ------- | ---------------------------------------------------- |
| Text (Titel)         | *       | Was zu tun ist                                       |
| Fällig               | nein    | Datum und Uhrzeit; bestimmt den Bereich in der Liste |
| BSM-Ticket           | *       | Schlüssel (`BRS_PWg0127`) oder URL                   |
| OTMA-Ticket          | *       | Nummer (`148082`) oder URL                           |
| Anweisung für Claude | nein    | mehrzeilig; was Claude bei einer Übergabe tun soll   |

\* **Mindestens eines** von Titel, BSM-Ticket oder OTMA-Ticket ist nötig.

- **Ohne Titel** wird das Todo sofort mit der Ticketnummer als Titel angelegt (`BRS_PWg0127` bzw.
  `OTMA 148082`). Im Hintergrund liest BRSOrganizer den Titel des BSM-Tickets, ersatzweise des OTMA-Tickets, und
  ersetzt die Nummer damit. Hast du den Titel inzwischen selbst geändert, bleibt deiner stehen.
- **Projekt-Vorschlag:** Kennt BRSOrganizer den Kunden des Tickets (siehe
  [Zuordnung](#zuordnung-ticket--projekt)), schlägt der Dialog das Projekt vor. Hat das Todo noch kein Projekt,
  ist der Vorschlag schon angehakt. Kommt das Todo aus einem anderen Projekt (über **+** an der Überschrift),
  fragt der Dialog, ob das Projekt geändert werden soll; ohne Haken bleibt es.
- **Anweisung:** siehe [Abschnitt 8](#8-aufgaben-an-claude-übergeben). Sie wird als Notiz des Todos
  gespeichert und unter der Zeile angezeigt.

### Termin

Titel, Beginn und Dauer (15 Minuten bis 2 Stunden). Eigene Termine erscheinen wie Kalendertermine und fallen
nach ihrem Ende aus der Liste.

---

## 4. Tickets: BSM und OTMA

An Todos und PRs lassen sich ein BSM- und ein OTMA-Ticket hinterlegen: beim Anlegen eines Todos, über „…“ →
„Tickets …“ oder per MCP (`set_tickets`, `add_todo`).

- **BSM:** Es genügt der Schlüssel, z. B. `BRS_PWg0127`. Daraus wird
  `https://bsm.boomsoftware.com/indication/BRS_PWg0127`.
- **OTMA:** Es genügt die Nummer, z. B. `148082` oder `#148082`. Daraus wird
  `https://otma.boomsoftware.com/ap/148082`.
- **Anzeige:** Beide erscheinen als Chip in der Zeile, BSM mit dem Schlüssel, OTMA mit „OTMA …“. Ein Klick
  öffnet das Ticket.
- **Das andere Ticket ergänzen:** Hat ein Todo oder PR nur eines der beiden Tickets, ergänzt BRSOrganizer im
  Hintergrund das andere: das BSM-Ticket, das im OTMA-Ticket steht, bzw. das OTMA-Ticket des
  Hauptarbeitspakets im BSM-Ticket.
- **Sync:** Ticket-Links bleiben bei jedem Sync erhalten, auch an PRs aus TFS oder GitHub.

### Anmeldung an BSM und OTMA

BRSOrganizer liest Tickets über ein eigenes Edge-Profil im Datenordner. Beide Systeme hängen am selben
Keycloak-Login:

- Ist der **BSM/OTMA-Account** in den Einstellungen hinterlegt, meldet sich BRSOrganizer damit unsichtbar an
  (nur auf `auth.boomsoftware.com`, einmal pro Versuch).
- Sonst, oder wenn das scheitert, öffnet sich ein Edge-Fenster zum Anmelden.

### Zuordnung Ticket → Projekt

BRSOrganizer merkt sich, zu welchem Projekt die Tickets eines Kunden gehören, und schlägt es künftig vor:

- **BSM-Kunde:** alles vor dem letzten Kleinbuchstaben der Ticketnummer, z. B. `STBBRSg0034` → `STBBRS`,
  `BRS_PWg0127` → `BRS_PW`. Funktioniert für jedes BSM-Ticket, auch ohne Login.
- **OTMA-Projekt:** z. B. „STB BRS [STBBRS]“. Bekannt nur für Tickets aus deiner OTMA-Liste (siehe
  [OTMA-Tab](#6-der-otma-tab)).
- Der BSM-Kunde hat **Vorrang** vor dem OTMA-Projekt.
- **Gelernt** wird automatisch: Bekommt ein Todo mit Ticket ein Projekt, merkt sich BRSOrganizer die Zuordnung
  für dessen BSM-Kunden und OTMA-Projekt, sofern es dafür noch keine gibt. Beim Übernehmen aus dem OTMA-Tab
  überschreibt deine Auswahl eine bestehende Zuordnung.
- **Verwalten:** ⚙ → „OTMA-Tickets“ listet beide Zuordnungen, jede lässt sich entfernen.

Der Vorschlag erscheint beim Anlegen eines Todos, im Dialog „Tickets …“ und beim Übernehmen aus dem OTMA-Tab.

---

## 5. Projekte

Ein Projekt entspricht einem **Kundenordner** im Projektordner (z. B. `C:\projects-git\Community`). Todos
lassen sich einem Projekt zuordnen; sie stehen dann unter „Aufgaben“ beim Kunden, und nur sie lassen sich an
Claude übergeben.

- **Woher Projekte kommen:** aus den Pull Requests (das Azure-DevOps-Projekt bzw. der GitHub-Owner) und von Hand
  angelegte (⚙ → „Projekte“).
- **Projekte aus PRs bleiben:** Sobald ein PR-Projekt auftaucht, wird es gespeichert. Es bleibt in der Liste,
  auch wenn es keinen offenen PR mehr dazu gibt.
- **Entfernen:** ⚙ → „Projekte“ → „Entfernen“. Ein Projekt, das noch offene PRs hat, wird dabei ausgeblendet,
  damit es nicht beim nächsten Sync zurückkommt. Neu hinzufügen holt es zurück.
- **Zuordnen:** beim Anlegen (über **+** an der Kunden-Überschrift), über „…“ → „In Projekt verschieben …“ oder
  per Vorschlag aus dem Ticket.

---

## 6. Der OTMA-Tab

Der Tab **OTMA** zeigt deine offenen OTMA-Arbeitspakete, direkt aus OTMA gelesen (beim ersten Mal öffnet sich
evtl. die Anmeldung). Er lädt sich alle 10 Minuten neu, ⟳ lädt sofort.

- **Neu:** Tickets, die seit dem letzten Besuch des Tabs dazugekommen sind, zählt die Zahl am Tab. Beim Öffnen
  des Tabs sind sie mit „Neu“ markiert.
- **Suchen:** nach OTMA-Nummer (`178333`, `#178333`) oder einem Stück des Titels, z. B. dem BSM-Schlüssel.
- **Klick auf ein Ticket** öffnet es in OTMA.
- **→ Todo:** übernimmt das Ticket als Todo, mit Titel, OTMA- und BSM-Ticket. Der Dialog schlägt das Projekt
  vor ([Zuordnung](#zuordnung-ticket--projekt)). „Anlegen & an Claude“ übergibt das neue Todo gleich an
  Claude (dafür ist ein Projekt nötig). Gibt es schon ein offenes Todo zum Ticket, steht dort „✓ Todo“.
- **⊘ Ignorieren:** blendet ein Ticket aus, bis sich sein Änderungsdatum ändert. „Ignorierte“ zeigt sie
  wieder an, ↺ holt eines zurück.
- **Einstellungen:** ⚙ → „OTMA-Tickets“: Tab ein-/ausblenden, alle ignorieren, alle wieder anzeigen.

---

## 7. Pull Requests

PRs kommen aus TFS/Azure DevOps, GitHub oder (als Ersatz) aus PR-Mails, siehe
[Quellen im Detail](#12-quellen-im-detail). Ein PR verschwindet aus der Liste, sobald er abgeschlossen oder
aufgegeben ist.

### Der PR-Arbeitsbereich (nur TFS-PRs)

Voraussetzung ist der **Projektordner** in den Einstellungen, z. B. `C:\projects-git`. Darunter liegt pro Kunde
ein Ordner mit dem Repo. Der passende Kundenordner wird über die Remote-URL gefunden, die Ordnernamen sind
also frei wählbar. Geklont wird nach `<Kunde>\PR<Nr>`.

### Die Punkte an einem PR

**Unter dem PR-Symbol – Klon-Stand** (ein Klick führt die passende Aktion aus):

| Punkt       | Bedeutung                                  | Klick           |
| ----------- | ------------------------------------------ | --------------- |
| Ring (lila) | noch nicht geklont                         | Klonen + Build  |
| orange      | neue Commits auf dem Server                | Update + Build  |
| grün        | geklont und aktuell                        | Solution öffnen |
| grau        | Branch existiert auf dem Server nicht mehr | –               |

**Vor dem Titel – Web-App (hellblau):** erscheint, sobald der Klon Web-Projekte im IIS hat. Bei einer
Web-App öffnet ein Klick sie direkt im Browser, bei mehreren kommt eine Auswahl der Pfade (z. B.
`/CommunityAsset-PR4384/`); geöffnet wird nur die gewählte.

**Unter dem Klon-Stand – ↻ App-Pool recyceln:** startet den IIS-App-Pool `PR<Nr>` des Klons neu (z. B. wenn
die Web-App nach einem Build alte DLLs hält); ein gestoppter Pool wird gestartet.

Der Klon-Stand wird alle 3 Minuten geprüft (mit `git fetch`), nach jeder Aktion sofort.

### Klonen + Build / Update + Build

`Clone-Branch.ps1` läuft in einem eigenen PowerShell-Fenster. Es

1. klont nach `<Kunde>\PR<Nr>` bzw. aktualisiert den Klon,
2. hängt an die IIS-URLs der Web-Projekte `-PR<Nr>` an und richtet den IIS-App-Pool `PR<Nr>` ein (UAC),
3. holt die BORA-Referenzen (Cache `_refcache` im Projektordner),
4. stellt NuGet wieder her und baut.

Am Ende listet das Fenster Ordner, Commit, Link und die Web-URLs. Dieselben URLs öffnet der hellblaue Punkt.

### Details (PR-Panel)

„…“ → **Details** klappt unter dem PR ein Panel auf:

- **Details:** Branch → Ziel, Status, Merge-Status, Autor, Reviewer mit Stimme
- **Lokaler Stand:** geklont oder nicht, letzter Commit, neue Commits auf dem Server
- **Aktionen:** Klonen & bauen / Aktualisieren & bauen, Solution, Ordner, Web-App, **Lokal löschen**
  (`Remove-PrClone.ps1` mit UAC; nur Ordner, die das Skript angelegt hat), **PR abschließen**

### Accept & Merge

„…“ → **Accept & Merge** (oder „PR abschließen“ im Panel):

1. mit „Genehmigt“ abstimmen,
2. Squash-Merge des Source-Branches in den Ziel-Branch,
3. Source-Branch auf dem Server löschen.

Optional wird danach der lokale Klon gelöscht. Dabei schließt BRSOrganizer Visual Studio mit der PR-Solution
und entfernt den IIS-App-Pool.

### Automatisch aufräumen

Verlässt ein Eintrag die Liste (PR abgeschlossen oder aufgegeben, Todo erledigt, etwas archiviert), räumt
BRSOrganizer seine lokalen Reste auf: den PR-Klon samt IIS-App-Pool und den Worktree eines Claude-Agenten.
**Nichts mit Arbeit darin wird gelöscht:** Ein Klon mit nicht committeten oder nicht gepushten Änderungen
bleibt, ebenso ein Worktree mit eigenen Änderungen oder neuen Dateien. Die Änderungen der Skripte selbst
(IIS-URLs mit `-PR<Nr>` bzw. `-Todo-<id>`, kompilierte `.js` neben `.ts`) zählen dabei nicht. Was passiert ist
oder warum etwas bleibt, meldet eine Windows-Benachrichtigung („Aufräumen: …“).

### Claude-Sitzung zu einem PR

Der Chip **Claude** an einem offenen TFS-PR öffnet eine Claude-Sitzung zum PR im Terminal. Gibt es schon
eine (auch die des Todos, aus dem der PR entstand), wird sie fortgesetzt; sonst startet eine neue im
PR-Ordner. Claude verschafft sich einen Überblick über die Änderungen, fasst sie zusammen und wartet dann auf
dich; committet und gepusht wird nur auf Anweisung.

### Modul-Cache

⚙ → „PR-Arbeitsbereich“ zeigt die Größe des BORA-Modul-Caches (`_refcache`). „Leeren“ löscht ihn; der nächste
Klon lädt die Module neu und dauert entsprechend länger. Nicht während eines laufenden Klons.

Diese Aktionen gibt es nur in der App. Claude und Copilot können über MCP weder Skripte starten noch mergen
oder löschen.

---

## 8. Aufgaben an Claude übergeben

Ein Todo in einem Projekt lässt sich an einen Claude-Agenten übergeben, der im Hintergrund daran arbeitet.

### Übergeben

Chip **An Claude** am Todo. Der Dialog fragt nach:

- **Projekt:** Pflicht; das Todo wird dabei in das Projekt verschoben.
- **Anweisung (optional, mehrzeilig):** was Claude tun soll. Vorausgefüllt mit der bisherigen Anweisung, hier
  änderbar.

Dann:

1. BRSOrganizer liest BSM- und OTMA-Ticket (Text, Kommentare, eingefügte Bilder, Dokumente) und legt sie für
   den Agenten als Dateien ab. Klappt das Lesen nicht, bekommt der Agent nur den Link.
2. `Start-TodoAgent.ps1` legt im Repo des Projekts einen Worktree `<Kunde>\Todo-<id>` auf einem neuen Branch
   vom Standard-Branch an. Die IIS-URLs bekommen dort lokal den Suffix `-Todo-<id>`.
3. Claude startet dort als Hintergrundsitzung (`claude --bg`, Berechtigungsmodus `auto`: Claude erlaubt die
   üblichen Schritte selbst und hält Riskantes an).

**Was Claude bekommt:** Projekt, Tickets und deine Anweisung, in dieser Priorität: Anweisung vor OTMA-Ticket
(intern) vor BSM-Ticket (Kunde). Der **Titel des Todos geht nicht mit**, er ist nur die Beschriftung in der
Liste.

### Mit oder ohne Anweisung

- **Mit Anweisung:** Claude setzt die Aufgabe um, benennt den Branch passend (`feature/<name>-<id>`),
  committet (mit dem Ticket-Schlüssel als Scope, z. B. `fix(BRS_PWg0127): …`), pusht und erstellt den PR.
  Verlangt die Anweisung nur eine Analyse oder Schätzung, setzt er nichts um.
- **Ohne Anweisung:** Claude **analysiert das Ticket und schlägt eine Umsetzung vor**: betroffene Stellen,
  Ursache, konkreter Umsetzungsvorschlag, offene Fragen und eine Aufwandschätzung in Personentagen. Er ändert
  nichts und erstellt keinen PR. Die Analyse erscheint als „Antwort“.

### Status am Todo

Ein übergebenes Todo zeigt statt der Checkbox das Symbol ✦ (blau, solange Claude arbeitet; grau, wenn er
pausiert). Dazu ein Chip:

| Chip                    | Bedeutung                                                                    | Klick                              |
| ----------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| Claude arbeitet         | Der Agent läuft.                                                             | öffnet die Sitzung im Terminal     |
| Rückfrage von Claude    | Er wartet mitten in der Arbeit auf eine Freigabe oder Antwort.               | öffnet die Sitzung im Terminal     |
| Claude wartet + Antwort | Er hat seine Runde beendet (z. B. die Analyse) und wartet auf dich.          | „Antwort“ zeigt seinen Text        |
| Claude pausiert         | Die Sitzung läuft nicht mehr (Neustart, Absturz, anderswo beendet), ohne PR. | setzt die Sitzung im Terminal fort |

Rückfragen, Antworten und „Claude pausiert“ melden sich zusätzlich per Windows-Benachrichtigung.

Reinschauen und eingreifen geht auch direkt: `claude agents` bzw. `claude attach Todo-<id>`.

### Wenn der PR da ist

Sobald der Sync den PR des Agenten findet (gleicher Source-Branch im gleichen Projekt), wird aus dem Todo der
PR-Eintrag: Der PR übernimmt BSM- und OTMA-Ticket, das Todo ist erledigt. Der Worktree bleibt, bis der PR die
Liste verlässt, dann wird er [aufgeräumt](#automatisch-aufräumen).

### Abbrechen und aufräumen

- **„…“ → An Claude abbrechen:** stoppt die Sitzung; das Todo wird wieder ein normales Todo.
- **„…“ → Worktree entfernen:** räumt den Worktree weg. Hat er nur die Änderungen des Skripts (IIS-URLs mit
  `-Todo-<id>`), wird er trotzdem entfernt. Mit anderen nicht committeten Änderungen oder neuen Dateien lehnt
  git ab, es geht nichts verloren. Der Branch wird nur gelöscht, wenn er gemergt ist; Commits bleiben also
  immer.
- Solange der Worktree einer früheren Übergabe besteht, gibt es kein neues „An Claude“: erst fortsetzen
  („Claude pausiert“ anklicken) oder den Worktree entfernen.

### Voraussetzungen

- Claude Code CLI ist installiert.
- Claude vertraut dem Projektordner: einmal `claude` z. B. in `C:\projects-git` starten und bestätigen.
  Sonst startet `claude` in einem eigenen Fenster statt im Hintergrund.
- Der BSM/OTMA-Account ist hinterlegt, damit der Agent die Tickets selbst lesen kann. Er bekommt ihn nur über
  die Umgebungsvariablen `BRS_TICKET_USER` / `BRS_TICKET_PASSWORD`, nie über Datei oder Kommandozeile.

---

## 9. Benachrichtigungen

Windows-Benachrichtigungen gibt es für:

- jede **neue Review-Anfrage**,
- **Termine**, 10 Minuten vor Beginn,
- Claude: **Rückfrage**, **Antwort**, **pausiert**,
- das **Aufräumen** nach einem PR oder Todo (was gelöscht wurde oder warum etwas bleibt).

---

## 10. Einstellungen

Über ⚙ in der Kopfzeile. Hinter jeder Quelle steht ihr Zustand (bereit, nicht eingerichtet, Fehler …).

| Abschnitt                     | Inhalt                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **GitHub**                    | PRs abrufen; zusätzlich mir zugewiesene und eigene PRs; Personal Access Token (Lesezugriff auf PRs)        |
| **Kalender**                  | Termine abrufen; Quelle Outlook oder ICS-Feed (URL); Tage im Voraus                                        |
| **TFS / Azure DevOps**        | PRs abrufen; Collection-URL; eigene PRs; optionaler Token (sonst Windows-Anmeldung)                        |
| **PR-Arbeitsbereich**         | Projektordner; Modul-Cache anzeigen und leeren                                                             |
| **Projekte**                  | Projekte hinzufügen und entfernen (siehe [Abschnitt 5](#5-projekte))                                       |
| **BSM/OTMA-Account**          | ein Login für beide Systeme                                                                                |
| **OTMA-Tickets**              | Tab ein/aus; alle ignorieren / wieder anzeigen; Zuordnungen BSM-Kunde → Projekt und OTMA-Projekt → Projekt |
| **PR-Mails (Outlook)**        | Ersatzquelle für PRs: Ordner, Zeitraum in Tagen                                                            |
| **Allgemein**                 | Sync-Intervall in Minuten; mit Windows starten; Tastenkürzel                                               |
| **Letzte Synchronisierungen** | die letzten Läufe je Quelle mit Ergebnis oder Fehler                                                       |
| **MCP für Claude & Copilot**  | fertige Befehle zum Kopieren                                                                               |

Tokens, Passwort und ICS-URL werden nie angezeigt, nur ob sie gesetzt sind. Gespeichert sind sie in der
Windows-Anmeldeinformationsverwaltung.

---

## 11. Claude und Copilot über MCP

Über MCP können Claude und Copilot die Liste lesen, Todos anlegen und ändern, Tickets setzen und einen Sync
anstoßen. Löschen, Skripte, Merge und Claude-Übergaben gibt es über MCP bewusst nicht.

### Einrichten

**Mit installierter App:** In den Einstellungen unter „MCP für Claude & Copilot“ stehen die Befehle mit den
richtigen Pfaden zum Kopieren. Sie rufen die mitgelieferte `brsorganizer-node.exe` mit `runtime\mcp-stdio.mjs`
auf.

**Aus dem Repo (Entwicklung):** wie folgt. Empfohlen ist für alle Clients die stdio-Brücke `mcp-stdio`:

- Sie liest das Zugriffstoken aus der Windows-Anmeldeinformationsverwaltung. **In keiner
  Client-Konfiguration steht ein Secret.**
- Läuft der Daemon nicht, startet sie ihn.
- Startet der Daemon neu, baut sie die Sitzung transparent wieder auf.
- Sie funktioniert auch aus WSL heraus.

Voraussetzung ist ein Build (`pnpm install && pnpm build`). Im Folgenden steht `<repo>` für den Repo-Pfad,
z. B. `C:\projects-git\BRSOrganizer\BRSOrganizer`. Die Option `--client claude|copilot` legt fest, was in
`created_by` landet. Ohne sie wird der Wert aus dem Client-Namen abgeleitet.

#### Claude Code (Windows)

```bash
claude mcp add brsorganizer --scope user -- node "<repo>\packages\mcp-stdio\dist\main.js" --client claude
```

#### Claude Code in WSL

In WSL zeigt `127.0.0.1` (NAT-Modus) nicht auf Windows. Deshalb startet Claude Code die **Windows**-`node.exe`
per Interop. Der Pfad zum Skript wird als Windows-Pfad übergeben:

```bash
claude mcp add brsorganizer --scope user -- "/mnt/c/Program Files/nodejs/node.exe" 'C:\projects-git\BRSOrganizer\BRSOrganizer\packages\mcp-stdio\dist\main.js' --client claude
```

So laufen Proxy und Daemon in Windows, mit Zugriff auf `%LOCALAPPDATA%` und die Anmeldeinformationsverwaltung.
Netzwerkkonfiguration ist nicht nötig.

#### Claude Desktop

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

#### VS Code / GitHub Copilot

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

#### Optionen von `mcp-stdio`

| Option                     | Bedeutung                                                     |
| -------------------------- | ------------------------------------------------------------- |
| `--client claude\|copilot` | Wert für `created_by`                                         |
| `--port <n>`               | Daemon-Port (sonst `BRSORGANIZER_PORT`, `daemon.json`, 47821) |
| `--no-start-daemon`        | Daemon nicht automatisch starten                              |
| `--daemon-main <pfad>`     | Anderer Daemon-Einstiegspunkt (sonst der Build im Repo)       |

Diagnosemeldungen gehen nach stderr, stdout gehört dem Protokoll.

#### Alternative: HTTP direkt

Clients mit Streamable-HTTP-Unterstützung können `http://127.0.0.1:47821/mcp` direkt ansprechen. Dann muss das
Token als Header `Authorization: Bearer <token>` in der Client-Konfiguration stehen, also im Klartext (z. B. in
`~/.claude.json`). Deshalb ist diese Variante nicht empfohlen. Aus WSL geht sie nur mit
`networkingMode=mirrored` in `%USERPROFILE%\.wslconfig`.

### MCP-Tools

| Tool            | Wirkung                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `list_items`    | Einträge auflisten (`type`, `status`, `due_before`, `limit`)             |
| `get_item`      | Einen Eintrag lesen                                                      |
| `add_todo`      | Todo anlegen (`title`, `due_at`, `link`, `notes`, `bsm_url`, `otma_url`) |
| `update_todo`   | Todo ändern (auch `project`); `null` leert ein Feld                      |
| `set_tickets`   | BSM- und/oder OTMA-Ticket eines Todos oder PRs setzen oder entfernen     |
| `complete_todo` | Todo erledigen                                                           |
| `archive_item`  | Beliebigen Eintrag ausblenden, auch PRs und Termine                      |
| `sync_sources`  | Alle Quellen sofort abrufen                                              |

`created_by` ergibt sich aus dem Client-Namen beim Verbindungsaufbau (Claude → `claude`, VS Code/Copilot →
`copilot`, sonst `other`). Der Header `X-BRSOrganizer-Client: claude|copilot` legt ihn fest. Inhalte von PRs und
Terminen stehen in MCP-Antworten im Feld `external_content` mit `origin: "external:…"` und einem Hinweis, dass
es sich um Daten und nicht um Anweisungen handelt.

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

---

## 12. Quellen im Detail

Alle Quellen werden im eingestellten Intervall abgerufen (Standard 5 Minuten), ⟳ ruft sofort ab. Schlägt ein
Abruf fehl, wird nichts geschlossen; erst ein vollständiger Abruf darf Einträge als verschwunden markieren.

- **TFS / Azure DevOps:** aktive PRs über die REST-API, mit zwei Abfragen auf Collection-Ebene (du als
  Reviewer, eigene PRs). Ein Abschluss oder Abbruch entfernt den PR beim nächsten Sync.
  - **Anmeldung:** Ohne Token wird die Windows-Anmeldung genutzt (integrierte Authentifizierung), es ist
    also kein Secret nötig. Ein optionaler PAT kommt in die Anmeldeinformationsverwaltung, etwa für
    dev.azure.com oder außerhalb der Domäne.
  - **Kennzeichnung:** `Review`, solange du noch nicht abgestimmt hast; danach `abgestimmt` mit deiner
    Stimme. Eigene PRs heißen `eigener PR`. Dass du dich selbst als Reviewer einträgst, zählt dabei nicht
    als Review-Anfrage.
- **GitHub:** GraphQL-Suche nach offenen PRs mit `review-requested:@me` und optional `assignee:@me` und
  `author:@me`. PRs, die nicht mehr in der Suche auftauchen (gemergt, Review erledigt), werden automatisch
  erledigt.
- **Kalender:** Termine der nächsten 14 Tage (konfigurierbar); in der Liste erscheinen sie ab 48 Stunden vor
  Beginn. Vorbei ist erledigt. Zwei Quellen stehen zur Wahl:
  - **Outlook:** der Standardkalender im klassischen Outlook, gelesen über COM ohne Anmeldung. Serien werden
    aufgelöst, abgesagte Termine und abgelehnte Einladungen ausgelassen. Ein Teams-Link wird zum Klick-Ziel,
    verschobene Termine werden aktualisiert.
  - **ICS-Feed:** eine URL aus der Anmeldeinformationsverwaltung, inklusive Serien, Ausnahmen und Absagen.
- **PR-Mails (Fallback, Azure DevOps Server über Outlook):** läuft nur, solange TFS nicht eingerichtet ist.
  Beide Quellen verwenden dieselben IDs, beim Umschalten entstehen also keine doppelten Einträge. Liest einen
  Ordner im klassischen Outlook, Standard `Posteingang/PR`, über COM. Dafür ist keine Anmeldung nötig, es wird
  das laufende Outlook-Profil genutzt.
  - Jede PR-Benachrichtigung von Azure DevOps Server zählt, also z. B. „erstellt“, „Reviewer hinzugefügt“
    oder „Push“. Ein PR erscheint ab der ersten solchen Mail.
  - Ein PR verschwindet, sobald eine Mail „abgeschlossen“ meldet, egal in welcher Reihenfolge die Mails
    ankommen. Bei „aufgegeben“ verschwindet er auch, außer ein späteres „reaktiviert“ hebt das auf.
  - Erkannt wird, ob du als Reviewer eingetragen bist (`Review`, mit Benachrichtigung), ob der PR von dir ist
    (`eigener PR`) oder ob du nur informiert wirst (`Info`).
  - Berücksichtigt werden Mails der letzten 90 Tage (einstellbar). Ein älterer PR ohne Abschluss-Mail fällt
    aus dem Zeitraum und damit aus der Liste.
  - Ist Outlook nicht lesbar, wird nichts geschlossen.

**Der Sync überstimmt dich nicht:** Er ändert den Status eines Eintrags nur, wenn dieser offen ist oder zuletzt
vom Sync gesetzt wurde. Archiviert bleibt archiviert.

---

## 13. Daten, Secrets und Sicherheit

| Was                                                                       | Wo                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Datenbank                                                                 | `%LOCALAPPDATA%\BRSOrganizer\brsorganizer.db` (SQLite, WAL), überschreibbar mit `BRSORGANIZER_DATA_DIR` |
| Einstellungen (inkl. Projekte, Zuordnungen, Ansicht)                      | in der Datenbank                                                                                        |
| GitHub-Token, TFS-Token, ICS-URL, BSM/OTMA-Account, lokales Zugriffstoken | Windows-Anmeldeinformationsverwaltung, Dienst `BRSOrganizer`                                            |
| Edge-Profil für BSM/OTMA                                                  | `%LOCALAPPDATA%\BRSOrganizer\edge-profile`                                                              |
| Aufgaben und Ticket-Dateien für Claude                                    | `%LOCALAPPDATA%\BRSOrganizer\agent-tasks`                                                               |
| Logs, `daemon.json` (PID und Port)                                        | `%LOCALAPPDATA%\BRSOrganizer\logs`, `%LOCALAPPDATA%\BRSOrganizer\daemon.json`                           |

Die ICS-URL gilt als Secret, weil private Kalender-Feeds (Google „geheime Adresse“, Outlook „Veröffentlichter
Kalender“) den Zugriffsschlüssel in der URL tragen. Secrets stehen nie in Datenbank, Logs, Konfigurationsdateien
oder Fehlermeldungen.

**Sicherheit des Daemons:** Er lauscht nur auf `127.0.0.1`. Jede Anfrage muss drei Prüfungen bestehen: `Host`
ist `127.0.0.1:<port>` oder `localhost:<port>` (gegen DNS-Rebinding), ein vorhandener `Origin` gehört zur
Tauri-App, und `Authorization: Bearer <token>` stimmt. Nur `GET /health` kommt ohne Token aus.

**Externe Inhalte** (PR-Titel, Terminbeschreibungen, Tickets) sind Daten, keine Anweisungen. Die App zeigt sie
nur als Text an, MCP kennzeichnet sie als extern.

---

## 14. Für Entwickler

### Voraussetzungen

- Windows 10/11
- Node.js 24 LTS (22.12+ und 25 funktionieren ebenfalls)
- pnpm 10: `npm install -g pnpm@10` (Node 25 bringt kein Corepack mehr mit)
- Für die App: Rust (rustup, Toolchain `stable-x86_64-pc-windows-msvc`), Visual Studio bzw. Build Tools mit
  „Desktopentwicklung mit C++“ samt Windows SDK, WebView2 (unter Windows 11 vorinstalliert)

### Aufbau

| Paket                | Aufgabe                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `packages/core`      | SQLite (better-sqlite3 + Drizzle), Schema, Geschäftsregeln, Sync, Secret Store       |
| `packages/daemon`    | REST-API für die App, MCP-Server, periodischer Sync, PR-Arbeitsbereich, Tickets      |
| `packages/mcp-stdio` | Dünner stdio-Proxy auf den HTTP-MCP-Endpunkt                                         |
| `packages/app`       | Tauri 2 + Svelte 5; spricht nur über REST mit dem Daemon und startet ihn als Sidecar |

### Befehle

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @brsorganizer/core db:generate   # Migration aus src/db/schema.ts erzeugen
```

### App im Entwicklungsmodus

```bash
pnpm --filter @brsorganizer/app tauri:dev
```

Debug-Builds sind von der echten Installation getrennt:

- Datenordner `%LOCALAPPDATA%\BRSOrganizer-dev`
- Credential-Dienst `BRSOrganizer-dev`
- Port 47822
- Der Vite-Origin `http://127.0.0.1:1420` ist für den Daemon freigeschaltet.

`tauri:dev` baut vorher die Sidecar-Runtime (`pnpm --filter @brsorganizer/app sidecar`). Läuft ein Daemon aus
dieser Runtime, sperrt er `better_sqlite3.node`; vorher `POST /api/shutdown` oder den Prozess
`brsorganizer-node.exe` beenden. Änderungen am Daemon brauchen einen Neustart von `tauri:dev`, die Oberfläche
lädt per Hot Reload nach.

### Daemon allein

```bash
pnpm build
node packages/daemon/dist/main.js            # Port aus den Settings, Standard 47821
node packages/daemon/dist/main.js --port 48000 --no-sync --log-level debug
```

- Ein zweiter Start erkennt den laufenden Daemon und beendet sich mit Code 0.
- Beim ersten Start wird das lokale Zugriffstoken erzeugt und in der Anmeldeinformationsverwaltung abgelegt
  (Dienst `BRSOrganizer`, Konto `local-access-token`).
- Für die Entwicklung: `BRSORGANIZER_KEYRING_SERVICE=BRSOrganizer-dev` trennt die Secrets von der echten
  Installation, `BRSORGANIZER_ALLOWED_ORIGINS=http://localhost:1420` erlaubt den Vite-Dev-Server.

### REST-API (für die App)

| Methode und Pfad                                                           | Zweck                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/items?type=&status=open,done&dueBefore=`                         | Liste (Standard: offene Einträge)                                  |
| `GET /api/items/:id`                                                       | Ein Eintrag                                                        |
| `POST /api/todos`, `PATCH /api/todos/:id`                                  | Todo anlegen (ohne Titel: Titel aus dem Ticket) oder ändern        |
| `POST /api/events`                                                         | Eigenen Termin anlegen                                             |
| `PATCH /api/items/:id/tickets`                                             | BSM-/OTMA-Ticket setzen                                            |
| `POST /api/items/:id/complete\|archive\|reopen`                            | Status ändern (kein Löschen)                                       |
| `POST /api/sync`, `GET /api/sync/runs`                                     | Sync sofort ausführen, letzte Läufe                                |
| `GET/PATCH /api/settings`                                                  | Einstellungen                                                      |
| `GET /api/secrets`, `PUT/DELETE /api/secrets/:name`                        | Secrets setzen (nie auslesbar)                                     |
| `GET /api/otma/tickets`                                                    | Eigene OTMA-Tickets (live gelesen)                                 |
| `GET /api/update`                                                          | Neuere Version auf GitHub?                                         |
| `GET /api/stream`                                                          | Server-Sent Events für Liste und Benachrichtigungen                |
| `GET /api/status`, `POST /api/shutdown`                                    | Zustand der Quellen; sauber beenden                                |
| `GET /api/prs/clone-sync`                                                  | Klon-Stand und Web-URLs aller TFS-PRs                              |
| `GET /api/prs/:id`                                                         | PR-Details und lokaler Stand                                       |
| `POST /api/prs/:id/clone\|open\|remove-local\|complete\|claude`            | Klonen + Build, öffnen, lokal löschen, mergen, Claude-Sitzung      |
| `POST /api/prs/todos/:id/agent` (`/attach`, `/cancel`, `/worktree/remove`) | An Claude übergeben, Sitzung öffnen, abbrechen, Worktree entfernen |
| `GET /api/prs/module-cache`, `POST /api/prs/module-cache/clear`            | BORA-Modul-Cache                                                   |

Aktionen mit Außenwirkung (Klonen, Merge, Löschen, Claude-Übergabe) gibt es nur über REST, nie über MCP.

### Installer bauen

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

### Release

Einen Release-Branch anlegen, dort den Tag `v<Version>` setzen und beides pushen (nur der Tag startet den
Build), z. B.

```bash
git branch release/0.2.0 main
git tag -a v0.2.0 -m "BRSOrganizer 0.2.0" release/0.2.0
git push origin release/0.2.0 v0.2.0
```

Die Action übernimmt die Version aus dem Tag in den Installer (`BRSOrganizer_0.2.0_x64-setup.exe`) und legt ein
GitHub-Release mit der `.exe` und automatisch erzeugten Release-Notes an.

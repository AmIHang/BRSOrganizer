<#
.SYNOPSIS
    Klont ein BORA-Projekt mit einem bestimmten Branch in einen eigenen Ordner, holt die
    BORA-Modulreferenzen (mit Cache), stellt NuGet wieder her und baut die Solution.

.DESCRIPTION
    Gedacht zum lokalen Testen eines PR-Branches, ohne den eigenen Arbeitsstand anzufassen.

    Erwartete Ordnerstruktur (fuer alle Kunden gleich):

        <Root>\                         globaler Projektordner, dieses Skript liegt hier (z.B. C:\projects-git)
          _refcache\                    Cache der BORA-Referenzen (kundenuebergreifend)
          <Kunde>\                      Kundenordner
            <Repo>\                     Repo(s) des Kunden, Name beliebig - daraus wird die Remote-URL gelesen
            <Branch>\                   Klone dieses Skripts (letzter Teil des Branch-Namens)

    Das Repo im Kundenordner wird automatisch gefunden: ein Ordner mit dem Kundennamen wird bevorzugt,
    sonst das einzige Repo bzw. bei mehreren Remotes wird gefragt (oder -Repo angeben).
    Klone dieses Skripts werden in .git markiert; nur markierte Ordner werden spaeter aktualisiert,
    vorhandene Repos werden nie ueberschrieben.

    Ablauf:
      1. Branch pruefen, klonen (bzw. vorhandenen Klon auf den Stand des Branches bringen)
      2. Verknuepfung "PR <Nr>.url" (bzw. "Branch.url") im Klon anlegen
      3. BORA-Referenzen: aus dem Cache vorbefuellen, dann bfdesignc /updatereferences fuer alle
         eingecheckten *.bfproj (Reihenfolge aus azure-pipeline-ci.yml, falls vorhanden)
      4. NuGet restore, 5. Build (Debug, sequenziell)

.EXAMPLE
    .\Clone-Branch.ps1 Community feature/ROGantt
.EXAMPLE
    .\Clone-Branch.ps1                                  # fragt nach Projekt und Branch
.EXAMPLE
    .\Clone-Branch.ps1 Northrail feature/xyz -NoBuild -Open

.NOTES
    BORA-Referenzen werden unter -RefCache pro Modul und Version zwischengespeichert. bfdesignc
    ueberspringt Referenzen mit passender Version und laedt nur Fehlendes oder andere Versionen.
    Gepatchte Module (HintPath auf ein .bfpackage im Repo) liegen getrennt pro Projekt und
    Paketinhalt unter _patched\<Projekt>\<Modul>\<Version>-<Hash> und werden bei jedem Lauf frisch
    eingesetzt, nie aus dem kundenuebergreifenden Teil.
    Alte Versionen sammeln sich dort an und koennen jederzeit geloescht werden.
#>
param(
    # Kundenordner unter -Root
    [Parameter(Position = 0)]
    [string]$Project,

    # Branch-Name oder PR-Nummer (z.B. 4373)
    [Parameter(Position = 1)]
    [string]$Branch,

    # PR-Nummer (Standard: wird ueber den Branch gesucht). Bestimmt Ordner-, App-Pool- und URL-Namen: PR<Nummer>
    [string]$PrNumber,

    # Keine IIS-Einrichtung (App-Pool und Web-Apps)
    [switch]$NoIis,

    # Globaler Projektordner (Standard: Ordner dieses Skripts)
    [string]$Root,

    # Ordnername des Repos im Kundenordner, dessen Remote verwendet wird (Standard: automatisch)
    [string]$Repo,

    # Remote-URL direkt angeben (Standard: origin des Repos im Kundenordner)
    [string]$RepoUrl,

    # Standard: einzige .sln im Repo-Root (ohne *_CI*), bei mehreren bevorzugt *_TV*
    [string]$Solution,

    # Eigener Ordnername (Standard: letzter Teil des Branch-Namens, bei Bedarf gekuerzt)
    [string]$Name,

    [switch]$NoBuild,

    # Standard: <Root>\_refcache
    [string]$RefCache,

    [switch]$NoRefCache,

    # Oeffnet danach die Solution
    [switch]$Open
)

$ErrorActionPreference = 'Stop'

# Standardwerte hier statt im param-Block: unter PS 5.1 mit -File ist $PSScriptRoot dort noch leer
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Root) { $Root = $scriptDir }
if (-not $RefCache) { $RefCache = Join-Path $Root '_refcache' }

# ============================================================================
# Hilfsfunktionen
# ============================================================================
function Write-Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    # git schreibt Fortschritt auf stderr; unter PS 5.1 + 'Stop' wuerde das als Fehler abbrechen
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') ist mit Exit-Code $LASTEXITCODE fehlgeschlagen." }
}

function Copy-Dir([string]$From, [string]$To) {
    # robocopy: Exit-Codes < 8 bedeuten Erfolg
    $null = robocopy $From $To /E /MT:16 /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "robocopy $From -> $To fehlgeschlagen (Exit $LASTEXITCODE)." }
    $global:LASTEXITCODE = 0
}

function Get-RealizedVersion([string]$RefDir) {
    $f = Join-Path $RefDir '_bfpackageexpansion.xml'
    if ((Test-Path $f) -and ((Get-Content $f -Raw) -match 'PackageVersion="([^"]+)"')) { return $Matches[1] }
    return $null
}

# Referenzen der Module: Zielordner -> @{ Version; Cache; Patched }. Verweist ein Eintrag per HintPath
# auf ein .bfpackage im Repo, ist das Modul gepatcht (gleiche Versionsnummer, anderer Inhalt). Es liegt
# dann pro Projekt und Paketinhalt im Cache (_patched\<Projekt>\<Modul>\<Version>-<Hash>), nie im
# kundenuebergreifenden Teil. Cache = $null: nicht cachen (Paketdatei fehlt).
function Get-WantedReferences([string]$Target, [string[]]$Projects, [string]$CacheRoot, [string]$ProjectName) {
    $wanted = @{}
    foreach ($proj in $Projects) {
        $full = Join-Path $Target $proj
        if (-not (Test-Path $full)) { continue }
        $base = Split-Path $full
        foreach ($el in [regex]::Matches((Get-Content $full -Raw), '<ReferenceProjectItem\b[^>]*>')) {
            $a = @{}
            foreach ($m in [regex]::Matches($el.Value, '(\w+)="([^"]*)"')) { $a[$m.Groups[1].Value] = $m.Groups[2].Value }
            if (-not $a.RealizationPath -or $a.Reference -notmatch '^[^:]+:([^:]+):') { continue }
            $ver = $Matches[1]
            $dir = [IO.Path]::GetFullPath((Join-Path $base $a.RealizationPath))
            $module = Split-Path $dir -Leaf
            $patched = [bool]($a.HintPath -like '*.bfpackage')
            $cache = Join-Path $CacheRoot "$module\$ver"
            if ($patched) {
                $pkg = [IO.Path]::GetFullPath((Join-Path $base $a.HintPath))
                $cache = $null
                if (Test-Path $pkg) {
                    $hash = (Get-FileHash $pkg -Algorithm SHA256).Hash.Substring(0, 12)
                    $cache = Join-Path $CacheRoot "_patched\$ProjectName\$module\$ver-$hash"
                }
            }
            # Mehrere Module koennen dieselbe Referenz verlangen: gepatcht vor offiziell, sonst hoechste Version
            $old = $wanted[$dir]
            $take = -not $old
            if ($old -and $patched -ne $old.Patched) { $take = $patched }
            elseif ($old) { try { $take = [version]$ver -gt [version]$old.Version } catch { $take = $false } }
            if ($take) { $wanted[$dir] = @{ Version = $ver; Cache = $cache; Patched = $patched } }
        }
    }
    return $wanted
}

function Invoke-PrIis([string[]]$IisArgs) {
    # Startet PrIis.ps1 mit Adminrechten (UAC-Abfrage) und zeigt dessen Ausgabe an
    $iisScript = Join-Path $scriptDir 'PrIis.ps1'
    if (-not (Test-Path $iisScript)) { throw "PrIis.ps1 nicht gefunden in $scriptDir." }
    $log = Join-Path $env:TEMP "PrIis-$([guid]::NewGuid().ToString('N')).log"
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$iisScript`"") + ($IisArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) + @('-LogFile', "`"$log`"")
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    try {
        $proc = if ($isAdmin) { Start-Process powershell.exe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden }
                else { Write-Host 'Adminrechte fuer IIS noetig - bitte UAC-Abfrage bestaetigen.' -ForegroundColor Yellow
                       Start-Process powershell.exe -ArgumentList $argList -Verb RunAs -Wait -PassThru -WindowStyle Hidden }
    } catch {
        Write-Warning "IIS-Schritt nicht ausgefuehrt (UAC abgelehnt?): $($_.Exception.Message)"; return $false
    }
    if (Test-Path $log) {
        Get-Content $log | Where-Object { $_ -and $_ -notmatch '^\*{5,}|^(Start|End) time|^Username|^RunAs|^Configuration|^Machine|^Host Application|^Process ID|^PS|^BuildVersion|^CLR|^WSMan|^Serialization|^Windows PowerShell|^Transcript' } | ForEach-Object { Write-Host "  $_" }
        Remove-Item $log -Force -ErrorAction SilentlyContinue
    }
    return ($proc.ExitCode -eq 0)
}

function Find-BoraDesigner {
    # 1. Umgebungsvariable BFDESIGNER (Datei oder Ordner)
    if ($env:BFDESIGNER) {
        $p = $env:BFDESIGNER.Trim('"')
        if (Test-Path $p -PathType Container) { $p = Join-Path $p 'bfdesignc.exe' }
        if (Test-Path $p -PathType Leaf) { return $p }
        Write-Warning "BFDESIGNER zeigt auf '$($env:BFDESIGNER)', dort gibt es kein bfdesignc.exe."
    }
    # 2. Registry (gleiche Logik wie getReferences.bat)
    try {
        $cmd = (Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\bfdesigner.bfproj\shell\Build\command' -ErrorAction Stop).'(default)'
        if ($cmd -match '^"?(.+?bfdesignc\.exe)"?') {
            if (Test-Path $Matches[1]) { return $Matches[1] }
        }
    } catch { }
    throw 'BORA Designer (bfdesignc.exe) nicht gefunden. BFDESIGNER setzen oder den BORA Designer installieren.'
}

# Markierung in .git, an der Klone dieses Skripts erkannt werden
$markerName = 'clone-branch'
function Test-ScriptClone([string]$Dir) { Test-Path (Join-Path $Dir ".git\$markerName") }

function Select-FromList([string]$Title, [string[]]$Items) {
    Write-Host "${Title}:" -ForegroundColor Cyan
    for ($i = 0; $i -lt $Items.Count; $i++) { Write-Host ("  {0,2}) {1}" -f ($i + 1), $Items[$i]) }
    $answer = (Read-Host 'Auswahl (Nummer oder Name)').Trim()
    if ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $Items.Count) { return $Items[[int]$answer - 1] }
    return $answer
}

function Get-Repos([string]$Dir) {
    # Git-Repos direkt im Kundenordner, die keine Klone dieses Skripts sind
    Get-ChildItem $Dir -Directory -ErrorAction SilentlyContinue |
        Where-Object { (Test-Path (Join-Path $_.FullName '.git')) -and -not (Test-ScriptClone $_.FullName) } |
        ForEach-Object {
            $url = git -C $_.FullName remote get-url origin 2>$null
            [pscustomobject]@{ Name = $_.Name; Path = $_.FullName; Url = "$url".Trim() }
        } | Where-Object Url
}

# ============================================================================
# Kunde, Repo und Branch
# ============================================================================
if (-not $Project) {
    $known = @(Get-ChildItem $Root -Directory | Where-Object { Get-Repos $_.FullName } | ForEach-Object Name)
    $Project = Select-FromList 'Kundenordner' $known
}
if (-not $Project) { throw 'Kein Kundenordner angegeben.' }

$projectRoot = Join-Path $Root $Project
if (-not (Test-Path $projectRoot -PathType Container)) { throw "Kundenordner $projectRoot existiert nicht." }

# Repo im Kundenordner bestimmen (liefert Remote-URL und Referenz fuer die Pfadlaenge)
$repos = @(Get-Repos $projectRoot)
$mainRepo = $null
if ($Repo) {
    $sel = $repos | Where-Object Name -eq $Repo | Select-Object -First 1
    if (-not $sel) { throw "Repo '$Repo' im Kundenordner $projectRoot nicht gefunden." }
} elseif ($RepoUrl) {
    $sel = $repos | Where-Object { $_.Url -eq $RepoUrl } | Select-Object -First 1
} else {
    $sel = $repos | Where-Object Name -eq $Project | Select-Object -First 1       # <Kunde>\<Kunde> bevorzugt
    if (-not $sel) {
        $urls = @($repos | ForEach-Object Url | Sort-Object -Unique)
        if ($urls.Count -eq 0) { throw "Kein Git-Repo mit Remote in $projectRoot gefunden - bitte -RepoUrl angeben." }
        if ($urls.Count -gt 1) {
            $choice = Select-FromList "Mehrere Repos in $Project" @($repos | ForEach-Object { "$($_.Name)  [$($_.Url)]" })
            $sel = $repos | Where-Object { $choice -eq "$($_.Name)  [$($_.Url)]" -or $choice -eq $_.Name } | Select-Object -First 1
            if (-not $sel) { throw "Ungueltige Auswahl '$choice'." }
        } else {
            $sel = $repos | Select-Object -First 1
        }
    }
}
if ($sel) {
    $mainRepo = $sel.Path
    if (-not $RepoUrl) { $RepoUrl = $sel.Url }
}
if (-not $RepoUrl) { throw 'Keine Remote-URL ermittelt.' }

if (-not $Branch -and -not $PrNumber) { $Branch = Read-Host 'Branch-Name oder PR-Nummer (z.B. feature/ROGantt oder 4373)' }
$Branch = "$Branch".Trim() -replace '^refs/heads/', '' -replace '^origin/', ''
if ($Branch -match '^(PR\s*)?(\d+)$') { $PrNumber = $Matches[2]; $Branch = '' }   # nur PR-Nummer angegeben
if (-not $Branch -and -not $PrNumber) { throw 'Kein Branch angegeben.' }

# ============================================================================
# PR ermitteln (vor dem Klonen: der Ordner heisst PR<Nummer>)
# ============================================================================
$pr = $null; $prUrl = $null
$tfs = $RepoUrl -match '^(?<base>.+)/_git/(?<repo>[^/]+?)/?$'
if ($tfs) { $prApi = "$($Matches.base)/_apis/git/repositories/$($Matches.repo)/pullrequests" }
try {
    if ($tfs -and $PrNumber) {
        $pr = Invoke-RestMethod "$prApi/$PrNumber`?api-version=5.0" -UseDefaultCredentials -TimeoutSec 30
        $prBranch = $pr.sourceRefName -replace '^refs/heads/', ''
        if ($Branch -and $Branch -ne $prBranch) { Write-Warning "PR $PrNumber hat Branch '$prBranch', angegeben war '$Branch' - verwende '$prBranch'." }
        $Branch = $prBranch
    } elseif ($tfs) {
        $prs = (Invoke-RestMethod "$prApi`?searchCriteria.sourceRefName=refs/heads/$([uri]::EscapeDataString($Branch))&searchCriteria.status=all&api-version=5.0" -UseDefaultCredentials -TimeoutSec 30).value
        $pr = @($prs | Where-Object status -eq 'active') + @($prs | Sort-Object creationDate -Descending) | Select-Object -First 1
        if ($pr) { $PrNumber = "$($pr.pullRequestId)" }
    }
} catch {
    if ($PrNumber -and -not $Branch) { throw "PR $PrNumber konnte nicht abgefragt werden: $($_.Exception.Message)" }
    Write-Warning "PR konnte nicht abgefragt werden: $($_.Exception.Message)"
}
if ($pr) { $prUrl = "$RepoUrl/pullrequest/$($pr.pullRequestId)" }

Write-Step "Pruefe Branch '$Branch' ($Project)"
if ($mainRepo) { Write-Host "Repo  : $mainRepo" }
Write-Host "Remote: $RepoUrl"
if ($pr) { Write-Host "PR    : $($pr.pullRequestId) ($($pr.status)) $($pr.title)" }
elseif ($PrNumber) { Write-Host "PR    : $PrNumber (nicht abfragbar)" }
$remoteRef = git ls-remote --heads $RepoUrl "refs/heads/$Branch"
if ($LASTEXITCODE -ne 0) { throw "Remote $RepoUrl nicht erreichbar." }
if (-not $remoteRef) { throw "Branch '$Branch' existiert auf $RepoUrl nicht." }

# ============================================================================
# Zielordner (Windows-Pfadlimit beachten)
# ============================================================================
# Laengster Pfad im Haupt-Repo (inkl. Build-Ausgaben wie obj\Debug\*.cache) relativ zum Repo.
# Der Klon braucht dieselbe Tiefe, der Ordnername darf also nur so lang sein, dass 260 Zeichen reichen.
$deepest = 195
if ($mainRepo -and (Test-Path $mainRepo)) {
    $longest = cmd /c "dir /s /b /a-d `"$mainRepo`" 2>nul" |
        Where-Object { $_ -notmatch '\\(\.git|\.vs|\.claude|node_modules)\\' } |
        Measure-Object -Property Length -Maximum
    if ($longest.Maximum) { $deepest = [Math]::Max(150, $longest.Maximum - $mainRepo.Length + 5) }
}
$maxTarget = 259 - $deepest

$explicitName = [bool]$Name
if (-not $Name -and $PrNumber) { $Name = "PR$PrNumber" }
if (-not $Name) {
    # Ohne PR: letzter Teil des Branch-Namens
    $Name = ($Branch -split '/')[-1] -replace '[\\:*?"<>|]', '_'
    $maxName = $maxTarget - $projectRoot.TrimEnd('\').Length - 1
    if ($maxName -lt 8) { $maxName = 8 }
    if ($Name.Length -gt $maxName) {
        $Name = $Name.Substring(0, $maxName).TrimEnd('-', '_', '.')
        Write-Warning "Ordnername auf '$Name' gekuerzt (Windows-Pfadlimit). Mit -Name selbst festlegen."
    }
}
$target = Join-Path $projectRoot $Name

# Nie einen fremden Ordner (z.B. ein vorhandenes Repo 'dev') verwenden - nur eigene, markierte Klone
if ((Test-Path $target) -and -not (Test-ScriptClone $target)) {
    if ($explicitName) { throw "Ordner $target existiert bereits und wurde nicht von diesem Skript angelegt. Bitte anderen -Name waehlen." }
    $Name = "$Name-pr"
    $target = Join-Path $projectRoot $Name
    if ((Test-Path $target) -and -not (Test-ScriptClone $target)) {
        throw "Ordner $target existiert bereits und wurde nicht von diesem Skript angelegt. Bitte -Name angeben."
    }
    Write-Host "Ordner mit dem Branch-Namen ist belegt - verwende $Name"
}
if ($target.Length -gt $maxTarget) {
    Write-Warning "Zielpfad '$target' ist $($target.Length) Zeichen lang - der Build kann an der 260-Zeichen-Grenze scheitern."
}

# ============================================================================
# Klonen bzw. aktualisieren
# ============================================================================
if (Test-Path (Join-Path $target '.git')) {
    Write-Step "Ordner $target existiert bereits - aktualisiere"
    $dirty = git -C $target status --porcelain --untracked-files=no
    # Vom TypeScript-Build neu erzeugte .js (mit .ts daneben) stillschweigend verwerfen
    # sowie die vom Skript angepassten IIS-URLs in *.csproj (werden nach dem Reset neu gesetzt)
    $iisMark = "-$([regex]::Escape($Name))/?</IISUrl>"
    $dirty = @($dirty | Where-Object {
        $file = Join-Path $target ($_.Substring(3).Trim('"') -replace '/', '\')
        -not (($file -match '\.js$' -and (Test-Path ($file -replace '\.js$', '.ts'))) -or
              ($file -match '\.csproj$' -and (Test-Path $file) -and ((Get-Content $file -Raw) -match $iisMark)))
    })
    if ($dirty) {
        Write-Host ($dirty -join "`n") -ForegroundColor DarkYellow
        $answer = Read-Host 'Lokale Aenderungen verwerfen? [j/N]'
        if ($answer -notmatch '^(j|ja|y|yes)$') { throw 'Abgebrochen - lokale Aenderungen vorhanden.' }
    }
    Invoke-Native git @('-C', $target, 'fetch', 'origin', $Branch)
    Invoke-Native git @('-C', $target, 'checkout', $Branch)
    Invoke-Native git @('-C', $target, 'reset', '--hard', "origin/$Branch")
} else {
    # Markierter, aber halb geloeschter/kaputter Klon kann hier nicht auftreten (Marker liegt in .git)
    Write-Step "Klone $Branch nach $target"
    Invoke-Native git @('clone', '--branch', $Branch, $RepoUrl, $target)
    Set-Content -Path (Join-Path $target ".git\$markerName") -Value "Angelegt von Clone-Branch.ps1 am $(Get-Date -Format s)" -Encoding ASCII
}

# ============================================================================
# Verknuepfung zum PR
# ============================================================================
Write-Step 'Lege Verknuepfung zum PR an'
Get-ChildItem $target -Filter '*.url' -File | Where-Object { $_.Name -match '^(PR ?\d*|Branch)\.url$' } | Remove-Item -Force
$escBranch = [uri]::EscapeDataString($Branch)
$prName = 'Branch'
if ($prUrl) {
    $prName = "PR $($pr.pullRequestId)"
} elseif ($PrNumber -and $tfs) {
    $prUrl = "$RepoUrl/pullrequest/$PrNumber"; $prName = "PR $PrNumber"
} elseif ($tfs) {
    $prUrl = "$RepoUrl`?version=GB$escBranch"
} elseif ($RepoUrl -match 'github\.com[/:](?<repo>[^/]+/[^/]+?)(\.git)?/?$') {
    # GitHub: ohne Token keine PR-Abfrage - Link auf die PR-Suche zum Branch
    $prUrl = if ($PrNumber) { "https://github.com/$($Matches.repo)/pull/$PrNumber" } else { "https://github.com/$($Matches.repo)/pulls?q=is%3Apr+head%3A$escBranch" }
    $prName = if ($PrNumber) { "PR $PrNumber" } else { 'PR' }
}
if (-not $prUrl) { $prUrl = $RepoUrl -replace '\.git$', '' }
if ($prName -eq 'Branch') { Write-Host 'Kein PR gefunden - Verknuepfung zeigt auf den Branch.' }
Set-Content -Path (Join-Path $target "$prName.url") -Value "[InternetShortcut]`r`nURL=$prUrl" -Encoding ASCII
Write-Host "Verknuepfung: $(Join-Path $target "$prName.url")"

# ============================================================================
# IIS: Web-URLs mit -<Name> (z.B. -PR4373), eigener App-Pool <Name>
# ============================================================================
$webUrls = @()
$webApps = @()
foreach ($rel in @(git -C $target ls-files '*.csproj')) {
    $file = Join-Path $target ($rel -replace '/', '\')
    $raw = [IO.File]::ReadAllText($file)
    if ($raw -notmatch '<UseIIS>\s*True\s*</UseIIS>') { continue }
    $m = [regex]::Match($raw, '<IISUrl>(?<base>https?://localhost(:\d+)?)/(?<path>[^<]*?)/?</IISUrl>')
    if (-not $m.Success -or -not $m.Groups['path'].Value) { continue }
    $path = $m.Groups['path'].Value
    $suffix = "-$Name"
    $origPath = if ($path.EndsWith($suffix)) { $path.Substring(0, $path.Length - $suffix.Length) } else { $path }
    $newPath = "$origPath$suffix"
    if ($path -ne $newPath) {
        # Encoding (BOM) und Zeilenenden der Datei beibehalten
        $bytes = [IO.File]::ReadAllBytes($file)
        $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
        $raw = $raw.Remove($m.Index, $m.Length).Insert($m.Index, "<IISUrl>$($m.Groups['base'].Value)/$newPath/</IISUrl>")
        [IO.File]::WriteAllText($file, $raw, (New-Object Text.UTF8Encoding $hasBom))
    }
    $webUrls += "$($m.Groups['base'].Value)/$newPath/"
    $webApps += [pscustomobject]@{ AppPath = "/$newPath"; OrigPath = "/$origPath"; PhysicalPath = (Split-Path $file) }
}
if ($webApps) {
    Write-Step "IIS: $($webApps.Count) Web-Projekt(e) mit Suffix -$Name, App-Pool $Name"
    if ($NoIis) {
        Write-Host 'IIS-Einrichtung uebersprungen (-NoIis). Visual Studio legt die Apps beim Oeffnen an.'
    } elseif (-not (Test-Path (Join-Path $env:windir 'system32\inetsrv\Microsoft.Web.Administration.dll'))) {
        Write-Warning 'IIS ist nicht installiert - Einrichtung uebersprungen.'
    } else {
        $appsFile = Join-Path $env:TEMP "PrIis-apps-$Name.json"
        ConvertTo-Json @($webApps) | Set-Content $appsFile -Encoding UTF8
        if (-not (Invoke-PrIis @('-Action', 'Setup', '-Pool', $Name, '-AppsFile', $appsFile))) {
            Write-Warning 'IIS-Einrichtung fehlgeschlagen - Details oben.'
        }
        Remove-Item $appsFile -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================================
# BORA-Modulreferenzen
# ============================================================================
Write-Step 'Aktualisiere BORA-Modulreferenzen'
$refWatch = [Diagnostics.Stopwatch]::StartNew()

# Eigene Module = eingecheckte *.bfproj (realisierte Referenzen wie Modules\BM.Core sind nicht eingecheckt)
$projects = @(git -C $target ls-files '*.bfproj' | ForEach-Object { $_ -replace '/', '\' } |
    Where-Object { $_ -notmatch '(^|\\)Hosted\\' })

# Reihenfolge wie in der CI, falls die Pipeline die Module auflistet
$pipeline = Join-Path $target 'azure-pipeline-ci.yml'
if ((Test-Path $pipeline) -and $projects.Count -gt 1) {
    $ymlOrder = [regex]::Matches((Get-Content $pipeline -Raw), '[\w.\\/$()-]+\.bfproj') |
        ForEach-Object { ($_.Value -replace '/', '\' -replace '^.*\)\\', '') }
    $projects = @($projects | Sort-Object { $i = [array]::IndexOf(@($ymlOrder), $_); if ($i -lt 0) { 9999 } else { $i } })
}

$failed = @()
if (-not $projects) {
    Write-Warning 'Keine eingecheckten *.bfproj gefunden - Referenzen uebersprungen.'
} else {
    $bfdesignc = Find-BoraDesigner
    Write-Host "BORA Designer: $bfdesignc"
    Write-Host "Module: $($projects.Count)"

    # Referenz-Cache: Referenzordner vorab befuellen. bfdesignc ueberspringt Referenzen mit passender
    # Version ("up to date") und laedt nur Fehlendes bzw. andere Versionen.
    $useCache = -not $NoRefCache
    $wanted = @{}
    if ($useCache) {
        $wanted = Get-WantedReferences $target $projects $RefCache $Project
        $hit = 0; $miss = 0
        foreach ($dir in $wanted.Keys) {
            $w = $wanted[$dir]
            # Offizielle Module: passende Version im Klon genuegt (z.B. erneuter Lauf). Gepatchte nicht -
            # die Versionsnummer verraet nicht, ob der Patch (oder ein neuerer) drin ist.
            if (-not $w.Patched -and (Get-RealizedVersion $dir) -eq $w.Version) { $hit++; continue }
            if ($w.Cache -and (Test-Path (Join-Path $w.Cache '_bfpackageexpansion.xml'))) {
                if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
                Copy-Dir $w.Cache $dir
                $hit++
            } else {
                # Gepatcht und noch nicht im Cache: weg damit, sonst haelt bfdesignc ein offizielles
                # Modul gleicher Version fuer aktuell und spielt den Patch nicht ein.
                if ($w.Patched -and (Test-Path $dir)) { Remove-Item $dir -Recurse -Force }
                $miss++
            }
        }
        $patchedCount = @($wanted.Values | Where-Object { $_.Patched }).Count
        Write-Host "Referenz-Cache ($RefCache): $hit aus Cache, $miss werden geladen, davon gepatcht: $patchedCount"
    }

    foreach ($proj in $projects) {
        $full = Join-Path $target $proj
        Write-Host "-> $proj" -ForegroundColor Yellow
        & $bfdesignc /updatereferences $full
        if ($LASTEXITCODE -ne 0) { $failed += $proj; Write-Warning "updatereferences fehlgeschlagen fuer $proj (Exit $LASTEXITCODE)" }
    }

    # Neu geladene Referenzen in den Cache uebernehmen (pro Modul und Version)
    if ($useCache -and $wanted.Count) {
        $added = 0
        $refRoots = $wanted.Keys | ForEach-Object { Split-Path $_ } | Sort-Object -Unique
        $realized = $refRoots | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Directory } | ForEach-Object FullName
        foreach ($dir in $realized) {
            $ver = Get-RealizedVersion $dir
            if (-not $ver) { continue }
            # Eigener Cache-Ort der Referenz (gepatcht: pro Projekt); sonst (z.B. transitive) global
            $dst = Join-Path $RefCache "$(Split-Path $dir -Leaf)\$ver"
            if ($wanted.ContainsKey($dir)) {
                $w = $wanted[$dir]
                if (-not $w.Cache -or $ver -ne $w.Version) { continue }
                $dst = $w.Cache
            }
            if (Test-Path (Join-Path $dst '_bfpackageexpansion.xml')) { continue }
            $tmp = "$dst.tmp"
            if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
            Copy-Dir $dir $tmp
            Rename-Item $tmp (Split-Path $dst -Leaf)   # erst nach vollstaendiger Kopie sichtbar
            $added++
        }
        if ($added) { Write-Host "Referenz-Cache: $added Modul-Version(en) neu aufgenommen" }
    }
}
Write-Host "Referenzen fertig nach $([int]$refWatch.Elapsed.TotalSeconds) s"

# ============================================================================
# Solution, NuGet
# ============================================================================
# Anzeigename der Solution-Kopie: "<Kunde> │ <Name>" (z.B. "Community │ PR4373").
# Ein echtes '|' ist in Dateinamen verboten - U+2502 sieht gleich aus. Als [char] erzeugt, damit die
# Skriptdatei ASCII bleibt (PS 5.1 liest UTF-8 ohne BOM sonst falsch).
$slnDisplayName = "$Project $([char]0x2502) $Name"
$legacySlnNames = @("$($Project)_$Name.sln")   # frueheres Format, wird ersetzt
if (-not $Solution) {
    $slns = @(Get-ChildItem $target -Filter *.sln -File | Where-Object {
        $_.Name -notmatch '_CI' -and $_.Name -ne "$slnDisplayName.sln" -and $legacySlnNames -notcontains $_.Name })
    if (-not $slns) { $slns = @(Get-ChildItem $target -Filter *.sln -File -Recurse -Depth 1) }
    if (-not $slns) { throw "Keine .sln in $target gefunden - bitte -Solution angeben." }
    $pick = $slns | Where-Object { $_.Name -match '_TV' } | Select-Object -First 1
    if (-not $pick) { $pick = $slns[0] }
    if ($slns.Count -gt 1) { Write-Host "Mehrere Solutions gefunden, nehme $($pick.Name) (-Solution zum Aendern)" }
    $sln = $pick.FullName
} else {
    $sln = Join-Path $target $Solution
}

# Kopie der Solution als "<Kunde> │ <Name>.sln" - Visual Studio zeigt den Dateinamen im Fenstertitel und im
# Projektmappen-Explorer, so ist sofort erkennbar, welcher Klon offen ist.
# Kopie statt Umbenennen: das Repo bleibt unveraendert (Datei ist untracked).
$slnCopy = Join-Path (Split-Path $sln) "$slnDisplayName.sln"
foreach ($legacy in $legacySlnNames) {
    $old = Join-Path (Split-Path $sln) $legacy
    if ((Test-Path $old) -and $old -ne $sln) { Remove-Item $old -Force }
}
if ($slnCopy -ne $sln) {
    Copy-Item $sln $slnCopy -Force
    Write-Host "Solution: $(Split-Path $slnCopy -Leaf) (Kopie von $(Split-Path $sln -Leaf))"
    $sln = $slnCopy
}

Write-Step "NuGet restore ($(Split-Path $sln -Leaf))"
# nuget.exe: im Repo, im Projektordner (-Root) oder neben dem Skript. Geladen wird in den Projektordner,
# damit das auch funktioniert, wenn das Skript in einem schreibgeschuetzten Programmordner liegt.
$nuget = @((Join-Path $target 'Tools\nuget.exe'), (Join-Path $target 'nuget.exe'), (Join-Path $Root 'nuget.exe'), (Join-Path $scriptDir 'nuget.exe')) |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $nuget) {
    $nugetCmd = Get-Command nuget -ErrorAction SilentlyContinue
    if ($nugetCmd) { $nuget = $nugetCmd.Source }
}
if (-not $nuget) {
    $nuget = Join-Path $Root 'nuget.exe'
    Write-Host "nuget.exe nicht gefunden - lade nach $nuget"
    Invoke-WebRequest 'https://dist.nuget.org/win-x86-commandline/latest/nuget.exe' -OutFile $nuget -UseBasicParsing
}
$nugetArgs = @('restore', $sln, '-NonInteractive')
$nugetConfig = @((Join-Path (Split-Path $sln) 'nuget.config'), (Join-Path $target 'nuget.config'), (Join-Path $target 'Tools\nuget.config')) |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if ($nugetConfig) { $nugetArgs += @('-ConfigFile', $nugetConfig); Write-Host "nuget.config: $nugetConfig" }
Invoke-Native $nuget $nugetArgs

# ============================================================================
# Build
# ============================================================================
# Sequenziell (ohne /m): Module referenzieren sich teils ueber <Modul>\bin\Debug\*.dll (HintPath),
# in einem frischen Klon gibt es die DLLs noch nicht - parallel gebaut fehlen sie dann.
$buildOk = $null
if (-not $NoBuild) {
    Write-Step "Build $(Split-Path $sln -Leaf) (Debug, sequenziell - dauert ein paar Minuten)"
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $msbuild = if (Test-Path $vswhere) {
        & $vswhere -latest -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
    }
    if (-not $msbuild) {
        Write-Warning 'MSBuild nicht gefunden - Build uebersprungen. Bitte in Visual Studio bauen.'
    } else {
        $buildLog = Join-Path $target 'build.log'
        # /nodeReuse:false: keine MSBuild-Prozesse, die nach dem Build Dateien im Klon sperren
        & $msbuild $sln /nologo /v:m /nodeReuse:false /p:Configuration=Debug '/p:Platform=Any CPU' "/flp:LogFile=$buildLog;Verbosity=normal" |
            Where-Object { $_ -match ': error ' -or $_ -match ' -> ' }
        $buildOk = ($LASTEXITCODE -eq 0)
        if (-not $buildOk) { Write-Warning "Build fehlgeschlagen - Details in $buildLog" }
    }
}

# ============================================================================
# Fertig
# ============================================================================
Write-Step 'Fertig'
Write-Host "Projekt: $Project"
Write-Host "Branch : $Branch"
Write-Host "Ordner : $target"
Write-Host "Commit : $(git -C $target log -1 --format='%h %s (%an)')"
Write-Host "Link   : $prUrl"
foreach ($u in $webUrls) { Write-Host "Web    : $u" }
if ($null -ne $buildOk) { Write-Host "Build  : $(if ($buildOk) { 'OK' } else { 'FEHLGESCHLAGEN' })" -ForegroundColor $(if ($buildOk) { 'Green' } else { 'Red' }) }
if ($failed) {
    Write-Warning "Referenzen fehlgeschlagen fuer:`n  $($failed -join "`n  ")"
}

if ($Open) { Start-Process $sln }

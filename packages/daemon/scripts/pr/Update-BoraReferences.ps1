<#
.SYNOPSIS
    Holt die BORA-Modulreferenzen eines Klons bzw. Worktrees, mit Cache.

.DESCRIPTION
    Gemeinsam genutzt von Clone-Branch.ps1 (PR-Klon) und Start-TodoAgent.ps1 (Worktree fuer
    "An Claude"). Ablauf: Referenzordner aus dem Cache vorbefuellen, dann bfdesignc
    /updatereferences fuer alle eingecheckten *.bfproj (Reihenfolge aus azure-pipeline-ci.yml, falls
    vorhanden), danach neu geladene Referenzen in den Cache uebernehmen.

    Gibt die Module aus, deren updatereferences fehlgeschlagen ist (leer = alles ok); alles andere
    geht per Write-Host an die Konsole.

.NOTES
    Cache pro Modul und Version unter -RefCache (<Modul>\<Version>, kundenuebergreifend). Gepatchte
    Module (HintPath auf ein .bfpackage im Repo) liegen getrennt pro Projekt und Paketinhalt unter
    _patched\<Projekt>\<Modul>\<Version>-<Hash> und werden bei jedem Lauf frisch eingesetzt.
#>
param(
    # Klon bzw. Worktree (Git-Arbeitsverzeichnis)
    [Parameter(Mandatory)][string]$Target,
    # Kundenordner (fuer den Cache gepatchter Module)
    [Parameter(Mandatory)][string]$Project,
    # Cache-Ordner, z.B. <Root>\_refcache
    [Parameter(Mandatory)][string]$RefCache,
    [switch]$NoRefCache
)
$ErrorActionPreference = 'Stop'

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

$refWatch = [Diagnostics.Stopwatch]::StartNew()

# Eigene Module = eingecheckte *.bfproj (realisierte Referenzen wie Modules\BM.Core sind nicht eingecheckt)
$projects = @(git -C $Target ls-files '*.bfproj' | ForEach-Object { $_ -replace '/', '\' } |
    Where-Object { $_ -notmatch '(^|\\)Hosted\\' })

# Reihenfolge wie in der CI, falls die Pipeline die Module auflistet
$pipeline = Join-Path $Target 'azure-pipeline-ci.yml'
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
        $wanted = Get-WantedReferences $Target $projects $RefCache $Project
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
        $full = Join-Path $Target $proj
        Write-Host "-> $proj"
        # bfdesignc-Ausgabe auf die Konsole, nicht in die Rueckgabe (das ist nur die Fehlerliste)
        & $bfdesignc /updatereferences $full | ForEach-Object { Write-Host $_ }
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
$failed

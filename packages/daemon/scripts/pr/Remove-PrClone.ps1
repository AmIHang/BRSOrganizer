<#
.SYNOPSIS
    Loescht einen Klon von Clone-Branch.ps1 samt IIS-App-Pool und Web-Apps.

.DESCRIPTION
    Der Ordner ist in der Regel durch den IIS gesperrt (der Worker-Prozess des App-Pools haelt DLLs offen).
    Deshalb werden zuerst die Web-Apps und der App-Pool <Ordnername> (z.B. PR4373) entfernt, der
    Worker-Prozess beendet und erst danach der Ordner geloescht. Dafuer sind Adminrechte noetig (UAC).

    Geloescht werden nur Ordner, die Clone-Branch.ps1 angelegt hat (Markierung .git\clone-branch).

.EXAMPLE
    .\Remove-PrClone.ps1 C:\projects-git\Community\PR4373
.EXAMPLE
    .\Remove-PrClone.ps1 C:\projects-git\Community\PR4373 -Force   # ohne Rueckfrage
#>
param(
    [Parameter(Mandatory, Position = 0)][string]$Path,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

$Path = [IO.Path]::GetFullPath($Path.Trim('"').TrimEnd('\'))
$pool = Split-Path $Path -Leaf

if (-not (Test-Path $Path)) {
    Write-Host "Ordner $Path existiert nicht (mehr) - entferne nur App-Pool $pool, falls vorhanden."
} elseif (-not (Test-Path (Join-Path $Path '.git\clone-branch'))) {
    throw "$Path wurde nicht von Clone-Branch.ps1 angelegt - wird nicht geloescht."
}

Write-Host ''
Write-Host "Folgendes wird geloescht:" -ForegroundColor Yellow
Write-Host "  Ordner   : $Path"
Write-Host "  App-Pool : $pool (inkl. aller Web-Apps darin)"
Write-Host ''
Write-Host 'ACHTUNG: Der Ordner ist vermutlich durch den IIS gesperrt. Dafuer wird der App-Pool gestoppt' -ForegroundColor Yellow
Write-Host '         und geloescht und sein Worker-Prozess (w3wp.exe) beendet - Adminrechte noetig (UAC).' -ForegroundColor Yellow
Write-Host '         Visual Studio, Explorer-Fenster und Terminals in diesem Ordner vorher schliessen.' -ForegroundColor Yellow
Write-Host ''
if (-not $Force) {
    $answer = Read-Host 'Wirklich loeschen? [j/N]'
    if ($answer -notmatch '^(j|ja|y|yes)$') { Write-Host 'Abgebrochen.'; return }
}

# Laufende Visual-Studio-Instanzen mit dieser Solution erkennen
$vs = Get-CimInstance Win32_Process -Filter "Name='devenv.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($Path, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
if ($vs) { Write-Warning "Visual Studio hat den Klon noch geoeffnet (PID $($vs.ProcessId -join ', ')) - bitte schliessen, sonst schlaegt das Loeschen fehl." }

$iisScript = Join-Path $scriptDir 'PrIis.ps1'
$log = Join-Path $env:TEMP "PrIis-$([guid]::NewGuid().ToString('N')).log"
$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$iisScript`"", '-Action', 'Remove', '-Pool', $pool, '-LogFile', "`"$log`"")
if (Test-Path $Path) { $argList += @('-DeletePath', "`"$Path`"") }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$proc = if ($isAdmin) { Start-Process powershell.exe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden }
        else { Start-Process powershell.exe -ArgumentList $argList -Verb RunAs -Wait -PassThru -WindowStyle Hidden }
if (Test-Path $log) {
    Get-Content $log | Where-Object { $_ -and $_ -notmatch '^\*{5,}|^(Start|End) time|^Username|^RunAs|^Configuration|^Machine|^Host Application|^Process ID|^PS|^BuildVersion|^CLR|^WSMan|^Serialization|^Windows PowerShell|^Transcript' } | ForEach-Object { Write-Host "  $_" }
    Remove-Item $log -Force -ErrorAction SilentlyContinue
}
if ($proc.ExitCode -ne 0) { throw 'Loeschen nicht vollstaendig - Details oben.' }
Write-Host "Fertig: $pool entfernt." -ForegroundColor Green

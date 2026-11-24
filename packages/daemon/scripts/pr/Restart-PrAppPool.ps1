<#
.SYNOPSIS
    Recycelt den IIS-App-Pool eines Klons von Clone-Branch.ps1 (Pool = Ordnername, z.B. PR4373).

.DESCRIPTION
    Startet PrIis.ps1 -Action Recycle mit Adminrechten (UAC) und gibt dessen Ausgabe weiter.
    Ein laufender Pool wird recycelt, ein gestoppter gestartet.

.EXAMPLE
    .\Restart-PrAppPool.ps1 -Pool PR4373
#>
param(
    [Parameter(Mandatory)][string]$Pool
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ($Pool -notmatch '^[\w.-]+$') { throw "Ungueltiger Pool-Name '$Pool'." }

$iisScript = Join-Path $scriptDir 'PrIis.ps1'
$log = Join-Path $env:TEMP "PrIis-$([guid]::NewGuid().ToString('N')).log"
$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$iisScript`"", '-Action', 'Recycle', '-Pool', $Pool, '-LogFile', "`"$log`"")

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$proc = if ($isAdmin) { Start-Process powershell.exe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden }
        else { Start-Process powershell.exe -ArgumentList $argList -Verb RunAs -Wait -PassThru -WindowStyle Hidden }
if (Test-Path $log) {
    # Nur die eigentlichen Meldungen, ohne Transcript-Kopf
    Get-Content $log | Where-Object { $_ -match '^(App-Pool|FEHLER)' } | ForEach-Object { Write-Host $_ }
    Remove-Item $log -Force -ErrorAction SilentlyContinue
}
if ($proc.ExitCode -ne 0) { throw "App-Pool $Pool konnte nicht recycelt werden." }

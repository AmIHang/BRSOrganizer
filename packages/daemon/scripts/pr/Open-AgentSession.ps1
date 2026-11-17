<#
.SYNOPSIS
  Opens the Claude Code session of a todo agent in this console (claude attach).

.DESCRIPTION
  Started by BRSOrganizer when the user clicks the agent's question or answer of a todo. The
  session keeps running in the background when this window is closed.

.PARAMETER Name  Session name (Todo-<id>), as given by Start-TodoAgent.ps1.
#>
param(
  [Parameter(Mandatory)][ValidatePattern('^Todo-[A-Za-z0-9]{1,20}$')][string]$Name
)
$ErrorActionPreference = 'Stop'

# The daemon may have been started before claude was installed and passes on its old PATH:
# read the current one from the registry, and fall back to the native installer's location.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
  [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
$claude = (Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $claude -and (Test-Path "$env:USERPROFILE\.local\bin\claude.exe")) {
  $claude = "$env:USERPROFILE\.local\bin\claude.exe"
}
if (-not $claude) {
  throw 'claude (Claude Code CLI) wurde nicht gefunden - bitte installieren und in den PATH aufnehmen.'
}

& $claude attach $Name

<#
.SYNOPSIS
  Removes the TFVC workspace and folder an agent worked in (TFVC projects, see Start-TodoAgent.ps1).

.DESCRIPTION
  Started by BRSOrganizer when a todo's agent folder is removed. Deletes the workspace
  "BRSOrganizer-<folder name>" on the server, then the folder. Pending changes in it are lost:
  the agent has shelved its work. Only folders whose workspace has that name are touched.

.PARAMETER Path  The agent's folder (<parent of the project folder>\Todo-<id>).
#>
param([Parameter(Mandatory)][string]$Path)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'TfvcCommon.ps1')

$Path = [IO.Path]::GetFullPath($Path).TrimEnd('\')
$name = Split-Path $Path -Leaf
if ($name -notmatch '^Todo-[a-z0-9]{6}$') { throw "$Path ist kein Agent-Ordner (Todo-<id>)." }
$tf = Find-TfExe
$ws = Get-AgentWorkspaceName $name

if (Test-Path -LiteralPath $Path) {
  $map = $null
  try { $map = Get-TfvcMapping $tf $Path } catch { Write-Host "Kein Workspace mehr fuer $Path - nur der Ordner wird geloescht." }
  if ($map) {
    $ErrorActionPreference = 'Continue'
    $out = (& $tf workspace /delete "/collection:$($map.Collection)" $ws /noprompt 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "tf workspace /delete $ws fehlgeschlagen: $($out.Trim())" }
    Write-Host "Workspace $ws entfernt"
  }
  # \\?\ avoids the 260 character limit
  cmd /c "rd /s /q `"\\?\$Path`" 2>nul"
  if (Test-Path -LiteralPath $Path) { throw "Ordner $Path konnte nicht geloescht werden (gesperrt?)." }
  Write-Host "Ordner $Path entfernt"
}

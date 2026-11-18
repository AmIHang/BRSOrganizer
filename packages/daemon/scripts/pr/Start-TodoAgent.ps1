<#
.SYNOPSIS
  Creates a git worktree for a todo and hands the todo to a Claude Code agent (claude CLI).

.DESCRIPTION
  Started by BRSOrganizer ("An Agent weitergeben"). Fetches the project's main repo, creates
  <Root>\<Project>\<Name> as a worktree on a new branch from the remote default branch and starts
  claude there as a background session (claude --bg, permission mode auto) with the prompt from
  -PromptFile; the user looks in with `claude attach <Name>`. Where that is refused (e.g. the
  folder is not trusted yet), claude runs interactively in its own window instead. The agent
  implements the solution and creates the pull request itself. Prints "AGENT-MODE: background"
  or "AGENT-MODE: window" as its last line.

.PARAMETER Root     Projects folder (e.g. C:\projects-git).
.PARAMETER Project  Customer folder below Root.
.PARAMETER Repo     Main repo folder below the customer folder.
.PARAMETER Name     Worktree folder name (below the customer folder).
.PARAMETER Branch   New branch for the worktree.
.PARAMETER PromptFile  File with the task (in TEMP); the agent reads it, so it is kept.
#>
param(
  [Parameter(Mandatory)][string]$Root,
  [Parameter(Mandatory)][string]$Project,
  [Parameter(Mandatory)][string]$Repo,
  [Parameter(Mandatory)][string]$Name,
  [Parameter(Mandatory)][string]$Branch,
  [Parameter(Mandatory)][string]$PromptFile
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $PromptFile)) { throw "Auftragsdatei fehlt: $PromptFile" }

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

$repoDir = Join-Path (Join-Path $Root $Project) $Repo
$worktree = Join-Path (Join-Path $Root $Project) $Name
if (Test-Path -LiteralPath $worktree) { throw "Ordner existiert bereits: $worktree" }

Write-Host "Repo:     $repoDir"
git -C $repoDir fetch --prune origin
if ($LASTEXITCODE -ne 0) { throw 'git fetch fehlgeschlagen' }

# Base: the remote default branch (origin/HEAD), else the branch checked out in the main repo.
$base = (git -C $repoDir symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null)
if (-not $base) { $base = 'origin/' + (git -C $repoDir rev-parse --abbrev-ref HEAD) }
$target = $base -replace '^origin/', ''

Write-Host "Worktree: $worktree ($Branch von $base)"
git -C $repoDir worktree add -b $Branch $worktree $base
if ($LASTEXITCODE -ne 0) { throw 'git worktree add fehlgeschlagen' }

$notes = @()

# IIS URLs with -<Name>, as for PR clones, so the worktree runs next to the others. Only local:
# a clean filter strips the suffix again whenever a *.csproj is staged, so it is never committed,
# while other changes to the same file are. sed -b keeps CRLF; the pattern only matches
# "-Todo-<id>" suffixes, so the filter changes nothing in the main repo or other worktrees.
$webApps = @(& (Join-Path $PSScriptRoot 'Set-IisUrls.ps1') -Target $worktree -Name $Name)
if ($webApps) {
  git -C $repoDir config filter.brsorganizer-iisurl.clean "sed -b -E 's#(<IISUrl>[^<]*)-Todo-[a-z0-9]+/</IISUrl>#\1/</IISUrl>#'"
  if ($LASTEXITCODE -ne 0) { throw 'git config fuer den IISUrl-Filter fehlgeschlagen' }
  $commonDir = (git -C $worktree rev-parse --path-format=absolute --git-common-dir).Trim()
  $attributes = Join-Path $commonDir 'info\attributes'
  $line = '*.csproj filter=brsorganizer-iisurl'
  New-Item -ItemType Directory -Force -Path (Split-Path $attributes) | Out-Null
  if (-not ((Test-Path $attributes) -and (Get-Content $attributes) -contains $line)) {
    Add-Content -LiteralPath $attributes -Encoding ASCII -Value $line
  }
  # Stages the files through the filter (same content as HEAD), so git status and
  # `git worktree remove` do not see them as modified just because their size changed.
  git -C $worktree add -- @($webApps | ForEach-Object File)
  if ($LASTEXITCODE -ne 0) { throw 'git add der angepassten *.csproj fehlgeschlagen' }
  Write-Host "IIS-URLs: $(($webApps | ForEach-Object Url) -join ', ')"
  $notes += "Die IISUrl in $(($webApps | ForEach-Object File) -join ', ') ist nur lokal auf -$Name angepasst " +
    '(eigene IIS-App neben anderen Klonen). Ein Git-Filter entfernt den Suffix beim Committen automatisch - ' +
    'die Zeile also nicht von Hand zuruecksetzen und nicht selbst committen.'
}

# BORA module references, as for PR clones: from the shared cache, missing ones via bfdesignc.
# A failure does not stop the agent; it is told about it.
try {
  $refArgs = @{ Target = $worktree; Project = $Project; RefCache = (Join-Path $Root '_refcache') }
  $failedRefs = @(& (Join-Path $PSScriptRoot 'Update-BoraReferences.ps1') @refArgs)
  if ($failedRefs) {
    $notes += "Hinweis: BORA-Modulreferenzen konnten nicht geladen werden fuer: $($failedRefs -join ', ') " +
      '(bfdesignc /updatereferences). Vor dem Bauen erneut versuchen.'
  }
} catch {
  $notes += "Hinweis: BORA-Modulreferenzen wurden nicht geladen: $($_.Exception.Message)"
}

Add-Content -LiteralPath $PromptFile -Encoding UTF8 -Value (@(
  '',
  "Arbeitsverzeichnis: $worktree (git worktree, Branch $Branch, abgezweigt von $base).",
  "Ziel-Branch des Pull Requests: $target."
) + $notes)

# The task travels as a file: multi-line arguments with quotes do not survive PowerShell 5.1
# native argument passing (or claude.cmd) intact.
Set-Location -LiteralPath $worktree
$task = "Lies deinen Auftrag aus der Datei $PromptFile und fuehre ihn vollstaendig aus."

# Background session without a window. Permission mode auto: a classifier approves the usual
# steps (edit, build, commit, push, PR) and stops risky ones; the ticket texts are external.
$ErrorActionPreference = 'Continue' # claude writes progress to stderr
$out = (& $claude --bg -n $Name --permission-mode auto $task 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -eq 0) {
  Write-Output $out
  Write-Output 'AGENT-MODE: background'
  return
}

# Refused (e.g. "Workspace not trusted"): interactively in its own window, as before.
Write-Output "claude --bg: $out"
# Same session name as in the background, so BRSOrganizer sees while the window is open.
Start-Process -FilePath $claude -WorkingDirectory $worktree -ArgumentList "-n $Name `"$task`""
Write-Output 'AGENT-MODE: window'

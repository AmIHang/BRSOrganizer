<#
.SYNOPSIS
  Opens the Claude Code session of a todo agent or a pull request in this console (claude attach).

.DESCRIPTION
  Started by BRSOrganizer when the user clicks the agent's question or answer of a todo, or the
  Claude button of a pull request. The session keeps running in the background when this window
  is closed; an ended one (e.g. after a restart) resumes when attached.

  With -Path and -PromptFile, a session that never ran (a pull request without a session yet, or a
  todo agent whose window was closed at the trust prompt) is first started as a background
  session in -Path with the task from -PromptFile, then opened the same way.

.PARAMETER Name        Session name: Todo-<id> (Start-TodoAgent.ps1) or PR<number>.
.PARAMETER Path        Folder to start a new session in (PR checkout or agent worktree); without
                       -PromptFile the folder whose newest transcript is resumed when the session
                       is no longer listed.
.PARAMETER PromptFile  Task of a new session; the session reads it, so it is kept.
#>
param(
  [Parameter(Mandatory)][ValidatePattern('^(Todo-[A-Za-z0-9]{1,20}|PR\d{1,10})$')][string]$Name,
  [string]$Path,
  [string]$PromptFile
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

# claude attach takes a name only for a running session; an ended one (e.g. after a restart) needs
# its id. So look the id up: the running session of that name, else the one started last.
$ErrorActionPreference = 'Continue'
$target = $Name
try {
  # Into a variable first: PowerShell 5.1 passes ConvertFrom-Json's array on as one object.
  $all = (& $claude agents --json --all 2>$null | Out-String) | ConvertFrom-Json
  $sessions = @($all | Where-Object { $_.name -eq $Name })
  $session = @($sessions | Where-Object { $_.pid }) + @($sessions | Sort-Object { [double]$_.startedAt } -Descending) |
    Select-Object -First 1
  if ($session -and $session.id) {
    $target = [string]$session.id
  } elseif ($session -and -not $session.pid -and $session.sessionId -and (Test-Path -LiteralPath $session.cwd)) {
    # Ended interactive session (the hand-off ran in a window of its own): no short id to attach
    # to, so resume it here, in its folder.
    Set-Location -LiteralPath $session.cwd
    & $claude --resume ([string]$session.sessionId)
    return
  } elseif (-not $session -and $Name -like 'Todo-*' -and $Path -and (Test-Path -LiteralPath $Path)) {
    # Only a todo's worktree is the agent's own; a PR checkout may hold unrelated transcripts.
    # Not listed at all (an interactive session that ended drops out of `claude agents`): resume
    # the newest transcript of the agent's folder.
    $folder = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $dir = Join-Path $env:USERPROFILE ('.claude\projects\' + ($folder -replace '[^A-Za-z0-9]', '-'))
    $last = Get-ChildItem -LiteralPath $dir -Filter *.jsonl -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($last) {
      Set-Location -LiteralPath $folder
      & $claude --resume $last.BaseName
      return
    }
  }
} catch {
  Write-Warning "Sitzungsliste nicht lesbar, oeffne per Name: $($_.Exception.Message)"
}
if (-not $session -and $PromptFile -and $Path -and (Test-Path -LiteralPath $PromptFile)) {
  # Never ran: start it with its task; attach below (by name) once it runs in the background.
  Set-Location -LiteralPath $Path
  # As in Start-TodoAgent.ps1: the task travels as a file (multi-line arguments do not survive).
  $task = "Lies deinen Auftrag aus der Datei $PromptFile und fuehre ihn aus."
  & $claude --bg -n $Name --permission-mode auto $task
  if ($LASTEXITCODE -ne 0) {
    # Refused (e.g. folder not trusted yet): interactively in this window, trust prompt included.
    & $claude -n $Name $task
    return
  }
}
& $claude attach $target

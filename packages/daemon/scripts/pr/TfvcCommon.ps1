<#
.SYNOPSIS
  Helpers for projects in TFVC (Team Foundation Version Control), dot-sourced by
  Start-TodoAgent.ps1 and Remove-TfvcWorkspace.ps1.
#>

# TF.exe: on PATH, else the newest Visual Studio installation that has Team Explorer.
function Find-TfExe {
  $tf = (Get-Command tf.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($tf) { return $tf }
  $pattern = 'Microsoft Visual Studio\*\*\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe'
  $found = @(Get-ChildItem (Join-Path $env:ProgramFiles $pattern), (Join-Path ${env:ProgramFiles(x86)} $pattern) -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1)
  if (-not $found) { throw 'TF.exe nicht gefunden - Visual Studio mit Team Explorer installieren.' }
  return $found[0].FullName
}

# Collection URL and server path of a mapped local folder, from `tf workfold`. Works with the
# localized output: the URL is the only http(s) value, mappings are "$/server/path: C:\local".
function Get-TfvcMapping([string]$Tf, [string]$Folder) {
  $ErrorActionPreference = 'Continue' # tf writes to stderr; the exit code tells
  $Folder = [IO.Path]::GetFullPath($Folder).TrimEnd('\')
  $out = (& $Tf workfold $Folder 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "tf workfold $Folder fehlgeschlagen: $($out.Trim())" }
  $collection = [regex]::Match($out, 'https?://[^\s]+').Value.TrimEnd('/')
  if (-not $collection) { throw "Keine TFS-Collection fuer $Folder gefunden." }
  $best = $null
  foreach ($m in [regex]::Matches($out, '(?m)^\s*(\$/[^\r\n]*?):\s+([A-Za-z]:\\[^\r\n]*?)\s*$')) {
    $local = $m.Groups[2].Value.TrimEnd('\')
    $inside = $Folder -eq $local -or $Folder.StartsWith("$local\", [StringComparison]::OrdinalIgnoreCase)
    if ($inside -and (-not $best -or $local.Length -gt $best.Local.Length)) {
      $best = @{ Server = $m.Groups[1].Value.TrimEnd('/'); Local = $local }
    }
  }
  if (-not $best) { throw "$Folder ist in keinem TFVC-Workspace gemappt." }
  $rest = $Folder.Substring($best.Local.Length) -replace '\\', '/'
  return @{ Collection = $collection; Server = $best.Server + $rest }
}

# Name of the TFVC workspace BRSOrganizer creates for a todo folder (Todo-<id>).
function Get-AgentWorkspaceName([string]$Name) { return "BRSOrganizer-$Name" }

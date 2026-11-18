<#
.SYNOPSIS
    Haengt -<Name> an die IIS-URLs der Web-Projekte eines Klons bzw. Worktrees.

.DESCRIPTION
    Gemeinsam genutzt von Clone-Branch.ps1 und Start-TodoAgent.ps1. Jedes *.csproj mit
    <UseIIS>True</UseIIS> bekommt in <IISUrl> den Suffix -<Name> (z.B. /BM.Web-PR4373/), damit
    mehrere Klone nebeneinander im IIS laufen. Encoding (BOM) und Zeilenenden bleiben erhalten;
    ein zweiter Lauf aendert nichts.

    Gibt pro Web-Projekt ein Objekt aus: Url, AppPath, OrigPath, PhysicalPath, File.
#>
param(
    [Parameter(Mandatory)][string]$Target,
    [Parameter(Mandatory)][string]$Name
)
$ErrorActionPreference = 'Stop'

foreach ($rel in @(git -C $Target ls-files '*.csproj')) {
    $file = Join-Path $Target ($rel -replace '/', '\')
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
    [pscustomobject]@{
        Url          = "$($m.Groups['base'].Value)/$newPath/"
        AppPath      = "/$newPath"
        OrigPath     = "/$origPath"
        PhysicalPath = (Split-Path $file)
        File         = $rel
    }
}

<#
.SYNOPSIS
    IIS-Hilfsskript fuer Clone-Branch.ps1 / Remove-PrClone.ps1 (braucht Adminrechte).

.DESCRIPTION
    -Action Setup : App-Pool <Pool> anlegen (Identitaet = Benutzer/Passwort eines vorhandenen Pools, z.B. dem
                    Pool der Original-App) und die Web-Apps aus -AppsFile (JSON) unter "Default Web Site" anlegen.
    -Action Remove: Alle Apps im App-Pool <Pool> und den Pool selbst loeschen, optional danach -DeletePath loeschen.

    Das Passwort wird ueber Microsoft.Web.Administration direkt von Pool zu Pool kopiert - es wird weder
    angezeigt noch auf der Kommandozeile uebergeben.
#>
param(
    [Parameter(Mandatory)][ValidateSet('Setup', 'Remove')][string]$Action,
    [Parameter(Mandatory)][string]$Pool,
    [string]$AppsFile,
    [string]$DeletePath,
    [string]$LogFile
)

$ErrorActionPreference = 'Stop'
if ($LogFile) { Start-Transcript -Path $LogFile -Force | Out-Null }
$exit = 0
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { throw 'PrIis.ps1 braucht Adminrechte.' }
    if ($Pool -notmatch '^[\w.-]+$') { throw "Ungueltiger Pool-Name '$Pool'." }

    $dll = Join-Path $env:windir 'system32\inetsrv\Microsoft.Web.Administration.dll'
    if (-not (Test-Path $dll)) { throw 'IIS ist nicht installiert (Microsoft.Web.Administration.dll fehlt).' }
    Add-Type -Path $dll
    $sm = New-Object Microsoft.Web.Administration.ServerManager

    if ($Action -eq 'Setup') {
        # PS 5.1 gibt ein JSON-Array als EIN Objekt aus - per Pipeline in Einzelelemente zerlegen
        $apps = @((Get-Content $AppsFile -Raw | ConvertFrom-Json) | ForEach-Object { $_ })

        # Site fuer http://localhost/... = Site mit http-Binding auf Port 80
        $site = $sm.Sites | Where-Object { $_.Bindings | Where-Object { $_.Protocol -eq 'http' -and $_.BindingInformation -match ':80:' } } | Select-Object -First 1
        if (-not $site) { $site = $sm.Sites['Default Web Site'] }
        if (-not $site) { throw 'Keine IIS-Site auf Port 80 gefunden.' }

        # Vorlage fuer die Identitaet: Pool der Original-App (z.B. /CommunityOperations), sonst ein Pool mit dem aktuellen Benutzer
        $me = "$env:USERDOMAIN\$env:USERNAME"
        $tpl = $null
        foreach ($a in $apps) {
            $orig = $site.Applications[$a.OrigPath]
            if ($orig) {
                $p = $sm.ApplicationPools[$orig.ApplicationPoolName]
                if ($p -and $p.Name -ne $Pool -and "$($p.ProcessModel.IdentityType)" -eq 'SpecificUser') { $tpl = $p; break }
            }
        }
        if (-not $tpl) {
            $tpl = $sm.ApplicationPools | Where-Object { $_.Name -ne $Pool -and "$($_.ProcessModel.IdentityType)" -eq 'SpecificUser' -and $_.ProcessModel.UserName -eq $me } | Select-Object -First 1
        }

        $appPool = $sm.ApplicationPools[$Pool]
        if (-not $appPool) { $appPool = $sm.ApplicationPools.Add($Pool); Write-Host "App-Pool $Pool angelegt" } else { Write-Host "App-Pool $Pool existiert - aktualisiere" }
        $appPool.ManagedPipelineMode = 'Integrated'
        if ($tpl) {
            $appPool.ManagedRuntimeVersion = $tpl.ManagedRuntimeVersion
            $appPool.Enable32BitAppOnWin64 = $tpl.Enable32BitAppOnWin64
            $appPool.ProcessModel.IdentityType = 'SpecificUser'
            $appPool.ProcessModel.UserName = $tpl.ProcessModel.UserName
            $appPool.ProcessModel.Password = $tpl.ProcessModel.Password
            Write-Host "Identitaet $($tpl.ProcessModel.UserName) (uebernommen von App-Pool '$($tpl.Name)')"
        } else {
            $appPool.ManagedRuntimeVersion = 'v4.0'
            Write-Warning "Kein App-Pool mit Benutzer $me gefunden - $Pool laeuft mit ApplicationPoolIdentity. Bitte Identitaet im IIS-Manager setzen."
        }

        foreach ($a in $apps) {
            $app = $site.Applications[$a.AppPath]
            if (-not $app) {
                $app = $site.Applications.Add($a.AppPath, $a.PhysicalPath)
                Write-Host "Web-App angelegt: http://localhost$($a.AppPath)"
            } else {
                $app.VirtualDirectories['/'].PhysicalPath = $a.PhysicalPath
                Write-Host "Web-App aktualisiert: http://localhost$($a.AppPath)"
            }
            $app.ApplicationPoolName = $Pool
        }
        $sm.CommitChanges()
    }

    if ($Action -eq 'Remove') {
        $removed = 0
        foreach ($s in @($sm.Sites)) {
            foreach ($app in @($s.Applications | Where-Object { $_.ApplicationPoolName -eq $Pool -and $_.Path -ne '/' })) {
                Write-Host "Web-App entfernt: $($s.Name)$($app.Path)"
                $s.Applications.Remove($app); $removed++
            }
        }
        $appPool = $sm.ApplicationPools[$Pool]
        if ($appPool) {
            try { if ("$($appPool.State)" -eq 'Started') { $null = $appPool.Stop() } } catch { }
            $sm.ApplicationPools.Remove($appPool)
            Write-Host "App-Pool $Pool entfernt"
        } else {
            Write-Host "App-Pool $Pool existiert nicht (mehr)"
        }
        $sm.CommitChanges()

        # Worker-Prozess des Pools beenden, falls er noch Dateien sperrt
        Get-CimInstance Win32_Process -Filter "Name='w3wp.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match "-ap `"$([regex]::Escape($Pool))`"" } |
            ForEach-Object { Write-Host "Beende w3wp.exe (PID $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

        if ($DeletePath) {
            if (-not (Test-Path (Join-Path $DeletePath '.git\clone-branch'))) { throw "$DeletePath ist kein Klon von Clone-Branch.ps1 - wird nicht geloescht." }
            Write-Host "Loesche $DeletePath ..."
            for ($i = 1; $i -le 6 -and (Test-Path $DeletePath); $i++) {
                # \\?\ umgeht das 260-Zeichen-Limit beim Loeschen
                cmd /c "rd /s /q `"\\?\$DeletePath`"" 2>$null
                if (Test-Path $DeletePath) { Start-Sleep -Seconds 2 }
            }
            if (Test-Path $DeletePath) {
                throw "Ordner $DeletePath konnte nicht vollstaendig geloescht werden - vermutlich noch durch Visual Studio, den Explorer oder ein Terminal gesperrt. Diese schliessen und erneut ausfuehren."
            }
            Write-Host "Ordner geloescht"
        }
    }
} catch {
    Write-Host "FEHLER: $($_.Exception.Message)" -ForegroundColor Red
    $exit = 1
} finally {
    if ($LogFile) { Stop-Transcript | Out-Null }
}
exit $exit

import { runPowerShell } from '@brsorganizer/core';

export interface CloseIdeResult {
  /** Visual Studio instances that had the PR solution open. */
  closed: number;
  /** Of those, how many had to be terminated (e.g. a save dialog blocked closing). */
  forced: number;
}

/** Closes Visual Studio windows that have a PR checkout open; injectable for tests. */
export type CloseIde = (clonePath: string, prId: number) => Promise<CloseIdeResult>;

/**
 * Finds devenv.exe instances whose command line contains the checkout path (solution opened
 * from Explorer or the app) or whose window title names the PR solution ("<Kunde> │ PR<Nr>"),
 * asks them to close, and terminates what is still running after 20 seconds. Used before the
 * checkout is deleted after a merge, so nothing of value is lost.
 */
export const closeVisualStudio: CloseIde = async (clonePath, prId) => {
  const script = String.raw`
$path = $env:BRSORGANIZER_CLONE
$tag = '\bPR' + $env:BRSORGANIZER_PRID + '\b'
$ids = @(Get-CimInstance Win32_Process -Filter "Name='devenv.exe'" | Where-Object {
  ($_.CommandLine -and $_.CommandLine.IndexOf($path, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
  ((Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowTitle -match $tag)
} | ForEach-Object { [int]$_.ProcessId })
foreach ($id in $ids) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() } }
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline -and @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count) { Start-Sleep -Milliseconds 500 }
$left = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
foreach ($id in $left) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
[pscustomobject]@{ closed = $ids.Count; forced = $left.Count } | ConvertTo-Json -Compress
`;
  const out = await runPowerShell(
    script,
    { BRSORGANIZER_CLONE: clonePath, BRSORGANIZER_PRID: String(prId) },
    'Visual Studio',
  );
  return JSON.parse(out || '{"closed":0,"forced":0}') as CloseIdeResult;
};

import { spawn } from 'node:child_process';

/** Starts things the user should see: script consoles and files/folders in their default app. */
export interface Launcher {
  /** Runs a PowerShell script in its own, visible console window that stays open afterwards. */
  runScript(title: string, scriptPath: string, args: string[]): void;
  /** Opens a file (e.g. a .sln) with its default application, or a folder in Explorer. */
  open(path: string): void;
}

/** PowerShell single-quoted literal. */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The command a script console runs (exported for tests). */
export function scriptCommand(title: string, scriptPath: string, args: string[]): string {
  const call = [
    `& ${psQuote(scriptPath)}`,
    ...args.map((a) => (a.startsWith('-') ? a : psQuote(a))),
  ].join(' ');
  return [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`,
    `try { ${call} } catch { Write-Host "FEHLER: $($_.Exception.Message)" -ForegroundColor Red }`,
    `Write-Host ''; Write-Host 'Fertig - dieses Fenster kann geschlossen werden.' -ForegroundColor Green`,
  ].join('; ');
}

export const windowsLauncher: Launcher = {
  runScript(title, scriptPath, args) {
    const encoded = Buffer.from(scriptCommand(title, scriptPath, args), 'utf16le').toString(
      'base64',
    );
    // detached: on Windows the child gets its own console window and outlives the daemon.
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-EncodedCommand', encoded],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  },
  open(path) {
    const child = spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' });
    child.unref();
  },
};

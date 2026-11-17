import { execFile, spawn } from 'node:child_process';

/** Starts things the user should see: script consoles and files/folders in their default app. */
export interface Launcher {
  /**
   * Runs a PowerShell script in its own, visible console window that stays open afterwards.
   * `env` is added to the window's environment (for secrets: never on the command line).
   */
  runScript(title: string, scriptPath: string, args: string[], env?: Record<string, string>): void;
  /**
   * Runs a PowerShell script without any window and waits for it. A thrown error ends up as a
   * stdout line "FEHLER: <message>" with exit code 1.
   */
  runHidden(
    scriptPath: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
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

/** The command a hidden script run executes: errors as a single line, exit code 1. */
export function hiddenCommand(scriptPath: string, args: string[]): string {
  const call = [
    `& ${psQuote(scriptPath)}`,
    ...args.map((a) => (a.startsWith('-') ? a : psQuote(a))),
  ].join(' ');
  // stdout, not stderr: with redirected streams PowerShell 5.1 writes CLIXML to stderr.
  return (
    `$ProgressPreference = 'SilentlyContinue'; ` +
    `try { ${call} } catch { Write-Output ('FEHLER: ' + $_.Exception.Message); exit 1 }`
  );
}

/**
 * cmd.exe arguments that open the script in a NEW console window via `start`.
 *
 * Spawning powershell.exe directly with `detached: true` does not work: Node passes
 * DETACHED_PROCESS, so PowerShell gets no console at all, shows nothing and exits at once
 * (the daemon itself runs without a console). `start` always creates a visible window.
 * The script travels base64-encoded, so no quoting of user paths reaches cmd.exe.
 */
export function startArguments(title: string, scriptPath: string, args: string[]): string {
  const encoded = Buffer.from(scriptCommand(title, scriptPath, args), 'utf16le').toString('base64');
  // The window title is only cosmetic (PowerShell sets the real one); keep cmd-safe characters.
  const safeTitle = title.replace(/[^\w .#()-]/g, '_');
  return `/d /c start "${safeTitle}" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -EncodedCommand ${encoded}`;
}

export function createWindowsLauncher(onError: (err: Error) => void = () => undefined): Launcher {
  return {
    runScript(title, scriptPath, args, env) {
      const child = spawn('cmd.exe', [startArguments(title, scriptPath, args)], {
        // `start` passes cmd's environment on to the new console.
        env: env ? { ...process.env, ...env } : process.env,
        windowsVerbatimArguments: true,
        windowsHide: true, // hides cmd.exe itself, not the window `start` opens
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', onError);
      child.unref();
    },
    runHidden(scriptPath, args, env) {
      const encoded = Buffer.from(hiddenCommand(scriptPath, args), 'utf16le').toString('base64');
      return new Promise((resolve) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            encoded,
          ],
          {
            env: env ? { ...process.env, ...env } : process.env,
            windowsHide: true,
            // A hanging git (e.g. a credential prompt) must not block the hand-off forever.
            timeout: 10 * 60_000,
            maxBuffer: 4 * 1024 * 1024,
          },
          (err, stdout, stderr) =>
            resolve({
              code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
              stdout,
              stderr: err && !stderr ? err.message : stderr,
            }),
        );
      });
    },
    open(path) {
      const child = spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' });
      child.on('error', onError);
      child.unref();
    },
  };
}

export const windowsLauncher: Launcher = createWindowsLauncher();

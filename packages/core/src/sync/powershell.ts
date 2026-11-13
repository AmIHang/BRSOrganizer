import { execFile } from 'node:child_process';

const TIMEOUT_MS = 90_000;

/**
 * Runs a PowerShell script (Windows only) and returns its stdout.
 * Parameters go in as environment variables, never interpolated into the script text.
 * `what` names the thing being read, for error messages (must not contain secrets).
 */
export function runPowerShell(
  script: string,
  env: Record<string, string>,
  what: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error(`${what}: only available on Windows`));
      return;
    }
    const prelude = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
`;
    const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, ...env },
        timeout: TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).split(/\r?\n/).find((l) => l.trim()) ?? '';
          reject(new Error(`${what} could not be read: ${detail.trim()}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** ConvertTo-Json turns single-element arrays into objects and empty ones into nothing. */
export const asArray = <T>(v: T | T[] | null | undefined): T[] =>
  v == null ? [] : ([] as T[]).concat(v);

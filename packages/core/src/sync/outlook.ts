import { execFile } from 'node:child_process';
import type { MailboxReader, PrMailbox } from './mail-prs.js';

/**
 * Reads one folder of the classic Outlook desktop client via COM (PowerShell).
 * No credentials involved: it uses the logged-in user's Outlook profile. If Outlook is not
 * running, COM starts it in the background.
 *
 * Parameters are passed as environment variables, never interpolated into the script.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
$folder = $ns.DefaultStore.GetRootFolder()
foreach ($part in ($env:AMINEEDED_OL_FOLDER -split '[\\/]' | Where-Object { $_ })) {
  $folder = $folder.Folders.Item($part)
}
$cutoff = (Get-Date).AddDays(-[int]$env:AMINEEDED_OL_DAYS)
$items = $folder.Items
$items.Sort('[ReceivedTime]', $true)
$out = New-Object System.Collections.Generic.List[object]
foreach ($m in $items) {
  if ($m.MessageClass -ne 'IPM.Note') { continue }
  if ($m.ReceivedTime -lt $cutoff) { break }
  $body = [string]$m.Body
  if ($body.Length -gt 3000) { $body = $body.Substring(0, 3000) }
  $urls = @([regex]::Matches([string]$m.HTMLBody, 'href="([^"]+)"', 'IgnoreCase') |
    ForEach-Object { $_.Groups[1].Value } |
    Where-Object { $_ -match 'pullrequest' } |
    Select-Object -Unique -First 5)
  $out.Add([pscustomobject]@{
    receivedAt = $m.ReceivedTime.ToUniversalTime().ToString('o')
    subject = [string]$m.Subject
    body = $body
    urls = $urls
  })
}
[pscustomobject]@{ me = [string]$ns.CurrentUser.Name; mails = $out.ToArray() } | ConvertTo-Json -Depth 4 -Compress
`;

const TIMEOUT_MS = 90_000;

export const outlookComReader: MailboxReader = ({ folderPath, lookBackDays }) =>
  new Promise<PrMailbox>((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Outlook mail source is only available on Windows'));
      return;
    }
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: {
          ...process.env,
          AMINEEDED_OL_FOLDER: folderPath,
          AMINEEDED_OL_DAYS: String(lookBackDays),
        },
        timeout: TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).split(/\r?\n/).find((l) => l.trim()) ?? '';
          reject(new Error(`Outlook folder "${folderPath}" could not be read: ${detail.trim()}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim() || '{}') as Partial<PrMailbox>;
          // ConvertTo-Json turns single-element arrays into objects.
          const mails = parsed.mails ? ([] as PrMailbox['mails']).concat(parsed.mails) : [];
          resolve({
            me: parsed.me ?? null,
            mails: mails.map((m) => ({ ...m, urls: ([] as string[]).concat(m.urls ?? []) })),
          });
        } catch (e) {
          reject(new Error(`unexpected Outlook reader output: ${(e as Error).message}`));
        }
      },
    );
  });

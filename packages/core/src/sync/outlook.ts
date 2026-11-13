import type { MailboxReader, PrMailbox } from './mail-prs.js';
import type { CalendarReader, OutlookAppointment } from './outlook-calendar.js';
import { asArray, runPowerShell } from './powershell.js';

/**
 * Access to the classic Outlook desktop client via COM (PowerShell).
 * No credentials involved: it uses the logged-in user's Outlook profile. If Outlook is not
 * running, COM starts it in the background.
 */

const OUTLOOK_PRELUDE = String.raw`
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
`;

const runOutlookScript = (script: string, env: Record<string, string>, what: string) =>
  runPowerShell(OUTLOOK_PRELUDE + script, env, what);

const MAIL_SCRIPT = String.raw`
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

export const outlookComReader: MailboxReader = async ({ folderPath, lookBackDays }) => {
  const stdout = await runOutlookScript(
    MAIL_SCRIPT,
    { AMINEEDED_OL_FOLDER: folderPath, AMINEEDED_OL_DAYS: String(lookBackDays) },
    `Outlook folder "${folderPath}"`,
  );
  try {
    const parsed = JSON.parse(stdout || '{}') as Partial<PrMailbox>;
    return {
      me: parsed.me ?? null,
      mails: asArray(parsed.mails).map((m) => ({ ...m, urls: asArray(m.urls) })),
    };
  } catch (e) {
    throw new Error(`unexpected Outlook reader output: ${(e as Error).message}`);
  }
};

/**
 * Default calendar of the default store, recurrences expanded. Restrict needs dates in the
 * user's locale ('g' format); Sort + IncludeRecurrences must come before Restrict.
 */
const CALENDAR_SCRIPT = String.raw`
$inv = [Globalization.CultureInfo]::InvariantCulture
$kind = [Globalization.DateTimeStyles]::RoundtripKind
$from = [DateTime]::Parse($env:AMINEEDED_CAL_FROM, $inv, $kind).ToLocalTime()
$to = [DateTime]::Parse($env:AMINEEDED_CAL_TO, $inv, $kind).ToLocalTime()
$items = $ns.GetDefaultFolder(9).Items
$items.Sort('[Start]')
$items.IncludeRecurrences = $true
$filter = "[Start] < '" + $to.ToString('g') + "' AND [End] > '" + $from.ToString('g') + "'"
$out = New-Object System.Collections.Generic.List[object]
$n = 0
foreach ($a in $items.Restrict($filter)) {
  if (++$n -gt 2000) { break }
  if ($a.Start -ge $to) { break }
  $body = [string]$a.Body
  $join = [regex]::Match($body, 'https://teams\.microsoft\.com/l/meetup-join/[^\s<>"]+').Value
  $out.Add([pscustomobject]@{
    id = [string]$a.GlobalAppointmentID
    entryId = [string]$a.EntryID
    subject = [string]$a.Subject
    start = $a.Start.ToUniversalTime().ToString('o')
    end = $a.End.ToUniversalTime().ToString('o')
    allDay = [bool]$a.AllDayEvent
    location = [string]$a.Location
    organizer = [string]$a.Organizer
    busyStatus = [int]$a.BusyStatus
    meetingStatus = [int]$a.MeetingStatus
    responseStatus = [int]$a.ResponseStatus
    isRecurring = [bool]$a.IsRecurring
    joinUrl = $join
  })
}
ConvertTo-Json -InputObject @($out.ToArray()) -Depth 3 -Compress
`;

export const outlookCalendarReader: CalendarReader = async ({ from, to }) => {
  const stdout = await runOutlookScript(
    CALENDAR_SCRIPT,
    { AMINEEDED_CAL_FROM: from.toISOString(), AMINEEDED_CAL_TO: to.toISOString() },
    'Outlook calendar',
  );
  try {
    return asArray(JSON.parse(stdout || '[]') as OutlookAppointment | OutlookAppointment[]);
  } catch (e) {
    throw new Error(`unexpected Outlook calendar output: ${(e as Error).message}`);
  }
};

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWindowsLauncher } from '../src/prs/launcher.js';

describe.skipIf(process.platform !== 'win32')('windows launcher', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('answers when the script ends, even if a process it started lives on', async () => {
    dir = mkdtempSync(join(tmpdir(), 'launcher-'));
    const script = join(dir, 'start.ps1');
    // Like `claude --bg`: a detached process that outlives the script and inherits its pipes.
    const node = process.execPath.replace(/'/g, "''");
    writeFileSync(
      script,
      `$null = (& '${node}' -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'ignore'}).unref()" 2>&1 | Out-String)\r\n` +
        `Write-Output 'AGENT-MODE: background'\r\n`,
    );
    const started = Date.now();
    const run = await createWindowsLauncher().runHidden(script, []);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('AGENT-MODE: background');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

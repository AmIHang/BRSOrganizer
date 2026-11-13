<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { DaemonStatus, SecretsStatus, Settings } from '../lib/types';

  let { onclose }: { onclose: () => void } = $props();

  interface McpPaths {
    node: string;
    script: string;
    installed: boolean;
  }

  let settings = $state<Settings | null>(null);
  let secrets = $state<SecretsStatus | null>(null);
  let status = $state<DaemonStatus | null>(null);
  let mcp = $state<McpPaths | null>(null);
  let hotkey = $state('');
  let autostart = $state(false);
  let githubToken = $state('');
  let icsUrl = $state('');
  let message = $state<{ text: string; error: boolean } | null>(null);
  let copied = $state<string | null>(null);

  async function load() {
    [settings, secrets, status] = await Promise.all([api.settings(), api.secrets(), api.status()]);
  }

  onMount(async () => {
    try {
      await load();
    } catch (e) {
      flash(String(e), true);
    }
    mcp = await invoke<McpPaths | null>('mcp_paths').catch(() => null);
    hotkey = await invoke<string>('hotkey_label').catch(() => '');
    autostart = await isEnabled().catch(() => false);
  });

  function flash(text: string, error = false) {
    message = { text, error };
    setTimeout(() => (message = null), 4000);
  }

  async function run(action: () => Promise<unknown>, ok: string) {
    try {
      await action();
      await load();
      flash(ok);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  }

  const patch = (p: Record<string, unknown>) =>
    run(() => api.updateSettings(p), 'Gespeichert');

  async function saveToken() {
    await run(() => api.setSecret('github-token', githubToken.trim()), 'GitHub-Token gespeichert');
    githubToken = '';
  }

  async function saveIcs() {
    await run(() => api.setSecret('calendar-ics-url', icsUrl.trim()), 'Kalender-URL gespeichert');
    icsUrl = '';
  }

  async function toggleAutostart() {
    try {
      if (autostart) await disable();
      else await enable();
      autostart = await isEnabled();
    } catch (e) {
      flash(String(e), true);
    }
  }

  const q = (s: string) => `"${s}"`;
  const snippets = $derived(
    mcp
      ? [
          {
            label: 'Claude Code (Windows)',
            text: `claude mcp add amineeded --scope user -- ${q(mcp.node)} ${q(mcp.script)} --client claude`,
          },
          {
            label: 'Claude Code (WSL)',
            text: `claude mcp add amineeded --scope user -- "$(wslpath '${mcp.node}')" '${mcp.script}' --client claude`,
          },
          {
            label: 'Claude Desktop / VS Code (args)',
            text: JSON.stringify(
              { command: mcp.node, args: [mcp.script, '--client', 'claude'] },
              null,
              2,
            ),
          },
        ]
      : [],
  );

  async function copy(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    copied = label;
    setTimeout(() => (copied = null), 1500);
  }

  const SOURCE_TEXT: Record<string, string> = {
    ready: 'aktiv',
    disabled: 'deaktiviert',
    'missing-token': 'Token fehlt',
    'missing-url': 'URL fehlt',
  };
</script>

<div class="settings">
  <header>
    <button class="icon" onclick={onclose} aria-label="Zurück">←</button>
    <h2>Einstellungen</h2>
  </header>

  {#if message}
    <p class:error={message.error} class="flash">{message.text}</p>
  {/if}

  {#if settings && secrets}
    <section>
      <h3>
        GitHub <span class="muted">({SOURCE_TEXT[status?.sources.github ?? ''] ?? '…'})</span>
      </h3>
      <label class="check">
        <input
          type="checkbox"
          checked={settings.github.enabled}
          onchange={(e) => patch({ github: { enabled: e.currentTarget.checked } })}
        />
        Pull Requests abrufen
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={settings.github.includeAssigned}
          onchange={(e) => patch({ github: { includeAssigned: e.currentTarget.checked } })}
        />
        Mir zugewiesene PRs
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={settings.github.includeAuthored}
          onchange={(e) => patch({ github: { includeAuthored: e.currentTarget.checked } })}
        />
        Eigene PRs
      </label>
      <div class="inline">
        <input
          type="password"
          placeholder={secrets.githubToken ? 'Token gesetzt – neu eingeben zum Ersetzen' : 'Personal Access Token'}
          bind:value={githubToken}
          autocomplete="off"
        />
        <button onclick={saveToken} disabled={!githubToken.trim()}>Speichern</button>
        {#if secrets.githubToken}
          <button
            onclick={() => run(() => api.deleteSecret('github-token'), 'Token entfernt')}
            >Entfernen</button
          >
        {/if}
      </div>
      <p class="hint muted">
        Fine-grained Token mit Lesezugriff auf Pull Requests, oder klassisch mit <code>repo</code>.
        Wird in der Windows-Anmeldeinformationsverwaltung gespeichert.
      </p>
    </section>

    <section>
      <h3>
        Kalender <span class="muted">({SOURCE_TEXT[status?.sources.calendar ?? ''] ?? '…'})</span>
      </h3>
      <label class="check">
        <input
          type="checkbox"
          checked={settings.calendar.enabled}
          onchange={(e) => patch({ calendar: { enabled: e.currentTarget.checked } })}
        />
        Termine abrufen
      </label>
      <div class="inline" role="radiogroup" aria-label="Kalenderquelle">
        Quelle:
        <label class="check">
          <input
            type="radio"
            name="calendar-provider"
            checked={settings.calendar.provider === 'outlook'}
            onchange={() => patch({ calendar: { provider: 'outlook' } })}
          />
          Outlook
        </label>
        <label class="check">
          <input
            type="radio"
            name="calendar-provider"
            checked={settings.calendar.provider === 'ics'}
            onchange={() => patch({ calendar: { provider: 'ics' } })}
          />
          ICS-Feed
        </label>
      </div>
      {#if settings.calendar.provider === 'ics'}
        <div class="inline">
          <input
            type="password"
            placeholder={secrets.calendarIcsUrl ? 'ICS-URL gesetzt – neu eingeben zum Ersetzen' : 'ICS-Feed-URL (https:// oder webcal://)'}
            bind:value={icsUrl}
            autocomplete="off"
          />
          <button onclick={saveIcs} disabled={!icsUrl.trim()}>Speichern</button>
          {#if secrets.calendarIcsUrl}
            <button
              onclick={() => run(() => api.deleteSecret('calendar-ics-url'), 'URL entfernt')}
              >Entfernen</button
            >
          {/if}
        </div>
      {:else}
        <p class="hint muted">
          Standardkalender im klassischen Outlook, inklusive Serien. Abgesagte und abgelehnte
          Termine werden ausgelassen; ein Teams-Link wird zum Klick-Ziel.
        </p>
      {/if}
      <label class="inline">
        Tage im Voraus
        <input
          type="number"
          min="1"
          max="90"
          value={settings.calendar.lookAheadDays}
          onchange={(e) => patch({ calendar: { lookAheadDays: Number(e.currentTarget.value) } })}
        />
      </label>
    </section>

    <section>
      <h3>
        PR-Mails (Outlook) <span class="muted">({SOURCE_TEXT[status?.sources.mail ?? ''] ?? '…'})</span>
      </h3>
      <label class="check">
        <input
          type="checkbox"
          checked={settings.mail.enabled}
          onchange={(e) => patch({ mail: { enabled: e.currentTarget.checked } })}
        />
        Offene PRs aus Azure-DevOps-Benachrichtigungen übernehmen
      </label>
      <label class="inline">
        Ordner
        <input
          type="text"
          value={settings.mail.outlookFolder}
          onchange={(e) => patch({ mail: { outlookFolder: e.currentTarget.value } })}
        />
      </label>
      <label class="inline">
        Mails der letzten
        <input
          type="number"
          min="1"
          max="365"
          value={settings.mail.lookBackDays}
          onchange={(e) => patch({ mail: { lookBackDays: Number(e.currentTarget.value) } })}
        />
        Tage
      </label>
      <p class="hint muted">
        Liest den Ordner im klassischen Outlook (Pfad unter dem Postfach, z. B. „Posteingang/PR“).
        Ein PR verschwindet, sobald eine Mail „abgeschlossen“ oder „aufgegeben“ meldet.
      </p>
    </section>

    <section>
      <h3>Allgemein</h3>
      <label class="inline">
        Sync alle
        <input
          type="number"
          min="1"
          max="1440"
          value={settings.syncIntervalMinutes}
          onchange={(e) => patch({ syncIntervalMinutes: Number(e.currentTarget.value) })}
        />
        Minuten
      </label>
      <label class="check">
        <input type="checkbox" checked={autostart} onchange={toggleAutostart} />
        Mit Windows starten (im Tray)
      </label>
      {#if hotkey}<p class="muted">Ein-/Ausblenden: <kbd>{hotkey}</kbd></p>{/if}
    </section>

    {#if status?.lastRuns.length}
      <section>
        <h3>Letzte Synchronisierungen</h3>
        <ul class="runs">
          {#each status.lastRuns.slice(0, 6) as run (run.id)}
            <li>
              <span>{new Date(run.startedAt).toLocaleString('de-AT')}</span>
              <span>{run.source}</span>
              {#if run.ok}
                <span class="muted">+{run.added} ~{run.updated} ✓{run.closed}</span>
              {:else}
                <span class="error" title={run.error ?? ''}>Fehler: {run.error}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section>
      <h3>MCP für Claude &amp; Copilot</h3>
      {#if mcp?.installed}
        {#each snippets as s (s.label)}
          <div class="snippet">
            <div class="snippet-head">
              <span>{s.label}</span>
              <button class="icon" onclick={() => copy(s.label, s.text)}
                >{copied === s.label ? 'Kopiert ✓' : 'Kopieren'}</button
              >
            </div>
            <pre>{s.text}</pre>
          </div>
        {/each}
        <p class="hint muted">Kein Token in der Konfiguration nötig – es kommt aus der Anmeldeinformationsverwaltung.</p>
      {:else}
        <p class="muted">
          Entwicklungsmodus: siehe README („MCP einrichten“) für die Befehle mit dem Repo-Build.
        </p>
      {/if}
    </section>
  {:else if !message}
    <p class="muted pad">Lade …</p>
  {/if}
</div>

<style>
  .settings {
    padding-bottom: 24px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    font-size: 16px;
    margin: 0;
  }
  h3 {
    font-size: 13px;
    margin: 0 0 8px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  section {
    padding: 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .inline {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .inline input[type='password'],
  .inline input[type='text'] {
    flex: 1;
    min-width: 0;
  }
  input[type='number'] {
    width: 70px;
  }
  .hint {
    font-size: 12px;
    margin: 0;
  }
  .flash {
    margin: 8px 12px;
  }
  .runs {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 12px;
  }
  .runs li {
    display: flex;
    gap: 8px;
  }
  .runs .error {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .snippet pre {
    margin: 4px 0 0;
    padding: 8px;
    background: var(--bg-soft);
    border-radius: 6px;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .snippet-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
  }
  .pad {
    padding: 12px;
  }
</style>

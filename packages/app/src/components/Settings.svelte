<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import {
    ignoreAllOtma,
    loadOtma,
    otma,
    setOtmaEnabled,
    unignoreAllOtma,
  } from '../lib/otma.svelte';
  import type { DaemonStatus, SecretsStatus, Settings } from '../lib/types';

  /** Needs the list: loads it first if the tab has not done so yet. */
  async function ignoreAllTickets() {
    if (!otma.tickets) await loadOtma();
    ignoreAllOtma();
  }

  let {
    onclose,
    prProjects = [],
  }: {
    onclose: () => void;
    /** Projects that come from the current pull requests (removing one only hides it). */
    prProjects?: string[];
  } = $props();

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
  let tfsToken = $state('');
  let ticketUser = $state('');
  let ticketPassword = $state('');
  let message = $state<{ text: string; error: boolean } | null>(null);
  let copied = $state<string | null>(null);

  async function load() {
    [settings, secrets, status] = await Promise.all([api.settings(), api.secrets(), api.status()]);
    // Optional: needs a projects folder; summing up a large cache may take a moment.
    moduleCache = settings.workspace.projectsRoot
      ? await api.pr.moduleCache().catch(() => null)
      : null;
  }

  let moduleCache = $state<{ path: string; exists: boolean; bytes: number } | null>(null);
  let confirmingClear = $state(false);
  const formatBytes = (n: number) =>
    n >= 1024 ** 3
      ? `${(n / 1024 ** 3).toFixed(1)} GB`
      : n >= 1024 ** 2
        ? `${(n / 1024 ** 2).toFixed(0)} MB`
        : `${Math.ceil(n / 1024)} KB`;

  async function clearModuleCache() {
    confirmingClear = false;
    await run(() => api.pr.clearModuleCache(), 'Modul-Cache gelöscht');
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

  let newProject = $state('');
  const projectList = $derived(
    settings
      ? [...new Set([...prProjects, ...settings.workspace.projects])]
          .filter((p) => !settings!.workspace.hiddenProjects.includes(p))
          .sort((a, b) => a.localeCompare(b, 'de'))
      : [],
  );

  async function addProject(event: SubmitEvent) {
    event.preventDefault();
    const name = newProject.trim();
    if (!name || !settings) return;
    const ws = settings.workspace;
    await run(
      () =>
        api.updateSettings({
          workspace: {
            // A removed PR project comes back; anything else is added by hand.
            hiddenProjects: ws.hiddenProjects.filter((p) => p !== name),
            projects:
              prProjects.includes(name) || ws.projects.includes(name)
                ? ws.projects
                : [...ws.projects, name],
          },
        }),
      `Projekt „${name}“ hinzugefügt`,
    );
    newProject = '';
  }

  async function removeProject(name: string) {
    if (!settings) return;
    const ws = settings.workspace;
    await run(
      () =>
        api.updateSettings({
          workspace: {
            projects: ws.projects.filter((p) => p !== name),
            // Projects of pull requests would come back with the next sync: hide them.
            hiddenProjects: prProjects.includes(name)
              ? [...ws.hiddenProjects, name]
              : ws.hiddenProjects,
          },
        }),
      `Projekt „${name}“ entfernt`,
    );
  }

  async function saveToken() {
    await run(() => api.setSecret('github-token', githubToken.trim()), 'GitHub-Token gespeichert');
    githubToken = '';
  }

  async function saveIcs() {
    await run(() => api.setSecret('calendar-ics-url', icsUrl.trim()), 'Kalender-URL gespeichert');
    icsUrl = '';
  }

  async function saveTfsToken() {
    await run(() => api.setSecret('tfs-token', tfsToken.trim()), 'TFS-Token gespeichert');
    tfsToken = '';
  }

  /** Saves what was entered: user and/or password (each may be replaced alone). */
  async function saveTicketAccount() {
    await run(async () => {
      if (ticketUser.trim()) await api.setSecret('ticket-user', ticketUser.trim());
      if (ticketPassword) await api.setSecret('ticket-password', ticketPassword);
    }, 'BSM/OTMA-Account gespeichert');
    ticketUser = '';
    ticketPassword = '';
  }

  const removeTicketAccount = () =>
    run(
      () =>
        Promise.all([api.deleteSecret('ticket-user'), api.deleteSecret('ticket-password')]),
      'BSM/OTMA-Account entfernt',
    );

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
            text: `claude mcp add brsorganizer --scope user -- ${q(mcp.node)} ${q(mcp.script)} --client claude`,
          },
          {
            label: 'Claude Code (WSL)',
            text: `claude mcp add brsorganizer --scope user -- "$(wslpath '${mcp.node}')" '${mcp.script}' --client claude`,
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
    standby: 'Fallback, ruht – TFS ist aktiv',
  };
</script>

<div class="settings">
  <header>
    <button class="icon" onclick={onclose} aria-label="Zurück">←</button>
    <h2>Einstellungen</h2>
    {#if status}<span class="version muted" title="Installierte Version">v{status.version}</span>{/if}
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
        TFS / Azure DevOps <span class="muted">({SOURCE_TEXT[status?.sources.tfs ?? ''] ?? '…'})</span>
      </h3>
      <label class="check">
        <input
          type="checkbox"
          checked={settings.tfs.enabled}
          onchange={(e) => patch({ tfs: { enabled: e.currentTarget.checked } })}
        />
        Pull Requests abrufen
      </label>
      <label class="inline">
        Collection
        <input
          type="text"
          placeholder="https://tfs.example.com/tfs/DefaultCollection"
          value={settings.tfs.collectionUrl}
          onchange={(e) => patch({ tfs: { collectionUrl: e.currentTarget.value.trim() } })}
        />
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={settings.tfs.includeAuthored}
          onchange={(e) => patch({ tfs: { includeAuthored: e.currentTarget.checked } })}
        />
        Eigene PRs
      </label>
      <div class="inline">
        <input
          type="password"
          placeholder={secrets.tfsToken ? 'Token gesetzt – neu eingeben zum Ersetzen' : 'Personal Access Token (optional)'}
          bind:value={tfsToken}
          autocomplete="off"
        />
        <button onclick={saveTfsToken} disabled={!tfsToken.trim()}>Speichern</button>
        {#if secrets.tfsToken}
          <button onclick={() => run(() => api.deleteSecret('tfs-token'), 'Token entfernt')}
            >Entfernen</button
          >
        {/if}
      </div>
      <p class="hint muted">
        Ohne Token wird deine Windows-Anmeldung verwendet. Ein Token (Lesezugriff „Code“) braucht
        es nur außerhalb der Domäne oder für dev.azure.com. Solange TFS aktiv ist, ruht die
        Mail-Quelle.
      </p>
    </section>

    <section>
      <h3>PR-Arbeitsbereich</h3>
      <label class="inline">
        Projektordner
        <input
          type="text"
          placeholder="z. B. C:\projects-git"
          value={settings.workspace.projectsRoot}
          onchange={(e) => patch({ workspace: { projectsRoot: e.currentTarget.value.trim() } })}
        />
      </label>
      <p class="hint muted">
        Darunter liegt pro Kunde ein Ordner mit dem Repo, z. B. <code>Community\Community</code>.
        Ein PR wird über die Remote-URL dem Kundenordner zugeordnet und nach
        <code>&lt;Kunde&gt;\PR&lt;Nr&gt;</code> geklont, mit IIS-App-Pool, BORA-Referenzen, NuGet und
        Build. Leer = aus. Bei einem PR über ▸ aufklappen.
      </p>
      {#if moduleCache}
        <div class="inline">
          <span>
            Modul-Cache: {moduleCache.exists ? formatBytes(moduleCache.bytes) : 'leer'}
            <span class="muted">({moduleCache.path})</span>
          </span>
          {#if moduleCache.exists && !confirmingClear}
            <button type="button" class="cache-clear" onclick={() => (confirmingClear = true)}
              >Leeren</button
            >
          {/if}
        </div>
        {#if confirmingClear}
          <div class="confirm">
            <p class="hint">
              Löscht alle zwischengespeicherten BORA-Module (auch gepatchte). Der nächste Klon lädt
              sie neu und dauert entsprechend länger. Nicht während eines laufenden Klons.
            </p>
            <div class="inline">
              <button type="button" onclick={() => (confirmingClear = false)}>Behalten</button>
              <button type="button" class="danger" onclick={() => void clearModuleCache()}
                >Modul-Cache löschen</button
              >
            </div>
          </div>
        {/if}
      {/if}
    </section>

    <section>
      <h3>Projekte</h3>
      {#if projectList.length}
        <ul class="projects">
          {#each projectList as p (p)}
            <li>
              <span>{p}</span>
              {#if prProjects.includes(p)}<span class="muted">aus Pull Requests</span>{/if}
              <button type="button" class="remove" onclick={() => void removeProject(p)}
                >Entfernen</button
              >
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint muted">Noch keine Projekte.</p>
      {/if}
      <form class="inline" onsubmit={addProject}>
        <input type="text" placeholder="Projekt (Kundenordner), z. B. Community" bind:value={newProject} />
        <button type="submit" disabled={!newProject.trim()}>Hinzufügen</button>
      </form>
      <p class="hint muted">
        Projekte, denen Todos zugeordnet und an Claude übergeben werden. Der Name entspricht dem
        Kundenordner im Projektordner. Entfernte Projekte aus Pull Requests werden ausgeblendet.
      </p>
    </section>

    <section>
      <h3>BSM/OTMA-Account</h3>
      <div class="inline">
        <input
          type="text"
          placeholder={secrets.ticketUser ?? 'Benutzer'}
          bind:value={ticketUser}
          autocomplete="off"
        />
        <input
          type="password"
          placeholder={secrets.ticketPassword ? 'Passwort gesetzt – neu eingeben zum Ersetzen' : 'Passwort'}
          bind:value={ticketPassword}
          autocomplete="off"
        />
        <button onclick={saveTicketAccount} disabled={!ticketUser.trim() && !ticketPassword}
          >Speichern</button
        >
        {#if secrets.ticketUser || secrets.ticketPassword}
          <button onclick={removeTicketAccount}>Entfernen</button>
        {/if}
      </div>
      <p class="hint muted">
        Ein Account für BSM und OTMA. „An Agent weitergeben“ gibt ihn dem Agenten über
        Umgebungsvariablen mit, damit er die Tickets lesen kann. Gespeichert in der Windows-
        Anmeldeinformationsverwaltung.
      </p>
    </section>

    <section>
      <h3>OTMA-Tickets</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={otma.enabled}
          onchange={(e) => setOtmaEnabled(e.currentTarget.checked)}
        />
        Tab „OTMA“ anzeigen (lädt deine Tickets alle 10 Minuten)
      </label>
      <div class="inline">
        <button onclick={ignoreAllTickets} disabled={otma.loading}>Alle ignorieren</button>
        <button onclick={unignoreAllOtma} disabled={Object.keys(otma.ignored).length === 0}
          >Alle wieder anzeigen</button
        >
        <span class="muted">{Object.keys(otma.ignored).length} ignoriert</span>
      </div>
      <p class="hint muted">
        Ein ignoriertes Ticket kommt von selbst zurück, sobald sich sein Änderungsdatum ändert.
      </p>
      <h4>Zuordnung OTMA-Projekt → Projekt</h4>
      {#if Object.keys(settings.workspace.otmaProjects).length}
        <ul class="projects">
          {#each Object.entries(settings.workspace.otmaProjects) as [from, to] (from)}
            <li>
              <span>{from} <span class="muted">→</span> {to}</span>
              <button
                type="button"
                class="remove"
                onclick={() => {
                  const rest = { ...settings!.workspace.otmaProjects };
                  delete rest[from];
                  void patch({ workspace: { otmaProjects: rest } });
                }}>Entfernen</button
              >
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint muted">
          Noch keine. Wählst du beim Übernehmen eines OTMA-Tickets ein Projekt, wird es hier für
          dessen OTMA-Projekt gemerkt und künftig vorausgewählt.
        </p>
      {/if}
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
        Ein PR verschwindet, sobald eine Mail „abgeschlossen“ oder „aufgegeben“ meldet. Fallback:
        läuft nur, solange TFS nicht eingerichtet ist.
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
  .version {
    margin-left: auto;
    font-size: 11px;
  }
  h3 {
    font-size: 13px;
    margin: 0 0 8px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  h4 {
    font-size: 12px;
    margin: 12px 0 4px;
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
  .cache-clear {
    margin-left: auto;
    font-size: 12px;
    padding: 2px 8px;
  }
  button.danger {
    border-color: var(--danger);
    color: var(--danger);
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .projects {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .projects li {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .projects li .muted {
    font-size: 12px;
  }
  .projects .remove {
    margin-left: auto;
    font-size: 12px;
    padding: 2px 8px;
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

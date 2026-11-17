<script lang="ts">
  import { listen } from '@tauri-apps/api/event';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { enable, isEnabled } from '@tauri-apps/plugin-autostart';
  import { onMount } from 'svelte';
  import ItemRow from './components/ItemRow.svelte';
  import NewItemDialog from './components/NewItemDialog.svelte';
  import Settings from './components/Settings.svelte';
  import { api, subscribe } from './lib/api';
  import { groupItems, projectsOf } from './lib/group';
  import { announceNewItems, remindUpcoming } from './lib/notify';
  import { savedAlwaysOnTop, setAlwaysOnTop } from './lib/pin';
  import type {
    CloneSync,
    Item,
    NewItem,
    Settings as AppSettings,
    SourceStatus,
    UpdateInfo,
  } from './lib/types';

  let items = $state<Item[]>([]);
  let now = $state(new Date());
  let view = $state<'list' | 'settings'>('list');
  let error = $state<string | null>(null);
  let syncing = $state(false);
  let sources = $state<SourceStatus | null>(null);
  let lastSyncError = $state<string | null>(null);
  let pinned = $state(savedAlwaysOnTop());
  let creating = $state(false);
  /** Set by the "+" of a project: the new todo goes there. */
  let creatingProject = $state<string | null>(null);

  async function createItem(input: NewItem) {
    // Errors propagate to the dialog, which shows them and stays open.
    if (input.type === 'todo') {
      const todo = await api.addTodo({
        title: input.title,
        dueAt: input.dueAt,
        bsmUrl: input.bsmUrl,
        otmaUrl: input.otmaUrl,
      });
      if (input.project) await api.updateTodo(todo.id, { project: input.project });
    }
    else await api.addEvent({ title: input.title, startsAt: input.startsAt, endsAt: input.endsAt });
    await refresh();
  }

  async function togglePinned() {
    const next = !pinned;
    try {
      await setAlwaysOnTop(next);
      pinned = next;
    } catch (e) {
      error = `Immer im Vordergrund: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Settings that shape the list: projects folder and managed projects. */
  let workspace = $state<AppSettings['workspace'] | null>(null);
  const projectsRoot = $derived(workspace?.projectsRoot ?? null);
  const sections = $derived(groupItems(items, now));
  const projects = $derived(projectsOf(items, workspace ?? undefined));
  const needsSetup = $derived(
    sources !== null &&
      sources.github !== 'ready' &&
      sources.calendar !== 'ready' &&
      sources.tfs !== 'ready' &&
      sources.mail !== 'ready',
  );

  async function refresh() {
    try {
      items = await api.listItems();
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Local clone state per PR (git fetch on the daemon side, cached there for a minute). */
  let cloneSync = $state<Record<string, CloneSync>>({});
  async function refreshCloneSync(force = false) {
    try {
      cloneSync = await api.pr.cloneSync(force);
    } catch {
      // optional feature: no projects folder, daemon too old, git missing …
    }
  }

  async function refreshStatus() {
    try {
      const s = await api.status();
      sources = s.sources;
      const failed = s.lastRuns.find((r) => !r.ok && r.error);
      const latestOk = s.lastRuns.find((r) => r.ok);
      lastSyncError = failed && (!latestOk || failed.id > latestOk.id) ? `${failed.source}: ${failed.error}` : null;
      const settings = await api.settings();
      workspace = settings.workspace;
      collapsed = settings.ui.collapsed;
    } catch {
      // shown via refresh()
    }
  }

  /** Newer release on GitHub (the daemon asks at most every few hours). */
  let update = $state<UpdateInfo | null>(null);
  async function refreshUpdate() {
    update = await api.update().catch(() => null);
  }

  /** Folded sections ("section:<key>") and projects ("project:<name>"), stored in the daemon. */
  let collapsed = $state<string[]>([]);
  function toggle(key: string) {
    collapsed = collapsed.includes(key)
      ? collapsed.filter((k) => k !== key)
      : [...collapsed, key];
    api.updateSettings({ ui: { collapsed } }).catch((e: unknown) => {
      error = `Ansicht nicht gespeichert: ${e instanceof Error ? e.message : String(e)}`;
    });
  }

  /** Empty: clone/update dots cannot work; hint when there are TFS pull requests. */
  const needsWorkspace = $derived(
    projectsRoot === '' &&
      items.some((i) => i.type === 'pr' && /\/_git\/[^/]+\/pullrequest\/\d+/i.test(i.link ?? '')),
  );

  async function syncNow() {
    syncing = true;
    try {
      await api.sync();
      await Promise.all([refresh(), refreshStatus()]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      syncing = false;
    }
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    void refresh();
    void refreshStatus();
    void refreshUpdate();
    if (pinned) void setAlwaysOnTop(true).catch(() => (pinned = false));

    // Autostart is on by default for installed (release) builds; the user can turn it off in the
    // settings. Never in development: it would register the debug exe from target/.
    if (import.meta.env.PROD && !localStorage.getItem('brsorganizer.autostart-initialized')) {
      void isEnabled()
        .then((on) => (on ? undefined : enable()))
        .then(() => localStorage.setItem('brsorganizer.autostart-initialized', '1'))
        .catch(() => undefined);
    }

    const unsubscribe = subscribe(
      (event) => {
        if (event.type === 'items-changed') void refresh();
        if (event.type === 'items-added') void announceNewItems(event.data.items);
        if (event.type === 'sync-finished') {
          void refreshStatus();
          void refreshCloneSync();
        }
      },
      () => void refresh(),
    );
    void refreshCloneSync();

    const tick = setInterval(() => {
      now = new Date();
      void remindUpcoming(items, now);
    }, 30_000);
    // New commits on PR branches show up without waiting for the next sync.
    const cloneTick = setInterval(() => void refreshCloneSync(), 3 * 60_000);
    const updateTick = setInterval(() => void refreshUpdate(), 60 * 60_000);

    const unlisten = listen('tray-sync', () => void syncNow()).catch(() => () => undefined);

    return () => {
      unsubscribe();
      clearInterval(tick);
      clearInterval(cloneTick);
      clearInterval(updateTick);
      void unlisten.then((f) => f());
    };
  });
</script>

{#if view === 'settings'}
  <Settings
    prProjects={projectsOf(items)}
    onclose={() => {
      view = 'list';
      void refreshStatus();
    }}
  />
{:else}
  <header>
    <h1>Todos</h1>
    <div class="actions">
      <button
        class="icon pin"
        class:active={pinned}
        title={pinned ? 'Immer im Vordergrund: an' : 'Immer im Vordergrund'}
        aria-label="Immer im Vordergrund"
        aria-pressed={pinned}
        onclick={togglePinned}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <path
            fill="currentColor"
            d="M10.97 1.47a.75.75 0 0 1 1.06 0l2.5 2.5a.75.75 0 0 1-1.06 1.06l-.47-.47-2.6 2.6.53 2.12a.75.75 0 0 1-.2.71l-1 1a.75.75 0 0 1-1.06 0L6.5 9.81l-3.72 3.72a.75.75 0 0 1-1.06-1.06L5.44 8.75 3.28 6.59a.75.75 0 0 1 0-1.06l1-1a.75.75 0 0 1 .71-.2l2.12.53 2.6-2.6-.47-.47a.75.75 0 0 1 0-1.06l1.73-.27z"
          />
        </svg>
      </button>
      <button class="icon" title="Jetzt synchronisieren" onclick={syncNow} disabled={syncing}>
        <span class:spin={syncing}>⟳</span>
      </button>
      {#if update?.available && update.url}
        <button
          class="update"
          title="Neue Version {update.latest} herunterladen (installiert: {update.current})"
          onclick={() => update?.url && void openUrl(update.url)}>Update {update.latest}</button
        >
      {/if}
      <button class="icon" title="Einstellungen" onclick={() => (view = 'settings')}>⚙</button>
    </div>
  </header>

  <button class="fab" title="Neu (Todo oder Termin)" aria-label="Neu" onclick={() => {
      creatingProject = null;
      creating = true;
    }}>
    <!-- Drawn, not a "+" glyph: font metrics put the glyph off-center. -->
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
    </svg>
  </button>
  <NewItemDialog
    open={creating}
    project={creatingProject}
    oncreate={createItem}
    onclose={() => (creating = false)}
  />

  {#if error}
    <p class="banner error">{error}</p>
  {/if}
  {#if lastSyncError}
    <p class="banner error" title={lastSyncError}>Sync-Fehler – {lastSyncError}</p>
  {/if}
  {#if needsSetup}
    <p class="banner">
      Noch keine Quelle eingerichtet (GitHub, TFS, Kalender oder PR-Mails).
      <button class="linkish" onclick={() => (view = 'settings')}>Jetzt einrichten</button>
    </p>
  {/if}

  {#if needsWorkspace}
    <p class="banner">
      Für Klonen, Update und Build fehlt noch der Projektordner (z. B. C:\projects-git).
      <button class="linkish" onclick={() => (view = 'settings')}>Festlegen</button>
    </p>
  {/if}

  {#if sections.length === 0 && !error}
    <p class="empty muted">Glückwunsch, du bist arbeitslos 🎉</p>
  {/if}

  {#each sections as section (section.key)}
    {@const sectionOpen = !collapsed.includes(`section:${section.key}`)}
    <section>
      <h2 class:alert={section.key === 'overdue' || section.key === 'now'}>
        <button class="fold" aria-expanded={sectionOpen} onclick={() => toggle(`section:${section.key}`)}>
          <span class="chevron" class:closed={!sectionOpen} aria-hidden="true">▾</span>
          {section.title} <span class="count">{section.items.length}</span>
        </button>
      </h2>
      {#if sectionOpen && section.groups}
        {#each section.groups as group (group.customer)}
          {@const groupOpen = !collapsed.includes(`project:${group.customer}`)}
          <h3 class="customer">
            <button class="fold" aria-expanded={groupOpen} onclick={() => toggle(`project:${group.customer}`)}>
              <span class="chevron" class:closed={!groupOpen} aria-hidden="true">▾</span>
              {group.customer} <span class="count">{group.items.length}</span>
            </button>
            {#if group.customer !== 'Sonstige'}
              <button
                class="add-todo"
                title="Neues Todo in {group.customer}"
                aria-label="Neues Todo in {group.customer}"
                onclick={() => {
                  creatingProject = group.customer;
                  creating = true;
                }}>+</button
              >
            {/if}
          </h3>
          {#if groupOpen}{@render rows(group.items)}{/if}
        {/each}
      {:else if sectionOpen}
        {@render rows(section.items)}
      {/if}
    </section>
  {/each}
{/if}

{#snippet rows(list: Item[])}
  <ul>
    {#each list as item (item.id)}
      <ItemRow
        {item}
        {now}
        oncomplete={(i) => act(() => (i.status === 'done' ? api.reopen(i.id) : api.complete(i.id)))}
        onarchive={(i) => act(() => api.archive(i.id))}
        onchanged={() => {
          void refresh();
          void refreshCloneSync(true);
        }}
        sync={cloneSync[item.id]}
        {projects}
      />
    {/each}
  </ul>
{/snippet}

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 1;
  }
  h1 {
    font-size: 16px;
    margin: 0;
  }
  .fab {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 2;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    border: none;
    padding: 0;
    background: var(--accent);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    transition:
      transform 0.12s,
      box-shadow 0.12s;
  }
  .fab:hover {
    transform: scale(1.06);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  }
  .fab:focus-visible {
    outline: 2px solid var(--fg);
    outline-offset: 2px;
  }
  /* Keep the last row reachable above the button. */
  :global(body) {
    padding-bottom: 84px;
  }
  .pin {
    display: inline-flex;
    align-items: center;
    transform: rotate(45deg);
    transition: transform 0.15s;
  }
  .pin.active {
    color: var(--accent);
    transform: none;
  }
  h3.customer {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    margin: 0;
    padding: 8px 12px 2px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .add-todo {
    margin-left: auto;
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 6px;
    font-size: 16px;
    line-height: 1;
    color: var(--accent);
    background: transparent;
    border: 1px solid transparent;
  }
  .add-todo:hover {
    border-color: var(--accent);
  }
  .actions {
    display: flex;
    gap: 2px;
  }
  /* Shown only when GitHub has a newer release: small, but not to be missed. */
  .update {
    align-self: center;
    margin-right: 4px;
    padding: 2px 8px;
    font-size: 11px;
    border-radius: 10px;
    border: 1px solid var(--accent);
    color: var(--accent);
    background: transparent;
  }
  .actions .icon {
    font-size: 16px;
  }
  section h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0;
    padding: 12px 12px 4px;
  }
  section h2.alert {
    color: var(--danger);
  }
  .count {
    font-weight: normal;
  }
  /* Section and project headings fold their list; the heading keeps its own look. */
  .fold {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .fold:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .chevron {
    display: inline-block;
    width: 10px;
    transition: transform 0.12s;
  }
  .chevron.closed {
    transform: rotate(-90deg);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .banner {
    margin: 8px 12px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--bg-soft);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .linkish {
    all: unset;
    cursor: pointer;
    color: var(--accent);
    text-decoration: underline;
  }
  .empty {
    text-align: center;
    padding: 48px 12px;
  }
  .spin {
    display: inline-block;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>

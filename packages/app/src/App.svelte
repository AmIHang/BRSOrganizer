<script lang="ts">
  import { listen } from '@tauri-apps/api/event';
  import { enable, isEnabled } from '@tauri-apps/plugin-autostart';
  import { onMount } from 'svelte';
  import AddTodo from './components/AddTodo.svelte';
  import ItemRow from './components/ItemRow.svelte';
  import Settings from './components/Settings.svelte';
  import { api, subscribe } from './lib/api';
  import { groupItems } from './lib/group';
  import { announceNewItems, remindUpcoming } from './lib/notify';
  import type { Item, SourceStatus } from './lib/types';

  let items = $state<Item[]>([]);
  let now = $state(new Date());
  let view = $state<'list' | 'settings'>('list');
  let error = $state<string | null>(null);
  let syncing = $state(false);
  let sources = $state<SourceStatus | null>(null);
  let lastSyncError = $state<string | null>(null);

  const sections = $derived(groupItems(items, now));
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

  async function refreshStatus() {
    try {
      const s = await api.status();
      sources = s.sources;
      const failed = s.lastRuns.find((r) => !r.ok && r.error);
      const latestOk = s.lastRuns.find((r) => r.ok);
      lastSyncError = failed && (!latestOk || failed.id > latestOk.id) ? `${failed.source}: ${failed.error}` : null;
    } catch {
      // shown via refresh()
    }
  }

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

    // Autostart is on by default for installed (release) builds; the user can turn it off in the
    // settings. Never in development: it would register the debug exe from target/.
    if (import.meta.env.PROD && !localStorage.getItem('amineeded.autostart-initialized')) {
      void isEnabled()
        .then((on) => (on ? undefined : enable()))
        .then(() => localStorage.setItem('amineeded.autostart-initialized', '1'))
        .catch(() => undefined);
    }

    const unsubscribe = subscribe(
      (event) => {
        if (event.type === 'items-changed') void refresh();
        if (event.type === 'items-added') void announceNewItems(event.data.items);
        if (event.type === 'sync-finished') void refreshStatus();
      },
      () => void refresh(),
    );

    const tick = setInterval(() => {
      now = new Date();
      void remindUpcoming(items, now);
    }, 30_000);

    const unlisten = listen('tray-sync', () => void syncNow()).catch(() => () => undefined);

    return () => {
      unsubscribe();
      clearInterval(tick);
      void unlisten.then((f) => f());
    };
  });
</script>

{#if view === 'settings'}
  <Settings
    onclose={() => {
      view = 'list';
      void refreshStatus();
    }}
  />
{:else}
  <header>
    <h1>Todos</h1>
    <div class="actions">
      <button class="icon" title="Jetzt synchronisieren" onclick={syncNow} disabled={syncing}>
        <span class:spin={syncing}>⟳</span>
      </button>
      <button class="icon" title="Einstellungen" onclick={() => (view = 'settings')}>⚙</button>
    </div>
  </header>

  <AddTodo
    onadd={async (title, dueAt) => {
      await act(() => api.addTodo({ title, dueAt }));
    }}
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

  {#if sections.length === 0 && !error}
    <p class="empty muted">Gerade wirst du nirgends gebraucht. 🎉</p>
  {/if}

  {#each sections as section (section.key)}
    <section>
      <h2 class:alert={section.key === 'overdue' || section.key === 'now'}>
        {section.title} <span class="count">{section.items.length}</span>
      </h2>
      <ul>
        {#each section.items as item (item.id)}
          <ItemRow
            {item}
            {now}
            oncomplete={(i) => act(() => (i.status === 'done' ? api.reopen(i.id) : api.complete(i.id)))}
            onarchive={(i) => act(() => api.archive(i.id))}
          />
        {/each}
      </ul>
    </section>
  {/each}
{/if}

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
  .actions {
    display: flex;
    gap: 2px;
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

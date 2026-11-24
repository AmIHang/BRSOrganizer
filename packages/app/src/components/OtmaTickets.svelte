<script lang="ts">
  import { openUrl } from '../lib/system';
  import { onMount } from 'svelte';
  import {
    ignoreOtma,
    loadOtma,
    otma,
    setOtmaVisible,
    unignoreOtma,
    type ProjectMaps,
  } from '../lib/otma.svelte';
  import type { Item, OtmaTicket } from '../lib/types';
  import OtmaTodoDialog from './OtmaTodoDialog.svelte';

  let {
    items,
    projects,
    mapping,
    onchanged,
  }: {
    /** Open items: a ticket that already has a todo shows it instead of "→ Todo". */
    items: Item[];
    projects: string[];
    mapping: ProjectMaps;
    onchanged: () => void;
  } = $props();

  const withTodo = $derived(
    new Set(items.filter((i) => i.type === 'todo' && i.otmaUrl).map((i) => i.otmaUrl)),
  );
  let takingOver = $state<OtmaTicket | null>(null);

  const tickets = $derived(otma.tickets);
  const loading = $derived(otma.loading);
  const error = $derived(otma.error);

  export const reload = () => loadOtma();

  let showIgnored = $state(false);
  const ignoredCount = $derived((tickets ?? []).filter((t) => t.key in otma.ignored).length);

  onMount(() => {
    setOtmaVisible(true);
    void reload();
    return () => setOtmaVisible(false);
  });

  let query = $state('');
  // Number ("178333", "#178333") or a piece of the title (e.g. the BSM key).
  const shown = $derived.by(() => {
    const q = query.trim().replace(/^#(?=\d)/, '').toLowerCase();
    return (tickets ?? []).filter(
      (t) =>
        (showIgnored || !(t.key in otma.ignored)) &&
        (!q || t.key.includes(q) || t.title.toLowerCase().includes(q)),
    );
  });

  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' }) : '';
</script>

{#if error}
  <p class="banner error">{error}</p>
{/if}
{#if tickets === null}
  <p class="empty muted">{loading ? 'Lade OTMA-Tickets … (evtl. öffnet sich die Anmeldung)' : ''}</p>
{:else if tickets.length === 0}
  <p class="empty muted">Keine offenen OTMA-Tickets.</p>
{:else}
  <div class="filters">
    <input
      class="search"
      type="text"
      placeholder="OTMA-Nummer suchen …"
      aria-label="OTMA-Nummer suchen"
      bind:value={query}
    />
    <label class="muted" title="Ignorierte Tickets ebenfalls anzeigen">
      <input type="checkbox" bind:checked={showIgnored} />
      Ignorierte ({ignoredCount})
    </label>
  </div>
  {#if shown.length === 0}
    <p class="empty muted">
      {query.trim() ? `Kein Ticket mit „${query.trim()}“ in deiner Liste.` : 'Alle Tickets ignoriert.'}
    </p>
  {/if}
  <ul>
    {#each shown as t (t.key)}
      {@const ignored = t.key in otma.ignored}
      <li class:new={otma.highlighted.includes(t.key)} class:ignored>
        <button class="row" title="In OTMA öffnen: {t.url}" onclick={() => void openUrl(t.url)}>
          <span class="title">{#if otma.highlighted.includes(t.key)}<span class="badge">Neu</span>{/if}{t.title}</span>
          <span class="meta muted">
            <span class="chip otma">OTMA {t.key}</span> {t.status}{t.project ? ` · ${t.project}` : ''}{t.responsible
              ? ` · ${t.responsible}`
              : ''}{t.changedAt ? ` · ${date(t.changedAt)}` : ''}
          </span>
        </button>
        {#if withTodo.has(t.url)}
          <span class="has-todo muted" title="Für dieses Ticket gibt es schon ein offenes Todo">✓ Todo</span>
        {:else}
          <button
            class="ignore take"
            title="Als Todo übernehmen (Projekt wählen, optional an Claude übergeben)"
            aria-label="{t.key} als Todo übernehmen"
            onclick={() => (takingOver = t)}>→ Todo</button
          >
        {/if}
        <button
          class="ignore"
          title={ignored
            ? 'Wieder anzeigen'
            : 'Ignorieren (bis sich das Ticket ändert)'}
          aria-label={ignored ? `${t.key} wieder anzeigen` : `${t.key} ignorieren`}
          onclick={() => (ignored ? unignoreOtma(t.key) : ignoreOtma(t))}>{ignored ? '↺' : '⊘'}</button
        >
      </li>
    {/each}
  </ul>
{/if}

{#if takingOver}
  <OtmaTodoDialog
    ticket={takingOver}
    {projects}
    {mapping}
    {items}
    onclose={() => (takingOver = null)}
    oncreated={onchanged}
  />
{/if}

<style>
  .filters {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 12px;
  }
  .search {
    box-sizing: border-box;
    flex: 1;
    min-width: 0;
  }
  .filters label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    white-space: nowrap;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
    padding: 8px 12px;
  }
  li {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }
  li.ignored {
    opacity: 0.55;
  }
  .ignore {
    all: unset;
    cursor: pointer;
    padding: 4px 10px;
    font-size: 15px;
    color: var(--muted);
  }
  .take,
  .has-todo {
    padding: 4px 6px;
    font-size: 12px;
    white-space: nowrap;
  }
  .ignore:hover {
    color: var(--fg);
  }
  .ignore:focus-visible {
    outline: 2px solid var(--accent);
  }
  .row:hover {
    background: var(--bg-soft);
  }
  /* New since the tab was last opened. */
  li.new {
    border-left: 3px solid var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }
  li.new .row {
    padding-left: 9px;
  }
  .badge {
    display: inline-block;
    margin-right: 6px;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    vertical-align: 1px;
    color: #fff;
    background: var(--danger);
  }
  .row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .title {
    font-size: 13px;
  }
  .meta {
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Same chip as the OTMA ticket on a todo (ItemRow). */
  .chip.otma {
    border-radius: 10px;
    padding: 0 7px;
    margin-right: 2px;
    background: var(--chip-pink-bg);
    color: var(--chip-pink-fg);
  }
  .banner {
    margin: 8px 12px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--bg-soft);
    font-size: 13px;
  }
  .empty {
    text-align: center;
    padding: 48px 12px;
  }
</style>

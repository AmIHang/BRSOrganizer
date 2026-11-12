<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { formatWhen, whenOf } from '../lib/group';
  import type { Item } from '../lib/types';

  let {
    item,
    now,
    oncomplete,
    onarchive,
  }: {
    item: Item;
    now: Date;
    oncomplete: (item: Item) => void;
    onarchive: (item: Item) => void;
  } = $props();

  const REASON_LABELS: Record<string, string> = {
    'review-requested': 'Review',
    assigned: 'zugewiesen',
    authored: 'eigener PR',
  };

  const when = $derived(whenOf(item));
  const allDay = $derived(item.meta?.allDay === true);
  const overdue = $derived(item.type === 'todo' && when !== null && when < now);
  const reasons = $derived(
    Array.isArray(item.meta?.reasons) ? (item.meta.reasons as string[]) : [],
  );
  const prRef = $derived(
    item.type === 'pr' && item.meta?.repo
      ? `${String(item.meta.repo)}#${String(item.meta.number ?? '')}`
      : null,
  );
  const location = $derived(typeof item.meta?.location === 'string' ? item.meta.location : null);
  const byAssistant = $derived(item.createdBy === 'claude' || item.createdBy === 'copilot');

  function open() {
    if (item.link) void openUrl(item.link);
  }
</script>

<li class="row" class:done={item.status !== 'open'}>
  {#if item.type === 'todo'}
    <input
      type="checkbox"
      title="Erledigt"
      checked={item.status === 'done'}
      onchange={() => oncomplete(item)}
    />
  {:else}
    <span class="kind" title={item.type === 'pr' ? 'Pull Request' : 'Termin'}>
      {item.type === 'pr' ? '⇄' : '◷'}
    </span>
  {/if}

  <div class="body">
    <div class="title">
      {#if item.link}
        <button class="link" onclick={open} title={item.link}>{item.title}</button>
      {:else}
        {item.title}
      {/if}
    </div>
    <div class="meta">
      {#if when}
        <span class:overdue>{formatWhen(when, now, allDay)}</span>
      {/if}
      {#if prRef}<span>{prRef}</span>{/if}
      {#each reasons as r (r)}
        <span class="chip" class:strong={r === 'review-requested'}>{REASON_LABELS[r] ?? r}</span>
      {/each}
      {#if item.meta?.draft === true}<span class="chip">Entwurf</span>{/if}
      {#if location}<span>{location}</span>{/if}
      {#if byAssistant}<span class="chip">von {item.createdBy}</span>{/if}
    </div>
    {#if item.notes && item.type === 'todo'}
      <div class="notes">{item.notes}</div>
    {/if}
  </div>

  <button class="icon" title="Archivieren" aria-label="Archivieren" onclick={() => onarchive(item)}
    >✕</button
  >
</li>

<style>
  .row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .row:hover {
    background: var(--bg-soft);
  }
  .row .icon {
    visibility: hidden;
  }
  .row:hover .icon,
  .row .icon:focus-visible {
    visibility: visible;
  }
  .done .title {
    text-decoration: line-through;
    color: var(--muted);
  }
  input[type='checkbox'] {
    margin-top: 3px;
    width: 16px;
    height: 16px;
  }
  .kind {
    width: 16px;
    text-align: center;
    color: var(--muted);
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .title {
    overflow-wrap: anywhere;
  }
  .link {
    all: unset;
    cursor: pointer;
  }
  .link:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    margin-top: 2px;
  }
  .chip {
    background: var(--chip);
    border-radius: 10px;
    padding: 0 7px;
  }
  .chip.strong {
    background: var(--accent);
    color: #fff;
  }
  .overdue {
    color: var(--danger);
    font-weight: 600;
  }
  .notes {
    font-size: 12px;
    color: var(--muted);
    white-space: pre-wrap;
    margin-top: 2px;
  }
</style>

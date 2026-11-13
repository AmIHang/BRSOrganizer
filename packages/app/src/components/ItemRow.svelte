<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { api } from '../lib/api';
  import { formatWhen, whenOf } from '../lib/group';
  import type { CloneSync, Item, MenuEntry } from '../lib/types';
  import MergeDialog from './MergeDialog.svelte';
  import PrPanel from './PrPanel.svelte';
  import RowMenu from './RowMenu.svelte';

  let {
    item,
    now,
    oncomplete,
    onarchive,
    onchanged,
    sync,
  }: {
    item: Item;
    now: Date;
    oncomplete: (item: Item) => void;
    onarchive: (item: Item) => void;
    /** Local clone state (PRs only). */
    sync?: CloneSync;
    /** Something changed outside the list (e.g. a PR was merged): refresh. */
    onchanged?: () => void;
  } = $props();

  const REASON_LABELS: Record<string, string> = {
    'review-requested': 'Review',
    assigned: 'zugewiesen',
    authored: 'eigener PR',
    notified: 'Info',
    reviewed: 'abgestimmt',
  };
  const VOTE_LABELS: Record<string, string> = {
    approved: 'genehmigt',
    'approved-with-suggestions': 'genehmigt mit Vorschlägen',
    'waiting-for-author': 'wartet auf Autor',
    rejected: 'abgelehnt',
  };
  const vote = $derived(
    typeof item.meta?.myVote === 'string' ? (VOTE_LABELS[item.meta.myVote] ?? null) : null,
  );

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

  /** Azure DevOps / TFS pull requests get the PR-Manager actions. */
  const manageable = $derived(
    item.type === 'pr' && !!item.link && /\/_git\/[^/]+\/pullrequest\/\d+/i.test(item.link),
  );
  let expanded = $state(false);
  let merging = $state(false);
  let notice = $state<{ text: string; error: boolean } | null>(null);

  function flash(text: string, error = false) {
    notice = { text, error };
    setTimeout(() => (notice = null), error ? 8000 : 5000);
  }

  async function updateAndBuild() {
    try {
      await api.pr.cloneOrUpdate(item.id);
      flash(
        sync?.cloned
          ? 'Update + Build läuft im PowerShell-Fenster.'
          : 'Klonen + Build läuft im PowerShell-Fenster (UAC für den IIS bestätigen).',
      );
      onchanged?.();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  }

  const entries = $derived<MenuEntry[]>([
    ...(manageable
      ? [
          {
            label: sync?.cloned ? 'Update + Build' : 'Klonen + Build',
            onclick: () => void updateAndBuild(),
            disabled: sync?.remoteGone === true,
          },
          { label: 'Accept & Merge', onclick: () => (merging = true) },
          { label: expanded ? 'Details ausblenden' : 'Details', onclick: () => (expanded = !expanded) },
        ]
      : []),
    { label: 'Archivieren', onclick: () => onarchive(item) },
  ]);
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
        <span
          class="chip"
          class:strong={r === 'review-requested'}
          class:authored={r === 'authored'}>{REASON_LABELS[r] ?? r}</span
        >
      {/each}
      {#if vote}<span class="chip">{vote}</span>{/if}
      {#if item.meta?.draft === true}<span class="chip draft">Entwurf</span>{/if}
      {#if sync?.behind}
        <span
          class="chip behind"
          title="Auf dem Server gibt es {sync.behind} Commit(s), die dein lokaler Klon noch nicht hat. Update + Build holt sie."
          >↓ {sync.behind} neu</span
        >
      {:else if sync?.remoteGone}
        <span class="chip gone" title="Der Branch existiert auf dem Server nicht mehr.">Branch weg</span>
      {:else if sync?.cloned}
        <span class="chip local" title="Lokal geklont und aktuell.">lokal</span>
      {/if}
      {#if location}<span>{location}</span>{/if}
      {#if byAssistant}<span class="chip">von {item.createdBy}</span>{/if}
    </div>
    {#if item.notes && item.type === 'todo'}
      <div class="notes">{item.notes}</div>
    {/if}
    {#if notice}<div class="notice" class:error={notice.error}>{notice.text}</div>{/if}
    {#if expanded}
      <PrPanel {item} onchanged={() => onchanged?.()} />
    {/if}
  </div>

  <RowMenu {entries} />
</li>

{#if merging}
  <MergeDialog
    {item}
    cloned={sync?.cloned === true}
    onclose={() => (merging = false)}
    ondone={() => onchanged?.()}
  />
{/if}

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
  .chip.behind {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-fg);
    font-weight: 600;
  }
  .chip.gone {
    background: var(--chip);
    color: var(--danger);
  }
  .chip.local {
    background: transparent;
    border: 1px solid var(--border);
  }
  .notice {
    margin-top: 4px;
    font-size: 12px;
    color: var(--ok);
  }
  .notice.error {
    color: var(--danger);
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
  .chip.authored {
    background: var(--chip-purple-bg);
    color: var(--chip-purple-fg);
  }
  .chip.draft {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-fg);
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

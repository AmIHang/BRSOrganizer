<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { api } from '../lib/api';
  import { formatWhen, whenOf } from '../lib/group';
  import type { CloneSync, Item, MenuEntry } from '../lib/types';
  import MergeDialog from './MergeDialog.svelte';
  import PrPanel from './PrPanel.svelte';
  import ProjectDialog from './ProjectDialog.svelte';
  import RowMenu from './RowMenu.svelte';
  import TicketDialog from './TicketDialog.svelte';
  import { ticketLabel } from '../lib/tickets';

  let {
    item,
    now,
    oncomplete,
    onarchive,
    onchanged,
    sync,
    projects = [],
  }: {
    item: Item;
    now: Date;
    oncomplete: (item: Item) => void;
    onarchive: (item: Item) => void;
    /** Local clone state (PRs only). */
    sync?: CloneSync;
    /** Something changed outside the list (e.g. a PR was merged): refresh. */
    onchanged?: () => void;
    /** Projects a todo can be moved into (same as the PR groups). */
    projects?: string[];
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

  /** Prevents double clicks starting two script windows. */
  let starting = $state(false);

  async function updateAndBuild() {
    if (starting) return;
    starting = true;
    setTimeout(() => (starting = false), 5000);
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

  async function handOff() {
    if (starting) return;
    starting = true;
    setTimeout(() => (starting = false), 5000);
    try {
      const r = await api.pr.handOffTodo(item.id);
      flash(`Agent läuft im PowerShell-Fenster (${r.branch}).`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function openSolution() {
    try {
      await api.pr.open(item.id, 'solution');
      flash('Solution wird in Visual Studio geöffnet.');
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
          ...(sync?.cloned ? [{ label: 'Solution öffnen', onclick: () => void openSolution() }] : []),
          { label: 'Accept & Merge', onclick: () => (merging = true) },
          { label: expanded ? 'Details ausblenden' : 'Details', onclick: () => (expanded = !expanded) },
        ]
      : []),
    ...(item.type === 'todo' || item.type === 'pr'
      ? [{ label: 'Tickets …', onclick: () => (editingTickets = true) }]
      : []),
    ...(item.type === 'todo'
      ? [{ label: 'In Projekt verschieben …', onclick: () => (movingProject = true) }]
      : []),
    ...(item.type === 'todo' && typeof item.meta?.project === 'string'
      ? [{ label: 'An Agent weitergeben', onclick: () => void handOff(), disabled: starting }]
      : []),
    { label: 'Archivieren', onclick: () => onarchive(item) },
  ]);
  let editingTickets = $state(false);
  let movingProject = $state(false);
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
    <div class="lead">
      <span class="kind" title={item.type === 'pr' ? 'Pull Request' : 'Termin'}>
        {item.type === 'pr' ? '⇄' : '◷'}
      </span>
      {#if manageable && sync}
        {#if !sync.cloned}
          <button
            class="dot clone"
            disabled={starting}
            aria-label="Clone + Build"
            title="Noch nicht geklont – klicken: Clone + Build ({item.meta?.project ?? 'Kunde'}\PR{item.meta?.number ?? ''}, IIS, Referenzen, NuGet, Build)"
            onclick={updateAndBuild}
          ></button>
        {:else if sync.behind}
          <button
            class="dot update"
            disabled={starting}
            aria-label="Update + Build"
            title="{sync.behind} neue(r) Commit(s) auf dem Server – klicken: Update + Build"
            onclick={updateAndBuild}
          ></button>
        {:else if sync.remoteGone}
          <span class="dot gone" title="Branch existiert auf dem Server nicht mehr"></span>
        {:else}
          <button
            class="dot ok"
            aria-label="Solution öffnen"
            title="Lokal geklont und aktuell – klicken: Solution öffnen"
            onclick={openSolution}
          ></button>
        {/if}
      {/if}
    </div>
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
      {#if item.bsmUrl}
        <button
          class="chip ticket bsm"
          title="BSM-Ticket öffnen: {item.bsmUrl}"
          onclick={() => item.bsmUrl && openUrl(item.bsmUrl)}>{ticketLabel(item.bsmUrl)}</button
        >
      {/if}
      {#if item.otmaUrl}
        <button
          class="chip ticket otma"
          title="OTMA-Ticket öffnen: {item.otmaUrl}"
          onclick={() => item.otmaUrl && openUrl(item.otmaUrl)}>OTMA {ticketLabel(item.otmaUrl)}</button
        >
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

{#if editingTickets}
  <TicketDialog
    {item}
    onclose={() => {
      editingTickets = false;
      onchanged?.();
    }}
  />
{/if}

{#if movingProject}
  <ProjectDialog
    {item}
    {projects}
    onclose={() => {
      movingProject = false;
      onchanged?.();
    }}
  />
{/if}

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
  .chip.ticket {
    border: none;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .chip.ticket.bsm {
    background: var(--chip-teal-bg);
    color: var(--chip-teal-fg);
  }
  .chip.ticket.otma {
    background: var(--chip-pink-bg);
    color: var(--chip-pink-fg);
  }
  .chip.ticket:hover {
    filter: brightness(1.1);
    text-decoration: underline;
  }
  /* Left column: type icon, below it the local-clone status dot (PRs only). */
  .lead {
    width: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .dot {
    display: block;
    width: 12px;
    height: 12px;
    padding: 0;
    border-radius: 50%;
    border: none;
  }
  button.dot {
    cursor: pointer;
    transition: transform 0.12s;
  }
  button.dot:hover:not(:disabled) {
    transform: scale(1.3);
  }
  button.dot:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* not cloned: ring in the accent color */
  .dot.clone {
    background: transparent;
    border: 2px solid var(--accent);
  }
  /* All dots share the 12px size; the ring's border is drawn inside it (border-box). */
  /* server has new commits: filled orange */
  .dot.update {
    background: var(--chip-orange-bg);
  }
  /* cloned and up to date: green (click opens the solution) */
  .dot.ok {
    background: var(--ok);
  }
  .dot.gone {
    background: var(--muted);
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
    line-height: 1.4;
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

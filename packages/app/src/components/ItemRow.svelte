<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { api } from '../lib/api';
  import { formatWhen, whenOf } from '../lib/group';
  import type { CloneSync, Item, MenuEntry } from '../lib/types';
  import MergeDialog from './MergeDialog.svelte';
  import PrPanel from './PrPanel.svelte';
  import ProjectDialog from './ProjectDialog.svelte';
  import ReplyDialog from './ReplyDialog.svelte';
  import RowMenu from './RowMenu.svelte';
  import TicketDialog from './TicketDialog.svelte';
  import type { ProjectMaps } from '../lib/otma.svelte';
  import { ticketLabel } from '../lib/tickets';
  import { handOffs, startHandOff } from '../lib/handoff.svelte';

  let {
    item,
    now,
    oncomplete,
    onarchive,
    onchanged,
    sync,
    projects = [],
    otmaMapping = { otmaProjects: {}, bsmProjects: {} },
    held = false,
    ontogglehold,
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
    /** BSM customer / OTMA project → project, for linking tickets. */
    otmaMapping?: ProjectMaps;
    /** On hold: greyed out and compact (sorted last by the list). */
    held?: boolean;
    ontogglehold?: () => void;
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

  async function copyPrNumber() {
    const number = String(item.meta?.number ?? '');
    try {
      await navigator.clipboard.writeText(number);
    } catch (e) {
      flash(`Kopieren fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`, true);
    }
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

  /** The hand-off reads the BSM ticket first (Edge may open for the BSM login). */
  const handOff = $derived(handOffs[item.id]);
  const handingOff = $derived(handOff?.running === true);
  const shownNotice = $derived(handOff ?? notice);

  /** "http://localhost/BM.Web-PR4373/" → "/BM.Web-PR4373/" (host is always the local IIS). */
  function webPath(url: string): string {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }

  /** IIS web apps of the clone; with several, a pick list opens instead of every tab at once. */
  const webUrls = $derived(sync?.webUrls ?? []);
  const webEntries = $derived<MenuEntry[]>(
    webUrls.map((url) => ({ label: webPath(url), title: url, onclick: () => void openUrl(url) })),
  );

  async function openSolution() {
    try {
      await api.pr.open(item.id, 'solution');
      flash('Solution wird in Visual Studio geöffnet.');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** Handed to a background agent: no checkbox, no second hand-off, can be cancelled. */
  const handedOff = $derived(
    item.type === 'todo' && item.status === 'open' && typeof item.meta?.agentBranch === 'string',
  );
  /** The session is gone without a PR: the todo is the user's again. */
  const agentEnded = $derived(handedOff && item.meta?.agentEnded === true);
  const agentWorking = $derived(handedOff && !agentEnded);
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
    ...(agentWorking
      ? [{ label: 'An Claude abbrechen', onclick: () => void cancelHandOff() }]
      : []),
    ...(item.type === 'todo' && typeof item.meta?.agentWorktree === 'string' && !agentWorking
      ? [{ label: 'Worktree entfernen', onclick: () => void removeWorktree() }]
      : []),
    ...((item.type === 'pr' || item.type === 'todo') && item.status === 'open' && ontogglehold
      ? [{ label: held ? 'On hold aufheben' : 'On hold', onclick: ontogglehold }]
      : []),
    { label: 'Archivieren', onclick: () => onarchive(item) },
  ]);
  /** Open todos with something to work on (ticket or description) can go to a Claude agent. */
  // Not while the worktree of an ended hand-off still exists: resume it or remove it first.
  const canHandOff = $derived(
    item.type === 'todo' &&
      item.status === 'open' &&
      !agentWorking &&
      !(agentEnded && typeof item.meta?.agentWorktree === 'string'),
  );
  /** "An Claude" first asks for the project the agent works in. */
  let pickingHandOffProject = $state(false);
  /** Background agent: works until the PR shows up, or answers and waits for the user. */
  const agentReply = $derived(
    item.status === 'open' && typeof item.meta?.agentReply === 'string',
  );
  /** Stuck mid-turn on a question or permission prompt (from `claude agents`). */
  const agentWaiting = $derived(
    agentWorking && typeof item.meta?.agentWaiting === 'string' ? item.meta.agentWaiting : null,
  );
  const agentSession = $derived(`Todo-${item.id.slice(-6).toLowerCase()}`);

  async function openSession() {
    try {
      await api.pr.attachAgent(item.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function openPrSession() {
    if (starting) return;
    starting = true;
    setTimeout(() => (starting = false), 5000);
    try {
      const r = await api.pr.claudeSession(item.id);
      flash(
        r.started
          ? `Neue Claude-Sitzung ${r.session} startet im Terminal.`
          : `Claude-Sitzung ${r.session} wird im Terminal geöffnet.`,
      );
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function removeWorktree() {
    try {
      const r = await api.pr.removeAgentWorktree(item.id);
      const branch = r.branch
        ? r.branchDeleted
          ? `, Branch ${r.branch} gelöscht`
          : `, Branch ${r.branch} bleibt (nicht gemergt)`
        : '';
      flash(`Worktree entfernt${branch}.`);
      onchanged?.();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function cancelHandOff() {
    try {
      await api.pr.cancelHandOff(item.id);
      onchanged?.();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  }
  let showingReply = $state(false);
  let editingTickets = $state(false);
  let movingProject = $state(false);
</script>

<li class="row" class:done={item.status !== 'open'} class:held>
  {#if handedOff}
    <!-- Handed to Claude: done when its PR shows up (or after "An Claude abbrechen"); grey while paused. -->
    <div class="lead">
      <span
        class="kind agent"
        class:paused={agentEnded}
        title={agentEnded ? 'An Claude übergeben – Claude pausiert' : 'An Claude übergeben'}
        aria-label={agentEnded ? 'An Claude übergeben, Claude pausiert' : 'An Claude übergeben'}>✦</span
      >
    </div>
  {:else if item.type === 'todo'}
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
      <!-- Web app: under the PR icon (not on hold: the row stays one line high). -->
      {#if webUrls.length && !held}
        <RowMenu
          entries={webEntries}
          title={webUrls.length === 1 ? `Web-App öffnen: ${webUrls[0]}` : `Web-App wählen (${webUrls.length})`}
          align="left"
          dot
        />
      {/if}
    </div>
  {/if}

  <div class="body">
    <!-- Clone/update dot before the title, as its own column: wrapped title lines stay aligned with the text. -->
    <div class="title" class:with-dot={!!(manageable && sync)}>
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
      <span class="title-text">
        {#if item.link}
          <button class="link" onclick={open} title={item.link}>{item.title}</button>
        {:else}
          {item.title}
        {/if}
      </span>
    </div>
    <div class="meta">
      {#if held}
        <button class="chip hold" title="On hold – klicken zum Aufheben" onclick={ontogglehold}>On hold</button>
      {/if}
      {#if when}
        <span class:overdue>{formatWhen(when, now, allDay)}</span>
      {/if}
      {#if prRef}
        <button class="pr-ref" onclick={() => void copyPrNumber()}>{prRef}</button>
      {/if}
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
      {#if manageable && item.status === 'open'}
        <button
          class="chip action claude"
          disabled={starting}
          title="Claude-Sitzung zu diesem PR im Terminal öffnen bzw. fortsetzen; gibt es keine (auch nicht vom Todo, aus dem der PR entstand), startet eine neue im PR-Ordner"
          onclick={() => void openPrSession()}>Claude</button
        >
      {/if}
      {#if canHandOff}
        <button
          class="chip action claude"
          disabled={handingOff}
          title="Todo an einen Claude-Agenten übergeben (eigener Branch, läuft im Hintergrund); BSM- und OTMA-Ticket werden vorher gelesen"
          onclick={() => (pickingHandOffProject = true)}
          >{handingOff ? 'An Claude …' : 'An Claude'}</button
        >
      {/if}
      {#if agentWaiting}
        <button
          class="chip status asking"
          title="Claude wartet auf: {agentWaiting}. Klick öffnet die Sitzung ({agentSession}) im Terminal."
          onclick={() => void openSession()}>Rückfrage von Claude</button
        >
      {:else if agentEnded}
        <!-- Before "Claude wartet": an earlier answer must not hide that the session is gone
             (e.g. after a restart). Attaching resumes it; the daemon then sees it running again. -->
        <button
          class="chip status ended"
          title="Die Sitzung des Agenten läuft nicht mehr (z. B. nach einem Neustart), ohne Pull Request. Klick setzt sie im Terminal fort ({agentSession})."
          onclick={() => void openSession()}>Claude pausiert</button
        >
      {:else if agentReply}
        <span class="chip status claude" title="Der Agent hat seine Runde beendet und wartet auf dich"
          >Claude wartet</span
        >
      {:else if agentWorking}
        <button
          class="chip working"
          title="Ein Claude-Agent arbeitet im Hintergrund an diesem Todo. Klick öffnet die Sitzung im Terminal."
          onclick={() => void openSession()}>Claude arbeitet</button
        >
      {/if}
      {#if agentReply}
        <button class="chip action claude" title="Antwort des Agenten anzeigen" onclick={() => (showingReply = true)}
          >Antwort</button
        >
      {/if}
    </div>
    {#if item.notes && item.type === 'todo' && !held}
      <div class="notes">{item.notes}</div>
    {/if}
    {#if shownNotice}
      <div class="notice" class:error={shownNotice.error}>{shownNotice.text}</div>
    {/if}
    {#if expanded}
      <PrPanel {item} onchanged={() => onchanged?.()} />
    {/if}
  </div>

  <RowMenu {entries} />
</li>

{#if editingTickets}
  <TicketDialog
    {item}
    mapping={otmaMapping}
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

{#if showingReply}
  <ReplyDialog
    {item}
    onclose={() => (showingReply = false)}
    onopen={handedOff ? () => void openSession() : undefined}
  />
{/if}

{#if pickingHandOffProject}
  <ProjectDialog
    {item}
    {projects}
    onclose={() => {
      pickingHandOffProject = false;
      onchanged?.();
    }}
    onhandoff={() => void startHandOff(item)}
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
  /* On hold: compact, greyed out, title on one line. */
  .row.held {
    padding-block: 3px;
    opacity: 0.55;
  }
  .row.held:hover {
    opacity: 0.85;
  }
  .held .title-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .held .title:not(.with-dot) {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* On hold: only the hold chip, the PR number and the tickets; the rest would just take room. */
  .held .meta > :not(.hold, .pr-ref, .ticket) {
    display: none;
  }
  .chip.hold {
    border: none;
    font: inherit;
    color: var(--muted);
    cursor: pointer;
  }
  .chip.ticket,
  .chip.action {
    border: none;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .chip.action.claude {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-fg);
  }
  /* Status, not a button: outlined in the agent's colour. */
  .chip.status.claude {
    background: transparent;
    border: 1px solid var(--chip-orange-fg);
    color: var(--chip-orange-fg);
  }
  .chip.status.ended {
    background: transparent;
    border: 1px solid var(--muted);
    color: var(--muted);
  }
  button.chip.working,
  button.chip.status.asking,
  button.chip.status.ended {
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .chip.working {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-fg);
  }
  /* Waits for the user mid-turn: must not be overlooked. */
  .chip.status.asking {
    background: transparent;
    border: 1px solid var(--danger);
    color: var(--danger);
    font-weight: 600;
  }
  .kind.agent {
    color: var(--chip-blue-fg);
  }
  .kind.agent.paused {
    color: var(--muted);
  }
  .chip.action:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .chip.action:disabled {
    opacity: 0.5;
    cursor: default;
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
  .title.with-dot {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  /* Centered on the first title line (12px dot). */
  .title.with-dot > .dot {
    flex-shrink: 0;
    margin-top: calc((1lh - 12px) / 2);
  }
  .title-text {
    min-width: 0;
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
  /* Plain text to look at; a click copies the PR number. */
  .pr-ref {
    all: unset;
  }
  .pr-ref:focus-visible {
    outline: 2px solid var(--accent);
    border-radius: 3px;
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

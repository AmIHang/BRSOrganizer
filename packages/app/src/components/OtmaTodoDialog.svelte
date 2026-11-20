<script lang="ts">
  import { untrack } from 'svelte';
  import { agentModeCreated, startHandOff } from '../lib/handoff.svelte';
  import { otmaToTodo, suggestProject, type ProjectMaps } from '../lib/otma.svelte';
  import type { OtmaTicket } from '../lib/types';

  let {
    ticket,
    projects,
    mapping,
    onclose,
    oncreated,
  }: {
    ticket: OtmaTicket;
    /** Customer folders (as in the todo list). */
    projects: string[];
    /** BSM customer / OTMA project → customer folder. */
    mapping: ProjectMaps;
    onclose: () => void;
    oncreated: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  // Preselected from the mappings; a mapped folder that is gone stays selectable.
  const suggested = untrack(() => suggestProject('', ticket, mapping));
  const mapped = suggested?.project ?? '';
  const options = $derived(mapped && !projects.includes(mapped) ? [mapped, ...projects] : projects);
  let project = $state(mapped);
  let search = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  const filtered = $derived(
    options.filter((p) => p.toLocaleLowerCase('de').includes(search.trim().toLocaleLowerCase('de'))),
  );

  function onsearch() {
    if ((project && !filtered.includes(project)) || (!project && search.trim()))
      project = filtered[0] ?? '';
  }

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  async function create(handOff: boolean) {
    busy = true;
    error = null;
    try {
      const item = await otmaToTodo(ticket, project);
      oncreated();
      onclose();
      if (handOff) void startHandOff(item);
      else agentModeCreated(item);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} {onclose}>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void create(false);
    }}
  >
    <h2>Als Todo übernehmen</h2>
    <p class="title">{ticket.title}</p>
    {#if ticket.project || ticket.bsm}
      <p class="hint">
        {suggested ? `${suggested.via} → ${suggested.project}. ` : ''}Die Auswahl wird für weitere
        Tickets dieses BSM-Kunden gemerkt.
      </p>
    {/if}
    <label>
      Projekt
      <!-- svelte-ignore a11y_autofocus -->
      <input type="search" placeholder="Suchen …" bind:value={search} oninput={onsearch} autofocus />
      <select bind:value={project} size={Math.min(8, filtered.length + 1)}>
        <option value="">Kein Projekt</option>
        {#each filtered as p (p)}
          <option value={p}>{p}</option>
        {/each}
      </select>
    </label>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="buttons">
      <button type="button" onclick={onclose}>Abbrechen</button>
      <button
        type="button"
        disabled={busy || !project}
        title={project ? 'Todo anlegen und an einen Claude-Agenten übergeben' : 'Dafür zuerst ein Projekt wählen'}
        onclick={() => void create(true)}>Anlegen &amp; an Claude</button
      >
      <button type="submit" class="primary" disabled={busy}>Anlegen</button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0;
    width: min(440px, calc(100vw - 32px));
    background: var(--bg);
    color: var(--fg);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.45);
  }
  form {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  .title {
    margin: 0;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  label select,
  label input {
    font-size: 14px;
    color: var(--fg);
  }
  .error {
    margin: 0;
    font-size: 12px;
  }
  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>

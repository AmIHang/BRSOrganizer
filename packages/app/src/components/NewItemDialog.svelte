<script lang="ts">
  import type { NewItem } from '../lib/types';
  import { findOtma, suggestProject, type ProjectMaps } from '../lib/otma.svelte';

  let {
    open,
    project = null,
    mapping,
    oncreate,
    onclose,
  }: {
    open: boolean;
    /** From the "+" of a project: a todo filed under it (no event). */
    project?: string | null;
    /** BSM customer / OTMA project → project: linked tickets suggest their project. */
    mapping: ProjectMaps;
    oncreate: (item: NewItem) => Promise<void>;
    onclose: () => void;
  } = $props();

  const DURATIONS = [15, 30, 45, 60, 90, 120];

  let dialog = $state<HTMLDialogElement | null>(null);
  let titleInput = $state<HTMLInputElement | null>(null);
  let type = $state<'todo' | 'event'>('todo');
  let title = $state('');
  let when = $state('');
  let minutes = $state(30);
  let bsm = $state('');
  let otma = $state('');
  let instruction = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  /** datetime-local value for the next full half hour (local time). */
  function nextHalfHour(): string {
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      type = 'todo';
      title = '';
      when = '';
      minutes = 30;
      bsm = '';
      otma = '';
      instruction = '';
      error = null;
      dialog.showModal();
      queueMicrotask(() => titleInput?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  function chooseType(t: 'todo' | 'event') {
    type = t;
    if (t === 'event' && !when) when = nextHalfHour();
  }

  // Project suggested by the tickets: taken without asking when there is none yet.
  const suggested = $derived(type === 'todo' ? suggestProject(bsm, findOtma(otma), mapping) : null);
  const offer = $derived(suggested && suggested.project !== project ? suggested.project : null);
  let takeOffer = $state(false);
  $effect(() => {
    takeOffer = !!offer && !project;
  });

  // Todos: a title or a ticket (the daemon then takes the ticket's title); events: title and start.
  const canSubmit = $derived(
    type === 'todo'
      ? !!(title.trim() || bsm.trim() || otma.trim())
      : title.trim().length > 0 && when !== '',
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    busy = true;
    error = null;
    try {
      // datetime-local has no zone: it is local time; the API gets an instant.
      if (type === 'todo') {
        const target = offer && takeOffer ? offer : project;
        await oncreate({
          type: 'todo',
          title: title.trim(),
          dueAt: when ? new Date(when).toISOString() : null,
          bsmUrl: bsm.trim() || null,
          otmaUrl: otma.trim() || null,
          notes: instruction.trim() || null,
          project: target,
        });
      } else {
        const start = new Date(when);
        await oncreate({
          type: 'event',
          title: title.trim(),
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
        });
      }
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  onclose={onclose}
  onclick={(e) => {
    // Click on the backdrop (outside the form) closes the dialog.
    if (e.target === dialog) onclose();
  }}
>
  <form onsubmit={submit}>
    <h2>{project ? 'Neues Todo' : 'Neu'}</h2>
    {#if project}<p class="project">Projekt: {project}</p>{/if}

    <div class="types" role="radiogroup" aria-label="Typ" hidden={!!project}>
      <button
        type="button"
        role="radio"
        aria-checked={type === 'todo'}
        class:selected={type === 'todo'}
        onclick={() => chooseType('todo')}>Todo</button
      >
      <button
        type="button"
        role="radio"
        aria-checked={type === 'event'}
        class:selected={type === 'event'}
        onclick={() => chooseType('event')}>Termin</button
      >
    </div>

    <label>
      Text
      <input
        type="text"
        bind:this={titleInput}
        bind:value={title}
        placeholder={type === 'todo' ? 'Was ist zu tun? (leer: Titel aus dem Ticket)' : 'Worum geht es?'}
        maxlength="500"
      />
    </label>

    <div class="row">
      <label class="grow">
        {type === 'todo' ? 'Fällig (optional)' : 'Beginn'}
        <input type="datetime-local" bind:value={when} required={type === 'event'} />
      </label>
      {#if type === 'event'}
        <label>
          Dauer
          <select bind:value={minutes}>
            {#each DURATIONS as m (m)}
              <option value={m}>{m < 60 ? `${m} Min.` : `${m / 60} Std.`}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>

    {#if type === 'todo'}
      <div class="row">
        <label class="grow">
          BSM-Ticket (optional)
          <input type="text" bind:value={bsm} placeholder="BRS_PWg0127 oder URL" />
        </label>
        <label class="grow">
          OTMA-Ticket (optional)
          <input type="text" bind:value={otma} placeholder="148082 oder URL" />
        </label>
      </div>
      <label>
        Anweisung für Claude (optional)
        <textarea
          bind:value={instruction}
          rows="3"
          maxlength="10000"
          placeholder="Leer: Claude analysiert das Ticket und schlägt eine Umsetzung vor."
        ></textarea>
      </label>
      {#if offer && suggested}
        <label class="check">
          <input type="checkbox" bind:checked={takeOffer} />
          {project
            ? `${suggested.via} gehört zu „${offer}“ – Projekt auf „${offer}“ ändern?`
            : `Projekt „${offer}“ übernehmen (${suggested.via})`}
        </label>
      {/if}
    {/if}

    {#if error}<p class="error">{error}</p>{/if}

    <div class="buttons">
      <button type="button" onclick={onclose}>Abbrechen</button>
      <button type="submit" class="primary" disabled={!canSubmit || busy}>Anlegen</button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0;
    width: min(420px, calc(100vw - 32px));
    background: var(--bg);
    color: var(--fg);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.45);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  .project {
    margin: 0;
    font-size: 13px;
    color: var(--accent);
  }
  .types[hidden] {
    display: none;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 6px;
  }
  label input,
  label select,
  label textarea {
    font-size: 14px;
    color: var(--fg);
  }
  textarea {
    resize: vertical;
    font-family: inherit;
  }
  select {
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 6px;
    padding: 6px 8px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .types {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    align-self: flex-start;
  }
  .types button {
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 6px 16px;
  }
  .types button.selected {
    background: var(--accent);
    color: #fff;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .error {
    margin: 0;
    font-size: 12px;
  }
</style>

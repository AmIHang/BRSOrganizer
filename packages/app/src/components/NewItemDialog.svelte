<script lang="ts">
  import type { NewItem } from '../lib/types';

  let {
    open,
    oncreate,
    onclose,
  }: {
    open: boolean;
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

  const canSubmit = $derived(title.trim().length > 0 && (type === 'todo' || when !== ''));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    busy = true;
    error = null;
    try {
      // datetime-local has no zone: it is local time; the API gets an instant.
      if (type === 'todo') {
        await oncreate({
          type: 'todo',
          title: title.trim(),
          dueAt: when ? new Date(when).toISOString() : null,
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
    <h2>Neu</h2>

    <div class="types" role="radiogroup" aria-label="Typ">
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
        placeholder={type === 'todo' ? 'Was ist zu tun?' : 'Worum geht es?'}
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
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  label input,
  label select {
    font-size: 14px;
    color: var(--fg);
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

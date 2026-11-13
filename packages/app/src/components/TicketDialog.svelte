<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '../lib/api';
  import type { Item } from '../lib/types';

  let { item, onclose }: { item: Item; onclose: () => void } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  // Editable copies of the stored links, taken once when the dialog opens; saved on submit.
  let bsm = $state(untrack(() => item.bsmUrl ?? ''));
  let otma = $state(untrack(() => item.otmaUrl ?? ''));
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      await api.setTickets(item.id, {
        bsmUrl: bsm.trim() || null,
        otmaUrl: otma.trim() || null,
      });
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} onclose={onclose}>
  <form onsubmit={save}>
    <h2>Tickets</h2>
    <p class="title">{item.title}</p>
    <label>
      BSM-Ticket
      <input type="text" bind:value={bsm} placeholder="BRS_PWg0127 oder https://bsm.boomsoftware.com/indication/…" />
    </label>
    <label>
      OTMA-Ticket
      <input type="text" bind:value={otma} placeholder="https://…" />
    </label>
    <p class="hint muted">Leer lassen entfernt das Ticket.</p>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="buttons">
      <button type="button" onclick={onclose}>Abbrechen</button>
      <button type="submit" class="primary" disabled={busy}>Speichern</button>
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
  label input {
    font-size: 14px;
    color: var(--fg);
  }
  .hint,
  .error {
    margin: 0;
    font-size: 12px;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>

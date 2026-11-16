<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '../lib/api';
  import type { Item } from '../lib/types';

  let { item, projects, onclose }: { item: Item; projects: string[]; onclose: () => void } =
    $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  const current = untrack(() => (typeof item.meta?.project === 'string' ? item.meta.project : ''));
  let project = $state(current);
  // Keep the current project selectable even when it has no open pull request right now.
  const options = $derived(current && !projects.includes(current) ? [current, ...projects] : projects);
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
      await api.updateTodo(item.id, { project: project || null });
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
    <h2>In Projekt verschieben</h2>
    <p class="title">{item.title}</p>
    <label>
      Projekt
      <select bind:value={project}>
        <option value="">Kein Projekt</option>
        {#each options as p (p)}
          <option value={p}>{p}</option>
        {/each}
      </select>
    </label>
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
  label select {
    font-size: 14px;
  }
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

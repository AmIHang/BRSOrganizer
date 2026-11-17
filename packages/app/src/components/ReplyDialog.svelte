<script lang="ts">
  import type { Item } from '../lib/types';

  let {
    item,
    onclose,
    onopen,
  }: {
    item: Item;
    onclose: () => void;
    /** Opens the agent's session in a terminal (only while it still runs). */
    onopen?: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  const reply = $derived(typeof item.meta?.agentReply === 'string' ? item.meta.agentReply : '');
  const session = $derived(`Todo-${item.id.slice(-6).toLowerCase()}`);

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });
</script>

<dialog bind:this={dialog} onclose={onclose}>
  <div class="body">
    <h2>Antwort von Claude</h2>
    <p class="title">{item.title}</p>
    <!-- Agent output: text only, never HTML. -->
    <pre class="reply">{reply}</pre>
    <p class="hint muted">
      Der Agent wartet auf dich. Weiter im Terminal mit <code>claude attach {session}</code>.
    </p>
    <div class="buttons">
      {#if onopen}
        <button type="button" onclick={() => (onopen(), onclose())}>Im Terminal öffnen</button>
      {/if}
      <button type="button" class="primary" onclick={onclose}>Schließen</button>
    </div>
  </div>
</dialog>

<style>
  dialog {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0;
    width: min(640px, calc(100vw - 32px));
    background: var(--bg);
    color: var(--fg);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.45);
  }
  .body {
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
  .reply {
    margin: 0;
    max-height: 60vh;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    font-size: 13px;
    background: var(--chip);
    border-radius: 8px;
    padding: 10px;
  }
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>

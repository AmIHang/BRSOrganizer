<script lang="ts">
  import type { MenuEntry } from '../lib/types';

  let { entries }: { entries: MenuEntry[] } = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false;
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  });

  function choose(entry: MenuEntry) {
    open = false;
    entry.onclick();
  }
</script>

<div class="menu" bind:this={root}>
  <button
    class="trigger"
    title="Aktionen"
    aria-label="Aktionen"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open = !open)}>…</button
  >
  {#if open}
    <div class="popup" role="menu">
      {#each entries as entry (entry.label)}
        <button
          role="menuitem"
          class:danger={entry.danger}
          disabled={entry.disabled}
          title={entry.title}
          onclick={() => choose(entry)}>{entry.label}</button
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu {
    position: relative;
  }
  .trigger {
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 16px;
    line-height: 1;
    padding: 0 6px 4px;
    border-radius: 6px;
  }
  .trigger:hover,
  .trigger[aria-expanded='true'] {
    color: var(--fg);
    background: var(--chip);
  }
  .popup {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 5;
    min-width: 170px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  }
  .popup button {
    border: none;
    background: transparent;
    text-align: left;
    padding: 6px 10px;
    border-radius: 6px;
    white-space: nowrap;
  }
  .popup button:hover:not(:disabled) {
    background: var(--chip);
  }
  .popup button:disabled {
    color: var(--muted);
    cursor: default;
  }
  .popup button.danger {
    color: var(--danger);
  }
</style>

<script lang="ts">
  import type { MenuEntry } from '../lib/types';

  let {
    entries,
    label = '…',
    title = 'Aktionen',
    align = 'right',
    dot = false,
  }: {
    entries: MenuEntry[];
    /** Trigger text and tooltip. */
    label?: string;
    title?: string;
    /** Side of the trigger the popup lines up with (left: for triggers at the start of a row). */
    align?: 'left' | 'right';
    /** Light-blue dot like the clone dots (no label, `title` names it); a single entry runs on click, no popup. */
    dot?: boolean;
  } = $props();

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

<div class="menu" class:dot bind:this={root}>
  <button
    class="trigger"
    {title}
    aria-label={title}
    aria-haspopup={dot && entries.length === 1 ? undefined : 'menu'}
    aria-expanded={open}
    onclick={() => (dot && entries.length === 1 ? choose(entries[0]!) : (open = !open))}>{dot ? '' : label}</button
  >
  {#if open}
    <div class="popup" class:left={align === 'left'} role="menu">
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
  /* Same size and hover as the clone dots in ItemRow; light blue = web app. */
  .dot .trigger {
    display: block;
    width: 12px;
    height: 12px;
    padding: 0;
    border-radius: 50%;
    background: #54aeff;
    transition: transform 0.12s;
  }
  .dot .trigger:hover,
  .dot .trigger[aria-expanded='true'] {
    background: #54aeff;
    transform: scale(1.3);
  }
  .popup.left {
    right: auto;
    left: 0;
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

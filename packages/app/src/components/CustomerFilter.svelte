<script lang="ts">
  let {
    customers,
    hidden,
    ontoggle,
    onshowall,
  }: {
    /** All customers of the section, in display order. */
    customers: string[];
    hidden: string[];
    ontoggle: (customer: string) => void;
    onshowall: () => void;
  } = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | null>(null);
  const hiddenCount = $derived(customers.filter((c) => hidden.includes(c)).length);

  // Stays open while ticking boxes; closes on a click outside or Escape (like RowMenu).
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
</script>

<div class="filter" bind:this={root}>
  <button
    class="trigger"
    class:active={hiddenCount > 0}
    title="Kunden ein-/ausblenden"
    aria-haspopup="true"
    aria-expanded={open}
    onclick={() => (open = !open)}
    >Filter{hiddenCount ? ` (${hiddenCount} ausgeblendet)` : ''}</button
  >
  {#if open}
    <div class="popup" role="group" aria-label="Kunden anzeigen">
      {#each customers as customer (customer)}
        <label>
          <input
            type="checkbox"
            checked={!hidden.includes(customer)}
            onchange={() => ontoggle(customer)}
          />
          {customer}
        </label>
      {/each}
      {#if hiddenCount}
        <button class="all" onclick={onshowall}>Alle anzeigen</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .filter {
    position: relative;
    margin-left: auto;
    text-transform: none;
    letter-spacing: normal;
  }
  .trigger {
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    font-weight: normal;
    padding: 2px 6px;
    border-radius: 6px;
  }
  .trigger:hover,
  .trigger[aria-expanded='true'] {
    color: var(--fg);
    background: var(--chip);
  }
  .trigger.active {
    color: #8957e5;
  }
  .popup {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 5;
    min-width: 180px;
    max-height: 60vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    font-size: 13px;
    font-weight: normal;
    color: var(--fg);
  }
  label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 6px;
    white-space: nowrap;
    cursor: pointer;
  }
  label:hover {
    background: var(--chip);
  }
  .all {
    margin-top: 4px;
    border: none;
    background: transparent;
    text-align: left;
    padding: 5px 8px;
    border-radius: 6px;
    color: #8957e5;
  }
  .all:hover {
    background: var(--chip);
  }
</style>

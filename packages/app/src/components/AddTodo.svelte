<script lang="ts">
  let { onadd }: { onadd: (title: string, dueAt: string | null) => Promise<void> } = $props();

  let title = $state('');
  let due = $state('');
  let busy = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    busy = true;
    try {
      // datetime-local has no zone: interpret as local time and send an instant.
      await onadd(t, due ? new Date(due).toISOString() : null);
      title = '';
      due = '';
    } finally {
      busy = false;
    }
  }
</script>

<form onsubmit={submit}>
  <input type="text" placeholder="Neues Todo …" bind:value={title} aria-label="Titel" />
  <input type="datetime-local" bind:value={due} aria-label="Fällig" title="Fällig (optional)" />
  <button class="primary" type="submit" disabled={busy || !title.trim()}>+</button>
</form>

<style>
  form {
    display: flex;
    gap: 6px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  input[type='text'] {
    flex: 1;
    min-width: 0;
  }
  input[type='datetime-local'] {
    width: 170px;
  }
</style>

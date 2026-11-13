<script lang="ts">
  import { api } from '../lib/api';
  import type { Item, PrDetails } from '../lib/types';

  let {
    item,
    cloned,
    onclose,
    ondone,
  }: {
    item: Item;
    /** A local clone exists: offer to remove it after the merge. */
    cloned: boolean;
    onclose: () => void;
    ondone: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let details = $state<PrDetails | null>(null);
  let removeClone = $state(true);
  let phase = $state<'loading' | 'confirm' | 'merging' | 'done' | 'error'>('loading');
  let message = $state<string | null>(null);

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  $effect(() => {
    void api.pr
      .details(item.id)
      .then((d) => {
        details = d;
        if (d.pr.status !== 'active') {
          phase = 'error';
          message = `PR ist bereits „${d.pr.status}“.`;
        } else phase = 'confirm';
      })
      .catch((e: unknown) => {
        phase = 'error';
        message = e instanceof Error ? e.message : String(e);
      });
  });

  async function merge() {
    phase = 'merging';
    message = null;
    try {
      const r = await api.pr.complete(item.id, true);
      if (r.status !== 'completed') {
        phase = 'error';
        message = `PR ist noch „${r.status}“ (Merge: ${r.mergeStatus ?? '?'}) – vermutlich blockieren Richtlinien. Details im Browser.`;
        return;
      }
      let text = `Genehmigt und gemergt${r.mergeCommit ? ` (${r.mergeCommit.slice(0, 8)})` : ''}.`;
      if (cloned && removeClone) {
        await api.pr.removeLocal(item.id);
        text += ' Der lokale Klon wird im PowerShell-Fenster gelöscht (UAC bestätigen).';
      }
      phase = 'done';
      message = text;
      ondone();
    } catch (e) {
      phase = 'error';
      message = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<dialog bind:this={dialog} onclose={onclose}>
  <div class="content">
    <h2>Accept &amp; Merge</h2>
    <p class="title">{item.title}</p>

    {#if phase === 'loading'}
      <p class="muted">Lade PR …</p>
    {:else if details && (phase === 'confirm' || phase === 'merging')}
      <ul>
        <li>mit „Genehmigt“ abstimmen</li>
        <li>Squash-Merge von <b>{details.pr.sourceBranch}</b> in <b>{details.pr.targetBranch}</b></li>
        <li>Branch <b>{details.pr.sourceBranch}</b> auf dem Server löschen</li>
      </ul>
      {#if cloned}
        <label class="check">
          <input type="checkbox" bind:checked={removeClone} disabled={phase === 'merging'} />
          lokalen Klon danach löschen (inkl. IIS-App-Pool)
        </label>
      {/if}
    {/if}

    {#if phase === 'merging'}<p class="muted">Merge läuft – das kann bis zu einer Minute dauern …</p>{/if}
    {#if message}<p class:error={phase === 'error'} class:ok={phase === 'done'}>{message}</p>{/if}

    <div class="buttons">
      {#if phase === 'done' || phase === 'error'}
        <button onclick={onclose}>Schließen</button>
      {:else}
        <button onclick={onclose} disabled={phase === 'merging'}>Abbrechen</button>
        <button class="primary" onclick={merge} disabled={phase !== 'confirm'}>Accept &amp; Merge</button>
      {/if}
    </div>
  </div>
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
  .content {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
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
  ul {
    margin: 0;
    padding-left: 18px;
  }
  p {
    margin: 0;
  }
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .ok {
    color: var(--ok);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
</style>

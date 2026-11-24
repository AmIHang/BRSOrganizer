<script lang="ts">
  import { openUrl } from '../lib/system';
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { Item, PrDetails } from '../lib/types';

  let { item, onchanged }: { item: Item; onchanged: () => void } = $props();

  let details = $state<PrDetails | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let busy = $state(false);
  let confirming = $state<'complete' | 'remove' | null>(null);
  let approve = $state(false);

  const local = $derived(details?.local.state === 'ok' ? details.local : null);
  const myVote = $derived(details?.pr.reviewers.find((r) => r.isMe)?.vote ?? null);

  async function load(fetch: boolean) {
    try {
      details = await api.pr.details(item.id, fetch);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    // Quick view first, then compare with the server (git fetch can take a few seconds).
    void load(false).then(() => {
      if (local?.cloned) void load(true);
    });
  });

  async function run(action: () => Promise<unknown>, message: string) {
    busy = true;
    notice = null;
    try {
      await action();
      notice = message;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function startComplete() {
    approve = myVote !== 'genehmigt';
    confirming = 'complete';
  }

  async function complete() {
    confirming = null;
    busy = true;
    notice = 'Abschluss angefordert – warte auf den Merge …';
    try {
      const r = await api.pr.complete(item.id, approve);
      if (r.status === 'completed') {
        notice = `Gemergt${r.mergeCommit ? ` (${r.mergeCommit.slice(0, 8)})` : ''}.`;
        await load(false);
        if (local?.cloned) confirming = 'remove';
        onchanged();
      } else {
        notice = null;
        error = `PR ist noch „${r.status}“ (Merge: ${r.mergeStatus ?? '?'}) – vermutlich blockieren Richtlinien. Details im Browser.`;
      }
    } catch (e) {
      notice = null;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function removeLocal() {
    confirming = null;
    await run(
      () => api.pr.removeLocal(item.id),
      'Löschen läuft im PowerShell-Fenster (UAC-Abfrage für den IIS bestätigen).',
    );
  }
</script>

<div class="panel">
  {#if loading}
    <p class="muted">Lade PR …</p>
  {:else if details}
    <dl>
      <dt>Branch</dt>
      <dd>{details.pr.sourceBranch} → {details.pr.targetBranch}</dd>
      <dt>Status</dt>
      <dd>
        {details.pr.status}{details.pr.isDraft ? ' (Entwurf)' : ''}
        {#if details.pr.mergeStatus}· Merge: {details.pr.mergeStatus}{/if}
      </dd>
      {#if details.pr.author}<dt>Autor</dt><dd>{details.pr.author}</dd>{/if}
      <dt>Reviewer</dt>
      <dd>
        {#each details.pr.reviewers as r (r.name)}
          <div class:me={r.isMe}>{r.name}{r.isGroup ? ' (Gruppe)' : ''} – {r.vote}</div>
        {:else}
          <span class="muted">keine</span>
        {/each}
      </dd>
    </dl>

    <h4>Lokal</h4>
    {#if details.local.state === 'not-configured'}
      <p class="muted">Projektordner in den Einstellungen festlegen (PR-Arbeitsbereich).</p>
    {:else if details.local.state === 'no-repo'}
      <p class="muted">
        Kein Repo für dieses Projekt unter {details.local.projectsRoot} gefunden.
      </p>
    {:else if local}
      {#if local.cloned}
        <p class="path" title={local.clonePath}>{local.clonePath}</p>
        {#if local.head}
          <p class="muted">Stand: {local.head.sha} {local.head.subject} ({local.head.when})</p>
        {/if}
        {#if local.remoteGone}
          <p class="warn">Branch existiert auf dem Server nicht mehr.</p>
        {:else if local.behind !== null && local.behind > 0}
          <p class="warn">{local.behind} neue(r) Commit(s) auf dem Server.</p>
        {:else if local.behind === 0}
          <p class="ok">Aktuell.</p>
        {/if}
      {:else}
        <p class="muted">Noch nicht geklont ({local.customer}\PR{details.pr.id}).</p>
      {/if}
    {/if}

    <div class="buttons">
      {#if local}
        <button
          disabled={busy || local.remoteGone}
          onclick={() =>
            run(
              () => api.pr.cloneOrUpdate(item.id),
              'Läuft im PowerShell-Fenster (Klonen/Aktualisieren, Referenzen, NuGet, Build).',
            )}
        >
          {local.cloned ? 'Aktualisieren & bauen' : 'Klonen & bauen'}
        </button>
        {#if local.cloned}
          <button
            disabled={busy || !local.solution}
            onclick={() => run(() => api.pr.open(item.id, 'solution'), 'Solution wird geöffnet.')}
            >Solution</button
          >
          <button disabled={busy} onclick={() => run(() => api.pr.open(item.id, 'folder'), '')}
            >Ordner</button
          >
          {#each local.webUrls as url, i (url)}
            <button onclick={() => openUrl(url)} title={url}
              >Web-App{local.webUrls.length > 1 ? ` ${i + 1}` : ''}</button
            >
          {/each}
          {#if local.managed}
            <button class="danger" disabled={busy} onclick={() => (confirming = 'remove')}
              >Lokal löschen</button
            >
          {/if}
        {/if}
      {/if}
      {#if details.pr.status === 'active'}
        <button class="primary" disabled={busy} onclick={startComplete}>PR abschließen</button>
      {/if}
      <button class="icon" title="Neu laden" disabled={busy} onclick={() => load(true)}>⟳</button>
    </div>

    {#if confirming === 'complete'}
      <div class="confirm">
        <p>
          Squash-Merge in <b>{details.pr.targetBranch}</b>, danach wird
          <b>{details.pr.sourceBranch}</b> auf dem Server gelöscht.
        </p>
        <label class="check">
          <input type="checkbox" bind:checked={approve} /> vorher mit „Genehmigt“ abstimmen
          {#if myVote}<span class="muted">(bisher: {myVote})</span>{/if}
        </label>
        <div class="buttons">
          <button onclick={() => (confirming = null)}>Abbrechen</button>
          <button class="primary" onclick={complete}>Jetzt mergen</button>
        </div>
      </div>
    {:else if confirming === 'remove' && local}
      <div class="confirm">
        <p>
          Löscht <b>{local.clonePath}</b> samt IIS-App-Pool PR{details.pr.id}. Visual Studio und
          Explorer-Fenster in diesem Ordner vorher schließen.
        </p>
        <div class="buttons">
          <button onclick={() => (confirming = null)}>Behalten</button>
          <button class="danger" onclick={removeLocal}>Lokal löschen</button>
        </div>
      </div>
    {/if}
  {/if}

  {#if notice}<p class="notice">{notice}</p>{/if}
  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .panel {
    margin: 6px 0 2px;
    padding: 8px 10px;
    border-left: 2px solid var(--accent);
    background: var(--bg-soft);
    border-radius: 0 6px 6px 0;
    font-size: 12px;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 0 0 6px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .me {
    font-weight: 600;
  }
  h4 {
    margin: 8px 0 2px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  p {
    margin: 2px 0;
  }
  .path {
    font-family: Consolas, monospace;
    overflow-wrap: anywhere;
  }
  .warn {
    color: #d29922;
  }
  .ok {
    color: var(--ok);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .buttons button {
    font-size: 12px;
    padding: 3px 8px;
  }
  button.danger {
    border-color: var(--danger);
    color: var(--danger);
  }
  .confirm {
    margin-top: 8px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
  }
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 4px;
  }
  .notice {
    margin-top: 6px;
    color: var(--ok);
  }
  .error {
    margin-top: 6px;
  }
</style>

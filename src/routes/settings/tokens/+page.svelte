<script lang="ts">
	import { enhance } from '$app/forms';
	import { describeAge } from '$lib/dates';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let copied = $state<string | null>(null);

	const config = $derived(
		form && 'created' in form && form.created
			? JSON.stringify(
					{
						mcpServers: {
							uieats: {
								url: data.mcpUrl,
								headers: { Authorization: `Bearer ${form.created.token}` }
							}
						}
					},
					null,
					2
				)
			: null
	);

	async function copy(text: string, what: string) {
		await navigator.clipboard.writeText(text);
		copied = what;
	}
</script>

<svelte:head><title>Access tokens — uieats</title></svelte:head>

<h1 class="display rule-title pb-2 text-3xl">Access tokens</h1>
<p class="mt-4 text-sm leading-relaxed text-ink-muted">
	A token lets an AI assistant read your allergens and saved dishes through the uieats MCP server at <span
		class="font-mono text-ink">{data.mcpUrl}</span
	>. It can read, never change anything.
</p>

{#if form && 'created' in form && form.created}
	<section class="mt-8 border-2 border-ink p-4">
		<h2 class="eyebrow pb-1">{form.created.name}</h2>
		<p class="mt-1 text-sm">Copy it now. It will not be shown again.</p>

		<div class="mt-3 flex items-center gap-2">
			<input
				readonly
				value={form.created.token}
				aria-label="New access token"
				class="min-w-0 flex-1 border border-ink bg-paper-sunk px-2 py-1.5 font-mono text-xs focus:ring-0"
				onfocus={(e) => e.currentTarget.select()}
			/>
			<button
				type="button"
				onclick={() => copy(form.created.token, 'token')}
				class="shrink-0 border border-ink px-2 py-1.5 text-[0.6875rem] font-semibold hover:bg-paper-sunk"
			>
				{copied === 'token' ? 'Copied' : 'Copy'}
			</button>
		</div>

		{#if config}
			<div class="mt-4 flex items-baseline justify-between gap-2">
				<h3 class="eyebrow">Client config</h3>
				<button
					type="button"
					onclick={() => copy(config, 'config')}
					class="border border-ink px-2 py-0.5 text-[0.6875rem] font-semibold hover:bg-paper-sunk"
				>
					{copied === 'config' ? 'Copied' : 'Copy'}
				</button>
			</div>
			<pre
				class="mt-2 overflow-x-auto border border-ink-faint bg-paper-sunk p-3 font-mono text-[0.6875rem] leading-relaxed">{config}</pre>
		{/if}
	</section>
{/if}

<section class="mt-8">
	<h2 class="eyebrow rule-group pb-1">On your account</h2>

	{#if data.tokens.length === 0}
		<p class="mt-3 text-sm text-ink-faint">No tokens yet.</p>
	{:else}
		<ul class="mt-1">
			{#each data.tokens as token (token.id)}
				<li class="rule-hair flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
					<div class="min-w-0">
						<p class="text-sm font-medium">
							{token.name}
							<span class="font-mono text-[0.6875rem] text-ink-faint">…{token.hint}</span>
						</p>
						<p class="font-mono text-[0.6875rem] text-ink-faint">
							added {describeAge(token.createdAt)},
							{token.lastUsedAt ? `last used ${describeAge(token.lastUsedAt)}` : 'never used'}
						</p>
					</div>

					<form method="POST" action="?/revoke" use:enhance class="shrink-0">
						<input type="hidden" name="id" value={token.id} />
						<button
							type="submit"
							class="border border-ink px-2 py-0.5 text-[0.6875rem] font-semibold hover:bg-paper-sunk"
						>
							Revoke
						</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	{#if form && 'revoked' in form && form.revoked}
		<p class="mt-3 text-sm font-semibold">Token revoked.</p>
	{/if}
</section>

<section class="mt-10">
	<h2 class="eyebrow rule-group pb-1">Create one</h2>
	<form method="POST" action="?/create" class="mt-3 flex flex-wrap items-end gap-3">
		<label class="flex-1">
			<span class="sr-only">Token name</span>
			<input
				type="text"
				name="name"
				required
				value={form && 'name' in form ? (form.name ?? '') : ''}
				placeholder="Claude, Cursor…"
				maxlength={data.maxName}
				class="w-full border-0 border-b-2 border-ink bg-transparent px-0 py-1.5 text-sm focus:ring-0"
			/>
		</label>
		<button type="submit" class="bg-ink-full px-4 py-2 text-sm font-bold text-paper">
			Create token
		</button>
	</form>

	{#if form && 'message' in form && form.message}
		<p class="mt-3 border-l-2 border-ink pl-3 text-sm">{form.message}</p>
	{/if}
</section>

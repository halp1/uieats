<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Connect {data.app.name} — uieats</title></svelte:head>

<h1 class="display rule-title pb-2 text-3xl">Connect {data.app.name}</h1>
<p class="eyebrow mt-2">{data.user?.email}</p>

<section class="mt-8">
	<h2 class="eyebrow rule-group pb-1">It will be able to read</h2>
	<ul class="mt-2 list-disc pl-5 text-sm leading-relaxed">
		<li>your allergens, custom allergens and diet tags</li>
		<li>your saved dishes</li>
		<li>menus and dishes checked against your allergens</li>
	</ul>
	<p class="mt-3 text-sm text-ink-muted">It cannot change anything.</p>
</section>

<section class="mt-8">
	<h2 class="eyebrow rule-group pb-1">Returns to</h2>
	<p class="mt-2 font-mono text-sm">{data.app.returnsTo}</p>
</section>

<form method="POST" class="mt-10 flex flex-wrap gap-3">
	{#each Object.entries(data.params) as [name, value] (name)}
		{#if value !== null}
			<input type="hidden" {name} {value} />
		{/if}
	{/each}
	<button formaction="?/approve" class="bg-ink-full px-4 py-2 text-sm font-bold text-paper">
		Allow
	</button>
	<button
		formaction="?/deny"
		class="border border-ink px-4 py-2 text-sm font-semibold hover:bg-paper-sunk"
	>
		Cancel
	</button>
</form>

<p class="mt-6 text-xs text-ink-faint">
	Disconnect it any time in <a href="/settings/tokens" class="underline">Account</a>.
</p>

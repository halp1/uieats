<script lang="ts">
	import './layout.css';
	import Search from '@lucide/svelte/icons/search';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import { page } from '$app/state';
	import Disclaimer from '$lib/components/Disclaimer.svelte';
	import { describeAge } from '$lib/server/time';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	const freshness = $derived(describeAge(data.lastUpdated));
</script>

<svelte:head>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		rel="stylesheet"
		href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
	/>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="mx-auto flex min-h-dvh max-w-3xl flex-col px-4">
	<!--
		The masthead is the nutrition label's title bar: name locked left, heavy
		rule beneath, nothing else competing with it.
	-->
	<header class="rule-title flex items-end justify-between gap-4 pt-6 pb-1">
		<a href="/" class="display text-3xl tracking-[-0.04em] lowercase">uieats</a>

		<nav class="flex items-center gap-3 pb-1 text-xs font-semibold">
			<a href="/search" class="flex items-center gap-1 hover:underline">
				<Search class="size-3.5" />
				Search
			</a>
			<a href="/settings/allergens" class="flex items-center gap-1 hover:underline">
				<SlidersHorizontal class="size-3.5" />
				{#if data.allergenCount > 0}
					{data.allergenCount} allergen{data.allergenCount === 1 ? '' : 's'}
				{:else}
					Allergens
				{/if}
			</a>
			{#if data.user}
				<a href="/settings" class="hover:underline">Account</a>
			{:else}
				<a href="/auth/login" class="hover:underline">Sign in</a>
			{/if}
		</nav>
	</header>

	<p class="eyebrow pt-1 pb-4">University of Illinois dining, with your allergens flagged</p>

	{#if data.user === null && page.url.pathname.startsWith('/d/')}
		<!--
			Anonymous users get menus but no chips, so say why rather than showing
			a page that looks like everything is unflagged.
		-->
		<p class="mb-6 border-l-2 border-ink pl-3 text-xs leading-relaxed text-ink-muted">
			You are browsing without an account, so nothing is flagged.
			<a href="/auth/login" class="font-semibold text-ink underline">Sign in</a>
			with an @illinois.edu address to register your allergens and see them marked on every dish.
		</p>
	{/if}

	<main class="flex-1">
		{@render children()}
	</main>

	<footer class="mt-16 pb-10">
		<div class="rule-section mb-4"></div>

		<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
			<p
				class="font-mono text-[0.6875rem] {data.isStale
					? 'font-semibold text-ink'
					: 'text-ink-faint'}"
			>
				{#if data.lastUpdated === null}
					No successful menu update recorded yet
				{:else}
					Menu data updated {freshness}{#if data.isStale}
						&nbsp;— this is older than it should be, so treat it with suspicion{/if}
				{/if}
			</p>
			<p class="font-mono text-[0.6875rem] text-ink-faint">Source: eatsmart.housing.illinois.edu</p>
		</div>

		<Disclaimer compact />

		<p class="mt-4 text-[0.6875rem] text-ink-faint">
			Not affiliated with or endorsed by the University of Illinois.
		</p>
	</footer>
</div>

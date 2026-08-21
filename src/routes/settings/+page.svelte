<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const rows = $derived([
		{
			href: '/settings/allergens',
			title: 'Allergens and diet',
			detail:
				data.allergenCount === 0
					? 'Nothing registered — no dish is being checked for you'
					: `${data.allergenCount} allergen${data.allergenCount === 1 ? '' : 's'}${
							data.dietCount > 0
								? `, ${data.dietCount} diet filter${data.dietCount === 1 ? '' : 's'}`
								: ''
						}`
		},
		{
			href: '/settings/favorites',
			title: 'Saved dishes',
			detail:
				data.favoriteCount === 0
					? 'Nothing saved yet'
					: `${data.favoriteCount} dish${data.favoriteCount === 1 ? '' : 'es'}`
		},
		{
			href: '/settings/passkeys',
			title: 'Passkeys',
			detail:
				data.passkeyCount === 0
					? 'None — you sign in by email code'
					: `${data.passkeyCount} passkey${data.passkeyCount === 1 ? '' : 's'}`
		}
	]);
</script>

<svelte:head><title>Account — uieats</title></svelte:head>

<h1 class="display rule-title pb-2 text-3xl">Account</h1>
<p class="eyebrow mt-2">{data.user?.email}</p>

<ul class="mt-8">
	{#each rows as row (row.href)}
		<li class="rule-hair py-3">
			<a href={row.href} class="group flex items-baseline justify-between gap-3">
				<span class="text-[0.9375rem] font-semibold group-hover:underline">{row.title}</span>
				<span class="shrink-0 text-right font-mono text-[0.6875rem] text-ink-faint">
					{row.detail}
				</span>
			</a>
		</li>
	{/each}
</ul>

{#if data.allergenCount === 0}
	<p class="mt-6 border-l-2 border-ink pl-3 text-sm leading-relaxed">
		uieats does nothing useful until it knows what to warn you about.
		<a href="/settings/allergens" class="font-semibold underline">Register your allergens</a>.
	</p>
{/if}

<div class="mt-12">
	<a href="/auth/logout" class="text-xs font-semibold text-ink-muted underline">Sign out</a>
</div>

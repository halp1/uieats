<!--
	One dish, as a nutrition-label line.

	Name locked left, value locked right, hairline rule beneath -- the same
	shape as "Total Fat 8g". A hall-day is ~150 of these, and reading them as one
	dense panel is faster than reading 150 cards.

	Two things this row must never do: imply an item is fine when no label has
	been fetched, and hide which allergens the user asked about. So warnings sort
	first, unverified sorts above resolved, and an item with nothing fetched says
	so in words.
-->
<script lang="ts">
	import Star from '@lucide/svelte/icons/star';
	import type { MenuItemView } from '$lib/server/queries/menus';
	import AllergenChip from './AllergenChip.svelte';

	let { item, showDiet = true }: { item: MenuItemView; showDiet?: boolean } = $props();

	const summary = $derived(item.allergens);
	// Only the chips that say something. A user with eight allergens does not
	// want eight grey "not declared" chips on every one of 150 rows -- the
	// warnings and the gaps are the signal.
	const notable = $derived(
		summary ? summary.verdicts.filter((v) => v.verdict !== 'no-declared') : []
	);
	const clearCount = $derived(summary ? summary.verdicts.length - notable.length : 0);
	const diets = $derived(showDiet ? item.traits.filter((t) => t.isDiet) : []);
</script>

<li class="rule-hair py-2">
	<div class="flex items-baseline gap-3">
		<a
			href="/item/{item.slug}"
			class="min-w-0 flex-1 text-[0.9375rem] leading-snug font-medium hover:underline"
		>
			{item.name}
			{#if item.isFavorite}
				<Star class="mb-px inline size-3 fill-current align-baseline" aria-label="Favourite" />
			{/if}
		</a>

		<span class="tabular shrink-0 font-mono text-[0.6875rem] text-ink-faint">
			{#if item.servingSize}{item.servingSize}{/if}
			{#if item.calories !== null}
				<span class="ml-2 font-semibold text-ink">{Math.round(item.calories)} cal</span>
			{/if}
		</span>
	</div>

	{#if notable.length > 0 || diets.length > 0 || clearCount > 0}
		<div class="mt-1 flex flex-wrap items-center gap-1">
			{#each notable as verdict (verdict.allergen.slug)}
				<AllergenChip {verdict} compact />
			{/each}

			{#if clearCount > 0}
				<!-- Counted rather than listed, and worded as an observation: these
				     are allergens nothing was found for, which is not the same claim
				     as the item being fine. -->
				<span class="chip chip-none" title="Nothing found for these in what has been read.">
					{clearCount} not declared
				</span>
			{/if}

			{#each diets as diet (diet.slug)}
				<span class="chip chip-diet">{diet.label}</span>
			{/each}
		</div>
	{/if}
</li>

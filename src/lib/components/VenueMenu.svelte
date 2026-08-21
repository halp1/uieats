<!--
	One venue's menus for a day.

	The same component renders the hall view (many of these) and the venue view
	(one). That is the whole reason "the entire hall at once" -- the thing
	upstream cannot do -- costs nothing extra: one query, one shape, two skins.

	Rule weight carries the hierarchy, as it does on a nutrition label: heavy bar
	under the venue, medium under the meal, hairline between dishes.
-->
<script lang="ts">
	import type { VenueView } from '$lib/server/queries/menus';
	import { formatClock } from '$lib/server/time';
	import ItemRow from './ItemRow.svelte';

	let {
		venue,
		mealFilter = null,
		headingHref = null,
		showHeading = true
	}: {
		venue: VenueView;
		/** Show only this meal. The hall view's tab bar drives it. */
		mealFilter?: string | null;
		/** Makes the venue name a link -- used from the hall view. */
		headingHref?: string | null;
		/** The venue page already has the name as its h1; do not repeat it. */
		showHeading?: boolean;
	} = $props();

	const meals = $derived(
		mealFilter === null ? venue.meals : venue.meals.filter((m) => m.meal === mealFilter)
	);

	// Only shown when upstream actually publishes a schedule. A week that reads
	// closed on all seven days is upstream declining to say, and printing
	// "Closed today" above a published breakfast menu would make the user
	// arbitrate between two of our own claims.
	const hoursText = $derived.by(() => {
		if (!venue.hours.publishesSchedule || venue.hours.today.length === 0) return null;
		if (venue.hours.today.every((h) => h.isClosed)) return 'Closed today';
		return venue.hours.today
			.filter((h) => !h.isClosed)
			.map((h) =>
				h.opens && h.closes ? `${formatClock(h.opens)} – ${formatClock(h.closes)}` : h.raw
			)
			.join(', ');
	});
</script>

<section class="mb-10">
	{#if showHeading}
		<header class="rule-section flex flex-wrap items-end justify-between gap-x-4 gap-y-1 pb-1">
			<h2 class="display text-xl">
				{#if headingHref}
					<a href={headingHref} class="hover:underline">{venue.venue.name}</a>
				{:else}
					{venue.venue.name}
				{/if}
			</h2>

			{#if hoursText}
				<p class="font-mono text-[0.6875rem] text-ink-faint">{hoursText}</p>
			{/if}
		</header>

		{#if meals.length === 0}
			<p class="py-4 text-sm text-ink-faint">No menu published for this day.</p>
		{/if}
	{/if}

	{#each meals as meal (meal.menuId)}
		<div class="mt-5">
			<h3 class="rule-group flex items-baseline justify-between pb-0.5">
				<span class="text-base font-bold">{meal.meal}</span>
				<span class="tabular font-mono text-[0.6875rem] font-normal text-ink-faint">
					{meal.itemCount}
					{meal.itemCount === 1 ? 'item' : 'items'}
				</span>
			</h3>

			{#if meal.categories.length === 0}
				<!-- A published menu with nothing on it is a real upstream state, not
				     an error: the meal exists, the dishes are not entered yet. -->
				<p class="mt-2 text-sm text-ink-faint">
					This meal is published but has no dishes listed yet.
				</p>
			{/if}

			{#each meal.categories as category (category.id)}
				<div class="mt-4">
					<h4 class="eyebrow rule-hair pb-0.5">{category.name}</h4>
					<ul>
						{#each category.items as item (item.menuItemId)}
							<ItemRow {item} />
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	{/each}
</section>

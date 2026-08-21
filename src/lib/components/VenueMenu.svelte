<!--
	One venue's menus for a day.

	The same component renders the hall view (many of these) and the venue view
	(one). That is the whole reason "the entire hall at once" -- the thing
	upstream cannot do -- costs nothing extra: one query, one shape, two skins.

	Rule weight carries the hierarchy, as it does on a nutrition label: heavy bar
	under the venue, medium under the meal, hairline between dishes.
-->
<script lang="ts">
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import type { MealView, VenueView } from '$lib/server/queries/menus';
	import { formatClock } from '$lib/dates';
	import ItemRow from './ItemRow.svelte';

	let {
		venue,
		mealFilter = null,
		headingHref = null,
		showHeading = true,
		filtered = false,
		nowServing = null
	}: {
		venue: VenueView;
		/** Show only this meal. The hall view's tab bar drives it. */
		mealFilter?: string | null;
		/** Makes the venue name a link -- used from the hall view. */
		headingHref?: string | null;
		/** The venue page already has the name as its h1; do not repeat it. */
		showHeading?: boolean;
		/**
		 * True when a diet filter is narrowing the list. It changes what an empty
		 * meal MEANS -- "not entered yet" versus "nothing here matches" -- and
		 * saying the wrong one sends a user looking for a menu that is right there.
		 */
		filtered?: boolean;
		/**
		 * The sitting being served at this moment, or null on any day but today.
		 * Marked rather than filtered to: the venue view deliberately shows the
		 * whole day, and hiding the rest of it to make a point about the clock
		 * would be a worse trade.
		 */
		nowServing?: string | null;
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

	/**
	 * Allergens that are `unknown` for EVERY dish on a meal, hoisted out of the
	 * rows and stated once.
	 *
	 * This is not a decluttering exercise. Before any label is fetched, celery
	 * and mustard are unverifiable on all two dozen dishes -- and a chip repeated
	 * on all two dozen rows stops being read at all, which is precisely the
	 * "teach users to ignore warnings" failure the design is built to avoid. Said
	 * once, in a sentence, it registers. Anything unknown on only SOME dishes
	 * stays on its rows, because there the difference between them is the signal.
	 */
	function hoistedUnknowns(meal: MealView): { slug: string; label: string }[] {
		const items = meal.categories.flatMap((c) => c.items);
		if (items.length === 0) return [];
		// Anonymous users have no summaries at all; nothing to hoist.
		if (!items.every((i) => i.allergens !== null)) return [];

		const unknownIn = (item: (typeof items)[number]) =>
			new Set(
				item.allergens!.verdicts.filter((v) => v.verdict === 'unknown').map((v) => v.allergen.slug)
			);

		const shared = unknownIn(items[0]);
		for (const item of items.slice(1)) {
			const here = unknownIn(item);
			for (const slug of [...shared]) if (!here.has(slug)) shared.delete(slug);
		}

		return items[0]
			.allergens!.verdicts.filter((v) => shared.has(v.allergen.slug))
			.map((v) => ({ slug: v.allergen.slug, label: v.allergen.label }));
	}

	function listOf(labels: string[]): string {
		if (labels.length === 1) return labels[0];
		return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
	}
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
		{@const hoisted = hoistedUnknowns(meal)}
		<div class="mt-5">
			<h3 class="rule-group flex items-baseline justify-between pb-0.5">
				<span class="text-base font-bold">
					{meal.meal}
					{#if meal.meal === nowServing}
						<span
							class="ml-1.5 bg-ink-full px-1.5 py-0.5 align-middle text-[0.5625rem] font-bold tracking-[0.12em] text-paper"
						>
							NOW
						</span>
					{/if}
				</span>
				<span class="tabular font-mono text-[0.6875rem] font-normal text-ink-faint">
					{meal.itemCount}
					{meal.itemCount === 1 ? 'item' : 'items'}
				</span>
			</h3>

			{#if meal.categories.length === 0}
				<p class="mt-2 text-sm text-ink-faint">
					{#if filtered}
						Nothing on this menu matches the diet filters.
					{:else}
						<!-- A published menu with nothing on it is a real upstream state,
						     not an error: the meal exists, the dishes are not entered yet. -->
						This meal is published but has no dishes listed yet.
					{/if}
				</p>
			{/if}

			{#if hoisted.length > 0}
				<p
					class="mt-2 flex items-start gap-1.5 border border-rule bg-paper-sunk px-2 py-1.5 text-xs leading-relaxed text-ink-muted"
				>
					<CircleDashed class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
					<span>
						<span class="font-semibold text-ink">
							{listOf(hoisted.map((h) => h.label))} cannot be checked on this menu yet.
						</span>
						The university does not tag {hoisted.length === 1 ? 'it' : 'them'} on menu rows, and no nutrition
						label has been read for any of these {meal.itemCount} dishes. That is not the same as absent.
					</span>
				</p>
			{/if}

			{#each meal.categories as category (category.id)}
				<div class="mt-4">
					{#if category.isUncategorised}
						<!-- Upstream gave this course no name. A hairline still separates
						     it from the course above; there is just nothing to call it. -->
						<div class="rule-hair"></div>
					{:else}
						<h4 class="eyebrow rule-hair pb-0.5">{category.name}</h4>
					{/if}
					<ul>
						{#each category.items as item (item.menuItemId)}
							<ItemRow {item} hoisted={hoisted.map((h) => h.slug)} />
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	{/each}
</section>

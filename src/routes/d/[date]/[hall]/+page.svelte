<script lang="ts">
	import { page } from '$app/state';
	import DateStrip from '$lib/components/DateStrip.svelte';
	import DietFilter from '$lib/components/DietFilter.svelte';
	import VenueMenu from '$lib/components/VenueMenu.svelte';
	import { currentMeal, defaultMeal, formatCampusDate } from '$lib/dates';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The meal filter is a URL param, not component state: it survives a reload,
	// it can be linked to ("Ike at dinner"), and it costs no client JavaScript.
	const meal = $derived(page.url.searchParams.get('meal'));
	// With no ?meal= in the URL, open on the sitting being served now -- see
	// defaultMeal. An explicit choice always wins, so a shared link still lands
	// where the sender meant.
	const activeMeal = $derived(
		meal !== null && data.scope.meals.includes(meal)
			? meal
			: defaultMeal(data.scope.meals, { date: data.date, today: data.today })
	);

	const serving = $derived(
		data.scope.venues.filter((v) =>
			activeMeal === null ? v.meals.length > 0 : v.meals.some((m) => m.meal === activeMeal)
		)
	);
	const closed = $derived(
		data.scope.venues.filter((v) => !serving.some((s) => s.venue.id === v.venue.id))
	);

	/**
	 * Keeps whatever else is in the query string, so a diet filter survives
	 * switching meal or day.
	 *
	 * Built from URLSearchParams rather than a cloned URL: nothing here needs an
	 * origin, and a mutable URL derived from `page.url` is a reactivity trap.
	 */
	function withParams(path: string, overrides: Record<string, string>): string {
		// A throwaway string builder inside a pure function, not reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const params = new URLSearchParams(page.url.search);
		for (const [key, value] of Object.entries(overrides)) params.set(key, value);
		const query = params.toString();
		return query ? `${path}?${query}` : path;
	}

	function mealHref(m: string): string {
		return withParams(`/d/${data.date}/${data.scope.root.slug}`, { meal: m });
	}

	// Upstream publishes two different kinds of thing under one field: real
	// meal sittings, and all-day stations ("Beverages", "Salad Bar", "Waffle
	// Bar") that a venue like Build Your Own runs continuously. mealSort scores
	// the recognised sittings and leaves everything else at 99, so the tab bar
	// can separate them instead of presenting eleven equal-looking choices.
	const sittings = $derived(data.scope.venues.flatMap((v) => v.meals));
	const orderedMeals = $derived(
		data.scope.meals.filter((m) => sittings.some((s) => s.meal === m && s.mealSort < 99))
	);
	const stations = $derived(data.scope.meals.filter((m) => !orderedMeals.includes(m)));
	const nowServing = $derived(data.date === data.today ? currentMeal() : null);
</script>

<svelte:head>
	<title>{data.scope.root.name} — {formatCampusDate(data.date)} — uieats</title>
</svelte:head>

<DateStrip
	date={data.date}
	today={data.today}
	href={(d) =>
		withParams(`/d/${d}/${data.scope.root.slug}`, activeMeal ? { meal: activeMeal } : {})}
/>

<nav class="mt-4 mb-1 text-xs">
	<a href="/d/{data.date}" class="text-ink-faint hover:underline">All locations</a>
</nav>

<h1 class="display text-3xl">{data.scope.root.name}</h1>
<p class="eyebrow mt-1">
	{formatCampusDate(data.date)} · {data.scope.itemCount} items across {data.scope.venues.length}
	{data.scope.venues.length === 1 ? 'venue' : 'venues'}
</p>

{#if data.scope.meals.length > 1}
	<!--
		Meals tab across venues, not within one. Not every venue serves every
		meal, so a per-venue tab bar would mean ten tab bars saying different
		things -- this asks "what am I eating" once.
	-->
	<div class="mt-6">
		<div class="rule-group flex flex-wrap gap-px pb-1">
			{#each orderedMeals as m (m)}
				<a
					href={mealHref(m)}
					aria-current={m === activeMeal ? 'page' : undefined}
					class="px-3 py-1 text-xs font-bold tracking-wide uppercase
						{m === activeMeal ? 'bg-ink-full text-paper' : 'text-ink-muted hover:bg-paper-sunk'}"
				>
					{m}
					{#if m === nowServing}
						<!-- Says why the page opened here, rather than leaving it a mystery. -->
						<span class="ml-1 font-normal opacity-60">now</span>
					{/if}
				</a>
			{/each}
		</div>

		{#if stations.length > 0}
			<div class="mt-2 flex flex-wrap items-baseline gap-x-1 gap-y-1">
				<span class="eyebrow mr-1">All day</span>
				{#each stations as m (m)}
					<a
						href={mealHref(m)}
						aria-current={m === activeMeal ? 'page' : undefined}
						class="px-2 py-0.5 text-[0.6875rem] font-semibold
							{m === activeMeal ? 'bg-ink-full text-paper' : 'text-ink-faint hover:bg-paper-sunk hover:text-ink'}"
					>
						{m}
					</a>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<DietFilter tags={data.dietTags} active={data.diets} url={page.url} />

<div class="mt-8">
	{#if data.scope.itemCount === 0}
		<div class="border-2 border-ink p-4">
			<h2 class="mb-1 font-bold">No menu published here for this day</h2>
			<p class="text-sm leading-relaxed text-ink-muted">
				The university has not posted anything for {formatCampusDate(data.date)} at this location. Menus
				usually appear a week or two ahead, so try a nearer date.
			</p>
		</div>
	{/if}

	{#each serving as venueView (venueView.venue.id)}
		<VenueMenu
			venue={venueView}
			mealFilter={activeMeal}
			filtered={data.diets.length > 0}
			headingHref={data.scope.venues.length > 1
				? `/d/${data.date}/${data.scope.root.slug}/${venueView.venue.slug}`
				: null}
		/>
	{/each}

	{#if closed.length > 0}
		<section class="mt-4">
			<h2 class="eyebrow rule-hair pb-1">
				Not serving {activeMeal ? activeMeal.toLowerCase() : 'today'}
			</h2>
			<p class="mt-2 text-sm leading-relaxed text-ink-faint">
				{closed.map((v) => v.venue.name).join(' · ')}
			</p>
		</section>
	{/if}
</div>

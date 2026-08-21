<script lang="ts">
	import { page } from '$app/state';
	import DateStrip from '$lib/components/DateStrip.svelte';
	import DietFilter from '$lib/components/DietFilter.svelte';
	import VenueMenu from '$lib/components/VenueMenu.svelte';
	import { currentMeal, formatCampusDate, formatClock } from '$lib/dates';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const view = $derived(data.scope.venues[0] ?? null);
	// This page shows the whole day rather than one sitting, so the time of day
	// marks the current one instead of selecting it.
	const nowServing = $derived(data.date === data.today ? currentMeal() : null);
	const path = $derived(`${data.scope.root.slug}/${data.venue.slug}`);
</script>

<svelte:head>
	<title>{data.venue.name} — {formatCampusDate(data.date)} — uieats</title>
</svelte:head>

<DateStrip date={data.date} today={data.today} href={(d) => `/d/${d}/${path}${page.url.search}`} />

<nav class="mt-4 mb-1 flex gap-2 text-xs">
	<a href="/d/{data.date}" class="text-ink-faint hover:underline">All locations</a>
	<span class="text-rule">/</span>
	<a href="/d/{data.date}/{data.scope.root.slug}" class="text-ink-faint hover:underline">
		{data.scope.root.shortName ?? data.scope.root.name}
	</a>
</nav>

<h1 class="display text-3xl">{data.venue.name}</h1>
<p class="eyebrow mt-1">{formatCampusDate(data.date)}</p>

<DietFilter tags={data.dietTags} active={data.diets} url={page.url} />

{#if view}
	<!--
		Hours are shown with the date they were observed. The Open/Closed badge
		upstream renders is a point-in-time reading from whenever the scrape ran,
		and presenting it as current would be a claim we cannot support.
	-->
	{#if view.hours.publishesSchedule && view.hours.today.length > 0}
		<div class="rule-hair mt-6 pb-2">
			<h2 class="eyebrow mb-1">Hours published for {formatCampusDate(data.date)}</h2>
			{#if view.hours.today.every((h) => h.isClosed)}
				<p class="font-mono text-xs text-ink-muted">Closed</p>
			{:else}
				<ul class="font-mono text-xs text-ink-muted">
					{#each view.hours.today.filter((h) => !h.isClosed) as block, i (i)}
						<li>
							{#if block.opens && block.closes}
								{formatClock(block.opens)} – {formatClock(block.closes)}
							{:else}
								{block.raw}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<div class="mt-8">
		{#if view.meals.length === 0}
			<div class="border-2 border-ink p-4">
				<h2 class="mb-1 font-bold">Nothing published here for this day</h2>
				<p class="text-sm leading-relaxed text-ink-muted">
					This venue has no menu for {formatCampusDate(data.date)}. It may be closed, or the menu
					may not be posted yet.
				</p>
			</div>
		{:else if data.scope.itemCount === 0 && data.diets.length > 0}
			<div class="border-2 border-ink p-4">
				<h2 class="mb-1 font-bold">Nothing here matches those diet filters</h2>
				<p class="text-sm leading-relaxed text-ink-muted">
					This venue has a menu today, but no dish carries every tag you picked.
				</p>
			</div>
		{:else}
			<VenueMenu venue={view} showHeading={false} filtered={data.diets.length > 0} {nowServing} />
		{/if}
	</div>
{/if}

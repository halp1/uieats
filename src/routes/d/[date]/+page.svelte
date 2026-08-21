<script lang="ts">
	import DateStrip from '$lib/components/DateStrip.svelte';
	import { formatCampusDate } from '$lib/server/time';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const serving = $derived(data.halls.filter((h) => h.items > 0));
	const quiet = $derived(data.halls.filter((h) => h.items === 0));
</script>

<svelte:head>
	<title>Dining halls for {formatCampusDate(data.date)} — uieats</title>
</svelte:head>

<DateStrip date={data.date} today={data.today} href={(d) => `/d/${d}`} />

<h1 class="display mt-6 mb-8 text-4xl">
	{formatCampusDate(data.date)}
	{#if data.date === data.today}
		<span class="eyebrow ml-2 align-middle">Today</span>
	{/if}
</h1>

{#if serving.length === 0}
	<!--
		Empty because nothing was scraped for this date, not because campus is
		shut. Saying which is the difference between a useful page and a broken
		one, so the copy names the actual cause.
	-->
	<div class="border-2 border-ink p-4">
		<h2 class="mb-1 font-bold">No menus stored for this day</h2>
		<p class="text-sm leading-relaxed text-ink-muted">
			{#if data.range}
				uieats holds menus from {formatCampusDate(data.range.min)} to {formatCampusDate(
					data.range.max
				)}. Pick a day in that range, or wait for the next overnight update to reach further ahead.
			{:else}
				No menus have been collected yet. Run a scrape to populate this.
			{/if}
		</p>
	</div>
{/if}

{#each serving as hall (hall.id)}
	<section class="mb-8">
		<h2 class="rule-section flex items-baseline justify-between pb-1">
			<a href="/d/{data.date}/{hall.slug}" class="display text-2xl hover:underline">
				{hall.shortName ?? hall.name}
			</a>
			<span class="tabular font-mono text-[0.6875rem] text-ink-faint">
				{hall.items} items
			</span>
		</h2>

		{#if hall.venues.length > 0}
			<ul class="mt-2">
				{#each hall.venues as venue (venue.id)}
					<li class="rule-hair flex items-baseline justify-between gap-3 py-1.5">
						<a
							href="/d/{data.date}/{hall.slug}/{venue.slug}"
							class="text-[0.9375rem] font-medium hover:underline"
							class:text-ink-faint={venue.items === 0}
						>
							{venue.name}
						</a>
						<span class="tabular shrink-0 font-mono text-[0.6875rem] text-ink-faint">
							{#if venue.items === 0}
								no menu
							{:else}
								{venue.items}
							{/if}
						</span>
					</li>
				{/each}
			</ul>

			<p class="mt-2">
				<a href="/d/{data.date}/{hall.slug}" class="text-xs font-semibold underline">
					Show every venue at once &rarr;
				</a>
			</p>
		{:else}
			<p class="mt-2">
				<a href="/d/{data.date}/{hall.slug}" class="text-xs font-semibold underline">
					See the menu &rarr;
				</a>
			</p>
		{/if}
	</section>
{/each}

{#if quiet.length > 0}
	<section class="mt-12">
		<h2 class="eyebrow rule-hair pb-1">Nothing published for this day</h2>
		<p class="mt-2 text-sm leading-relaxed text-ink-faint">
			{quiet.map((h) => h.shortName ?? h.name).join(' · ')}
		</p>
	</section>
{/if}

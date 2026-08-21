<script lang="ts">
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import Search from '@lucide/svelte/icons/search';
	import Star from '@lucide/svelte/icons/star';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { formatCampusDate } from '$lib/dates';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Search dishes — uieats</title></svelte:head>

<h1 class="display rule-title pb-2 text-3xl">Find a dish</h1>
<p class="eyebrow mt-2">Across every hall and venue, from today onwards</p>

<!--
	A GET form, so a search is a URL. Results can be linked, bookmarked and
	reloaded, and the whole page works with JavaScript switched off.
-->
<form method="GET" class="mt-6">
	<div class="rule-group flex items-center gap-2 pb-1">
		<Search class="size-4 shrink-0 text-ink-faint" />
		<input
			type="search"
			name="q"
			value={data.query}
			placeholder="chicken, tofu, cobbler…"
			autocomplete="off"
			class="w-full border-0 bg-transparent px-0 py-1 text-lg font-medium placeholder:text-ink-faint focus:ring-0"
		/>
		<button type="submit" class="shrink-0 bg-ink-full px-3 py-1 text-xs font-bold text-paper">
			Search
		</button>
	</div>

	<div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
		{#if data.allergenCount > 0}
			<label class="flex items-center gap-1.5 text-xs font-semibold">
				<input
					type="checkbox"
					name="safe"
					value="1"
					checked={data.hideFlagged}
					class="size-3.5 rounded-none border-ink text-ink-full focus:ring-ink"
				/>
				Hide dishes flagged for my allergens
			</label>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			<span class="eyebrow">Diet</span>
			{#each data.dietTags as tag (tag.slug)}
				<label class="flex items-center gap-1 text-xs">
					<input
						type="checkbox"
						name="diet"
						value={tag.slug}
						checked={data.diets.includes(tag.slug)}
						class="size-3.5 rounded-none border-ink text-ink-full focus:ring-ink"
					/>
					{tag.label}
				</label>
			{/each}
		</div>
	</div>
</form>

{#if data.hideFlagged}
	<!--
		Said plainly, every time the filter is on. A filter that silently
		conflated "no warning" with "checked" would be the single most dangerous
		thing this app could do, so the boundary is spelled out where it is used.
	-->
	<p class="mt-4 border-l-2 border-ink pl-3 text-xs leading-relaxed text-ink-muted">
		Dishes with a warning for your allergens are hidden. Dishes whose labels have not been read yet
		are still shown, marked unverified — leaving them out would present "not checked" as "passed the
		filter".
	</p>
{/if}

<div class="mt-8">
	{#if data.query.trim().length < 2}
		<p class="text-sm text-ink-muted">Type at least two letters.</p>
	{:else if data.hits.length === 0}
		<div class="border-2 border-ink p-4">
			<h2 class="mb-1 font-bold">Nothing matching “{data.query}”</h2>
			<p class="text-sm leading-relaxed text-ink-muted">
				Search looks at dish names on menus from today onwards. Try a shorter word, or check a
				nearer date — menus only run a couple of weeks ahead.
			</p>
		</div>
	{:else}
		<p class="eyebrow mb-2">
			{data.hits.length}
			{data.hits.length === 1 ? 'dish' : 'dishes'}
		</p>
		<ul>
			{#each data.hits as hit (hit.itemId)}
				<li class="rule-hair py-2">
					<div class="flex items-baseline justify-between gap-3">
						<a href="/item/{hit.slug}" class="text-[0.9375rem] font-medium hover:underline">
							{hit.name}
							{#if hit.isFavorite}
								<Star class="mb-px inline size-3 fill-current" aria-label="Favourite" />
							{/if}
						</a>
						<span class="tabular shrink-0 font-mono text-[0.6875rem] text-ink-faint">
							{hit.servings}
							{hit.servings === 1 ? 'serving' : 'servings'}
						</span>
					</div>

					{#if hit.next}
						<div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
							<a
								href="/d/{hit.next.date}/{hit.next.hallSlug}/{hit.next.venueSlug}"
								class="font-mono text-[0.6875rem] text-ink-muted hover:underline"
							>
								{formatCampusDate(hit.next.date)} · {hit.next.meal} · {hit.next.venueName}
							</a>

							{#if hit.hasWarning}
								<span class="chip chip-likely">
									<TriangleAlert class="size-3" aria-hidden="true" />
									Flagged
								</span>
							{:else if hit.hasUnknown}
								<span class="chip chip-unknown">
									<CircleDashed class="size-3" aria-hidden="true" />
									Unverified
								</span>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

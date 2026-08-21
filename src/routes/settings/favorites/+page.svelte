<script lang="ts">
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { formatCampusDate } from '$lib/server/time';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const todayServings = $derived(data.upcoming.filter((f) => f.date === data.today));
	const laterServings = $derived(data.upcoming.filter((f) => f.date !== data.today));
</script>

<svelte:head><title>Saved dishes — uieats</title></svelte:head>

<h1 class="display rule-title pb-2 text-3xl">Saved dishes</h1>

{#if form?.removed}
	<p class="mt-4 text-sm font-semibold">Removed.</p>
{/if}

{#if data.upcoming.length === 0 && data.dormant.length === 0}
	<div class="mt-8 border-2 border-ink p-4">
		<h2 class="mb-1 font-bold">Nothing saved yet</h2>
		<p class="text-sm leading-relaxed text-ink-muted">
			Open any dish and choose Save. They will show up here whenever they are back on a menu.
		</p>
	</div>
{/if}

{#snippet servingList(servings: PageData['upcoming'], heading: string, showDate: boolean)}
	<section class="mt-8">
		<h2 class="eyebrow rule-group pb-1">{heading}</h2>
		<ul class="mt-1">
			{#each servings as serving (serving.itemId + serving.date + serving.venueSlug)}
				<li class="rule-hair py-2">
					<div class="flex items-baseline justify-between gap-3">
						<a href="/item/{serving.slug}" class="text-[0.9375rem] font-medium hover:underline">
							{serving.name}
						</a>
						{#if serving.hasWarning}
							<span class="chip chip-likely shrink-0">
								<TriangleAlert class="size-3" aria-hidden="true" />
								Flagged
							</span>
						{:else if serving.hasUnknown}
							<span class="chip chip-unknown shrink-0">
								<CircleDashed class="size-3" aria-hidden="true" />
								Unverified
							</span>
						{/if}
					</div>
					<a
						href="/d/{serving.date}/{serving.hallSlug}/{serving.venueSlug}"
						class="font-mono text-[0.6875rem] text-ink-muted hover:underline"
					>
						{#if showDate}{formatCampusDate(serving.date)} ·
						{/if}{serving.meal} · {serving.venueName}
					</a>
				</li>
			{/each}
		</ul>
	</section>
{/snippet}

{#if todayServings.length > 0}
	{@render servingList(todayServings, 'On today', false)}
{/if}

{#if laterServings.length > 0}
	{@render servingList(laterServings, 'Coming up this week', true)}
{/if}

{#if data.dormant.length > 0}
	<section class="mt-10">
		<h2 class="eyebrow rule-group pb-1">Not on a menu right now</h2>
		<ul class="mt-1">
			{#each data.dormant as item (item.item_id)}
				<li class="rule-hair flex items-baseline justify-between gap-3 py-1.5">
					<a href="/item/{item.slug}" class="text-sm hover:underline">{item.name_display}</a>
					<form method="POST" action="?/remove" class="shrink-0">
						<input type="hidden" name="itemId" value={item.item_id} />
						<button type="submit" class="text-[0.6875rem] font-semibold text-ink-muted underline">
							Remove
						</button>
					</form>
				</li>
			{/each}
		</ul>
	</section>
{/if}

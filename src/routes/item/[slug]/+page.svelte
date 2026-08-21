<script lang="ts">
	import Star from '@lucide/svelte/icons/star';
	import { enhance } from '$app/forms';
	import AllergenChip from '$lib/components/AllergenChip.svelte';
	import Disclaimer from '$lib/components/Disclaimer.svelte';
	import NutritionPanel from '$lib/components/NutritionPanel.svelte';
	import { formatCampusDate } from '$lib/dates';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const detail = $derived(data.detail);
	// Allergens are recorded per appearance, so the evidence shown is the
	// evidence for a specific serving -- the one with a label if there is one.
	const shown = $derived(detail.primary ?? detail.nextServed);
	const verdicts = $derived(shown?.allergens?.verdicts ?? []);
	const upcoming = $derived(detail.appearances.slice(0, 12));
</script>

<svelte:head><title>{detail.item.name} — uieats</title></svelte:head>

<div class="rule-title flex items-start justify-between gap-4 pb-2">
	<h1 class="display text-3xl">{detail.item.name}</h1>

	{#if data.user}
		<form method="POST" action="?/favorite" use:enhance>
			<input type="hidden" name="on" value={detail.isFavorite ? 'false' : 'true'} />
			<button
				type="submit"
				class="flex shrink-0 items-center gap-1 border border-ink px-2 py-1 text-xs font-semibold hover:bg-paper-sunk"
			>
				<Star class="size-3.5 {detail.isFavorite ? 'fill-current' : ''}" />
				{detail.isFavorite ? 'Saved' : 'Save'}
			</button>
		</form>
	{/if}
</div>

{#if shown === null}
	<p class="mt-6 text-sm text-ink-muted">
		This dish is in the catalogue but is not on any menu from yesterday onwards.
	</p>
{:else}
	<p class="eyebrow mt-2">
		{#if shown.date === data.today}Served today{:else}Next served {formatCampusDate(
				shown.date
			)}{/if}
		· {shown.meal} · {shown.venueName}
	</p>

	<!-- ---- Allergens: the reason anyone opens this page ---------------- -->
	<section class="mt-8">
		<h2 class="rule-section pb-1 text-lg font-bold">Your allergens</h2>

		{#if !data.user}
			<p class="mt-3 text-sm leading-relaxed text-ink-muted">
				<a href="/auth/login" class="font-semibold text-ink underline">Sign in</a>
				and register your allergens to have them checked against this dish.
			</p>
		{:else if verdicts.length === 0}
			<p class="mt-3 text-sm leading-relaxed text-ink-muted">
				You have not registered any allergens yet.
				<a href="/settings/allergens" class="font-semibold text-ink underline">Choose some</a>
				and they will be checked on every dish.
			</p>
		{:else}
			<!--
				Every verdict, with its evidence spelled out. This is the audit
				surface: the chip on a menu row is a summary, and this is where a
				user can see exactly which sentence in upstream's data produced it.
			-->
			<ul class="mt-3">
				{#each verdicts as verdict (verdict.allergen.slug)}
					<li class="rule-hair flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-3">
						<div class="shrink-0 sm:w-56">
							<AllergenChip {verdict} />
						</div>
						<div class="min-w-0 flex-1">
							<p class="text-xs leading-relaxed text-ink-muted">{verdict.basis}</p>
							{#if verdict.evidence.length > 1}
								<ul class="mt-1 space-y-0.5">
									{#each verdict.evidence.slice(1) as e (e.source + e.slug)}
										<!-- The evidence string names its own source, so a
										     "{source}:" prefix here would double it. -->
										<li class="font-mono text-[0.6875rem] text-ink-faint">
											also — {e.text}
										</li>
									{/each}
								</ul>
							{/if}
							<!--
								verdict.advisory is deliberately NOT rendered here. It is a
								property of the label, not of each allergen, so on a page
								showing five verdicts it would print the same sentence five
								times. The Ingredients section below states it once, where the
								terms themselves are visible.
							-->
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		{#if !shown.hasLabel}
			<p class="mt-3 border-2 border-dashed border-rule p-3 text-xs leading-relaxed text-ink-muted">
				No nutrition label has been fetched for this serving yet, so anything not tagged on the menu
				row itself is genuinely unknown rather than absent. Labels are collected overnight, soonest
				meals first.
			</p>
		{/if}
	</section>

	<!-- ---- Traits upstream put on the menu row ------------------------- -->
	{#if shown.traits.length > 0}
		<section class="mt-10">
			<h2 class="rule-group pb-1 text-base font-bold">Tagged by the university</h2>
			<div class="mt-2 flex flex-wrap gap-1">
				{#each shown.traits as trait (trait.slug)}
					<span class="chip {trait.isDiet ? 'chip-diet' : 'chip-declared'}">{trait.label}</span>
				{/each}
			</div>
			<p class="mt-2 text-xs text-ink-faint">
				These are the icons on the university's own menu row. The dark ones are allergens; the grey
				ones are dietary tags.
			</p>
		</section>
	{/if}

	<!-- ---- Nutrition and ingredients ----------------------------------- -->
	<section class="mt-10 grid gap-8 sm:grid-cols-2">
		<div>
			{#if shown.nutrition}
				<NutritionPanel facts={shown.nutrition} />
			{:else}
				<div class="border-2 border-dashed border-rule p-4">
					<h2 class="mb-1 font-bold">No nutrition label yet</h2>
					<p class="text-sm leading-relaxed text-ink-muted">
						This serving has not been fetched. The label lives one click deep on the university's
						site and uieats collects them overnight.
					</p>
				</div>
			{/if}
		</div>

		<div>
			<h2 class="rule-group pb-1 text-base font-bold">Ingredients</h2>
			{#if shown.nutrition?.containsText}
				<p class="mt-2 text-sm">
					<span class="eyebrow">Contains</span>
					<span class="ml-1 font-semibold">{shown.nutrition.containsText}</span>
				</p>
			{/if}

			{#if shown.nutrition?.components && shown.nutrition.components.length > 0}
				<!--
					Rendered as the recipe's components rather than one wall of capitals.
					Upstream writes "MIX CAKE YELLOW GOLD MEDAL (ENRICHED FLOUR ...)",
					and keeping that structure is what makes a long list readable.
				-->
				<ul class="mt-3 space-y-2">
					{#each shown.nutrition.components as component, i (i)}
						<li>
							<p class="text-xs font-semibold">{component.componentName}</p>
							{#if component.ingredientText}
								<p class="font-mono text-[0.6875rem] leading-relaxed text-ink-muted">
									{component.ingredientText}
								</p>
							{/if}
						</li>
					{/each}
				</ul>
			{:else if shown.nutrition?.ingredientsText}
				<p class="mt-2 font-mono text-[0.6875rem] leading-relaxed text-ink-muted">
					{shown.nutrition.ingredientsText}
				</p>
			{:else}
				<p class="mt-2 text-sm text-ink-faint">
					No ingredient list has been read for this serving.
				</p>
			{/if}

			{#if shown.nutrition?.hiddenSources.length}
				<p class="mt-3 border-l-2 border-ink pl-2 text-xs leading-relaxed text-ink-muted">
					This list uses umbrella terms — {shown.nutrition.hiddenSources.join(', ')} — which are allowed
					to stand in for ingredients they do not name. An allergen can hide inside one, so every grey
					chip above is weaker than it looks.
				</p>
			{/if}
		</div>
	</section>
{/if}

<!-- ---- Where else it turns up ---------------------------------------- -->
{#if upcoming.length > 1}
	<section class="mt-12">
		<h2 class="rule-group pb-1 text-base font-bold">Also served</h2>
		<ul class="mt-1">
			{#each upcoming as a (a.menuItemId)}
				<li class="rule-hair flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
					<a
						href="/d/{a.date}/{a.hallSlug}/{a.venueSlug}"
						class="text-sm font-medium hover:underline"
					>
						{a.venueName}
					</a>
					<span class="tabular font-mono text-[0.6875rem] text-ink-faint">
						{formatCampusDate(a.date)} · {a.meal}
						{#if !a.hasLabel}
							· <span class="font-semibold">unverified</span>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
		<p class="mt-2 text-xs leading-relaxed text-ink-faint">
			Each serving carries its own label. The same dish name at a different venue can be a different
			recipe, so allergens are never merged across appearances.
		</p>
	</section>
{/if}

<div class="mt-12">
	<Disclaimer />
</div>

<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import type { AllergenTreeNode } from '$lib/server/queries/allergens';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// SvelteSet, not Set: these are mutated in place by the checkbox handlers,
	// and a plain Set's .add() is invisible to the reactivity system -- the
	// "(N on)" counts would silently stop updating.
	//
	// Which group is open. The form itself is a plain POST; this only controls
	// disclosure.
	const expanded = new SvelteSet<number>();

	// Mirrors what is ticked, so the counts and collapsed children stay honest
	// while editing. Re-synced whenever the server sends a new selection -- after
	// a save, or a navigation -- and otherwise left alone so in-progress edits
	// survive.
	const chosen = new SvelteSet<number>();
	$effect.pre(() => {
		chosen.clear();
		for (const id of data.selected) chosen.add(id);
	});

	function toggleExpanded(id: number) {
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
	}

	function selectedChildren(node: AllergenTreeNode): number {
		return node.children.reduce(
			(sum, child) => sum + (chosen.has(child.id) ? 1 : 0) + selectedChildren(child),
			0
		);
	}
</script>

<svelte:head><title>Your allergens — uieats</title></svelte:head>

<h1 class="display rule-title pb-2 text-3xl">Your allergens</h1>

{#if data.welcome}
	<p class="mt-4 border-l-2 border-ink pl-3 text-sm leading-relaxed">
		Your account is ready. Pick what to be warned about and every dish on every menu will be marked
		against it.
	</p>
{/if}

<p class="mt-4 text-sm leading-relaxed text-ink-muted">
	Choosing a group covers everything under it: <span class="font-semibold text-ink">Tree Nuts</span>
	catches an ingredient list that names macadamia without ever saying "tree nut". Pick a single species
	instead if that is the one you react to.
</p>

<form method="POST" class="mt-8">
	{#each data.tree as node (node.id)}
		<div class="rule-hair py-2">
			<div class="flex items-center gap-3">
				<label class="flex flex-1 items-center gap-2 text-[0.9375rem] font-medium">
					<input
						type="checkbox"
						name="allergen"
						value={node.id}
						checked={chosen.has(node.id)}
						onchange={(e) => {
							if (e.currentTarget.checked) chosen.add(node.id);
							else chosen.delete(node.id);
						}}
						class="size-4 rounded-none border-2 border-ink text-ink-full focus:ring-ink"
					/>
					{node.label}
					{#if !node.coveredByTraitVocabulary}
						<!--
							The honest caveat, on exactly the allergens it applies to.
							Upstream tags 18 allergens on every menu row; for the rest the
							only evidence is the ingredient text, which means an unlabelled
							dish is genuinely unknown rather than clear.
						-->
						<span class="chip chip-unknown" title="Upstream never declares this one directly.">
							ingredients only
						</span>
					{/if}
				</label>

				{#if node.children.length > 0}
					<button
						type="button"
						onclick={() => toggleExpanded(node.id)}
						class="shrink-0 text-[0.6875rem] font-semibold text-ink-muted underline"
					>
						{expanded.has(node.id) ? 'Hide' : `${node.children.length} species`}
						{#if selectedChildren(node) > 0}
							<span class="not-underline">({selectedChildren(node)} on)</span>
						{/if}
					</button>
				{/if}
			</div>

			{#if expanded.has(node.id)}
				<div class="mt-2 ml-6 flex flex-wrap gap-x-4 gap-y-1">
					{#each node.children as child (child.id)}
						<label class="flex items-center gap-1.5 text-xs">
							<input
								type="checkbox"
								name="allergen"
								value={child.id}
								checked={chosen.has(child.id)}
								onchange={(e) => {
									if (e.currentTarget.checked) chosen.add(child.id);
									else chosen.delete(child.id);
								}}
								class="size-3.5 rounded-none border-ink text-ink-full focus:ring-ink"
							/>
							{child.label}
						</label>
					{/each}
				</div>
			{/if}
		</div>
	{/each}

	<h2 class="eyebrow rule-group mt-10 pb-1">Diet filters</h2>
	<p class="mt-2 text-xs leading-relaxed text-ink-faint">
		These are the university's own dietary tags. They filter menus and never produce a warning.
	</p>
	<div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">
		{#each data.dietTags as tag (tag.id)}
			<label class="flex items-center gap-1.5 text-xs">
				<input
					type="checkbox"
					name="allergen"
					value={tag.id}
					checked={chosen.has(tag.id)}
					onchange={(e) => {
						if (e.currentTarget.checked) chosen.add(tag.id);
						else chosen.delete(tag.id);
					}}
					class="size-3.5 rounded-none border-ink text-ink-full focus:ring-ink"
				/>
				{tag.label}
			</label>
		{/each}
	</div>

	<div class="mt-8 flex items-center gap-4">
		<button type="submit" class="bg-ink-full px-5 py-2.5 text-sm font-bold text-paper">
			Save
		</button>
		{#if form?.saved}
			<p class="text-sm font-semibold">
				Saved — {form.count}
				{form.count === 1 ? 'allergen' : 'allergens'} will be checked on every dish.
			</p>
		{/if}
	</div>
</form>

<div class="mt-12 border-2 border-ink p-4">
	<h2 class="eyebrow mb-2">What a chip actually means</h2>
	<dl class="space-y-2 text-xs leading-relaxed text-ink-muted">
		<div class="flex flex-wrap items-baseline gap-2">
			<dt class="chip chip-declared shrink-0">Milk</dt>
			<dd>The university's own label or menu icon says so.</dd>
		</div>
		<div class="flex flex-wrap items-baseline gap-2">
			<dt class="chip chip-likely shrink-0">Mustard</dt>
			<dd>Named in the ingredient list, though upstream did not tag it.</dd>
		</div>
		<div class="flex flex-wrap items-baseline gap-2">
			<dt class="chip chip-possible shrink-0">Peanuts</dt>
			<dd>Only the dish name suggests it. The weakest signal here.</dd>
		</div>
		<div class="flex flex-wrap items-baseline gap-2">
			<dt class="chip chip-unknown shrink-0">Celery unverified</dt>
			<dd>
				Nothing has been read that could have shown it — no label yet, and upstream never tags this
				one. Not the same as absent.
			</dd>
		</div>
		<div class="flex flex-wrap items-baseline gap-2">
			<dt class="chip chip-none shrink-0">No Milk declared</dt>
			<dd>Read, and not found. Still not a guarantee about what is on the serving line.</dd>
		</div>
	</dl>
</div>

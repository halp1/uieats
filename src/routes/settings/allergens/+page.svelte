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

<form method="POST" action="?/save" class="mt-8">
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

<section class="mt-14">
	<h2 class="rule-group pb-1 text-lg font-bold">Something not on the list</h2>
	<p class="mt-3 text-sm leading-relaxed text-ink-muted">
		Add anything you react to. uieats will look for it in the ingredient text of every dish whose
		label it has read.
	</p>
	<p class="mt-2 border-l-2 border-ink pl-3 text-xs leading-relaxed text-ink-muted">
		<strong class="font-semibold text-ink">These can only ever be found in the ingredients.</strong>
		The university tags 18 allergens on its menu rows; yours is not one of them, so on any dish whose
		label has not been read yet the honest answer is
		<span class="chip chip-unknown align-middle">unverified</span> rather than a clean result.
	</p>

	{#if data.custom.length > 0}
		<ul class="mt-5">
			{#each data.custom as entry (entry.id)}
				<li class="rule-hair flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
					<div class="min-w-0">
						<p class="text-[0.9375rem] font-medium">{entry.label}</p>
						<p class="font-mono text-[0.6875rem] text-ink-faint">
							looks for: {entry.terms.join(', ')}
						</p>
					</div>
					<form method="POST" action="?/removeCustom" class="shrink-0">
						<input type="hidden" name="id" value={-entry.id} />
						<button
							type="submit"
							class="border border-ink px-2 py-0.5 text-[0.6875rem] font-semibold hover:bg-paper-sunk"
						>
							Remove
						</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	{#if data.custom.length < data.limits.maxCustom}
		<form method="POST" action="?/addCustom" class="mt-5">
			<div class="flex flex-wrap items-end gap-3">
				<label class="min-w-40 flex-1">
					<span class="eyebrow block">Name</span>
					<input
						name="label"
						type="text"
						required
						maxlength={data.limits.maxLabel}
						placeholder="Kiwi"
						class="mt-1 w-full border-0 border-b-2 border-ink bg-transparent px-0 py-1.5 text-sm focus:ring-0"
					/>
				</label>
				<label class="min-w-56 flex-[2]">
					<span class="eyebrow block">Words to look for (optional)</span>
					<input
						name="terms"
						type="text"
						placeholder="kiwi, kiwifruit"
						class="mt-1 w-full border-0 border-b-2 border-ink bg-transparent px-0 py-1.5 text-sm focus:ring-0"
					/>
				</label>
				<button type="submit" class="bg-ink-full px-4 py-2 text-sm font-bold text-paper">Add</button
				>
			</div>
			<p class="mt-2 text-xs leading-relaxed text-ink-faint">
				Leave the second box empty and the name is used. Give a comma-separated list when one word
				will not find it — <span class="font-mono">nightshade</span> appears on no label, whereas
				<span class="font-mono">tomato, potato, aubergine, paprika</span> does. At least
				{data.limits.minTerm} letters each.
			</p>
		</form>
	{:else}
		<p class="mt-4 text-sm text-ink-muted">
			You have reached the limit of {data.limits.maxCustom}. Remove one to add another.
		</p>
	{/if}

	{#if form && 'customError' in form && form.customError}
		<p class="mt-4 border-l-2 border-ink pl-3 text-sm">{form.customError}</p>
	{/if}
	{#if form && 'customAdded' in form && form.customAdded}
		<p class="mt-4 text-sm font-semibold">
			Added {form.customAdded} — looking for {form.terms?.join(', ')}.
		</p>
	{/if}
	{#if form && 'customRemoved' in form && form.customRemoved}
		<p class="mt-4 text-sm font-semibold">Removed.</p>
	{/if}
</section>

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
			<dt class="chip chip-may-contain shrink-0">May contain Tree Nuts</dt>
			<dd>
				Upstream's own cross-contact advisory — shared equipment, not an ingredient. Only you can
				say whether that is close enough to matter.
			</dd>
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

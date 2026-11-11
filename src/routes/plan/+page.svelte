<script lang="ts">
	import DateStrip from '$lib/components/DateStrip.svelte';
	import TargetMeter from '$lib/components/TargetMeter.svelte';
	import { formatCampusDate } from '$lib/dates';
	import { ROLE_LABELS } from '$lib/planner/roles';
	import {
		plannerHref,
		plannerQuery,
		replan,
		WANT_STEPS,
		type PlannerState
	} from '$lib/planner/state';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const state = $derived(data.state as PlannerState);
	const plan = $derived(data.result?.plan ?? null);
	const here = $derived(plannerHref(state));

	/**
	 * Hidden inputs carrying the rest of the state, for the two GET forms. A GET
	 * form replaces the whole query string, so anything not re-sent is lost.
	 */
	function carried(omit: string[]): [string, string][] {
		const params = new URLSearchParams(plannerQuery({ ...state, option: 0 }));
		return [...params.entries()].filter(([k]) => !omit.includes(k));
	}

	function toggleDiet(slug: string): string {
		const diets = state.diets.includes(slug)
			? state.diets.filter((d) => d !== slug)
			: [...state.diets, slug];
		return replan(state, { diets });
	}

	function removeHref(itemId: number, menuItemId: number, wanted: boolean): string {
		if (wanted) {
			return replan(state, { wanted: state.wanted.filter((w) => w.menuItemId !== menuItemId) });
		}
		return replan(state, { excluded: [...state.excluded, itemId] });
	}

	function keepHref(menuItemId: number, multiplier: number): string {
		return replan(state, { wanted: [...state.wanted, { menuItemId, multiplier }] });
	}

	function stepHref(menuItemId: number, direction: -1 | 1): string | null {
		const current = state.wanted.find((w) => w.menuItemId === menuItemId);
		if (!current) return null;
		const steps = WANT_STEPS as readonly number[];
		const next = steps[steps.indexOf(current.multiplier) + direction];
		if (next === undefined) return null;
		return replan(state, {
			wanted: state.wanted.map((w) =>
				w.menuItemId === menuItemId ? { ...w, multiplier: next } : w
			)
		});
	}

	function putBackHref(itemId: number): string {
		return replan(state, { excluded: state.excluded.filter((x) => x !== itemId) });
	}

	const wantedIds = $derived(new Set(state.wanted.map((w) => w.menuItemId)));

	/** The picker: one entry per dish and calorie count, grouped by venue. */
	const choiceGroups = $derived.by(() => {
		// Local builders, rebuilt whole on each derivation -- not reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const seen = new Set<string>();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const groups = new Map<string, NonNullable<typeof data.result>['choices']>();
		for (const c of data.result?.choices ?? []) {
			const key = `${c.name}|${c.calories}`;
			if (seen.has(key) || wantedIds.has(c.menuItemId)) continue;
			seen.add(key);
			const group = c.station === data.menu?.meal ? c.venue : `${c.venue} — ${c.station}`;
			const bucket = groups.get(group) ?? [];
			bucket.push(c);
			groups.set(group, bucket);
		}
		return [...groups.entries()];
	});

	/** One-tap adds for the things people most often want regardless. */
	const treats = $derived.by(() => {
		// A local builder, as above.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const seen = new Set<string>();
		return (data.result?.choices ?? [])
			.filter((c) => c.role === 'dessert' && !wantedIds.has(c.menuItemId))
			.filter((c) => {
				if (seen.has(c.name)) return false;
				seen.add(c.name);
				return true;
			})
			.slice(0, 10);
	});

	const t = $derived(data.mealTargets);
	const meals = $derived(data.targets.day.calories / Math.max(1, data.targets.meal.calories));
	const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
	const g = (n: number) => `${Math.round(n)}`;
</script>

<svelte:head>
	<title>Meal planner — uieats</title>
</svelte:head>

<h1 class="display rule-title pb-2 text-3xl">Meal planner</h1>
<p class="eyebrow mt-2">
	{formatCampusDate(state.date ?? data.today)}{#if data.hall}
		· {data.hall.name}{/if}{#if data.menu?.meal}
		· {data.menu.meal}{/if}
</p>

<!-- Targets ----------------------------------------------------------- -->
<section class="mt-6 border-2 border-ink p-4">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 class="eyebrow">This meal's target</h2>
		<a href="/plan/profile?next={encodeURIComponent(here)}" class="text-xs font-semibold underline">
			{data.hasBody ? 'Edit your body info' : 'Enter your body info'}
		</a>
	</div>
	<p class="tabular mt-2 text-lg leading-snug font-bold">
		{fmt(t.calories)} cal · {g(t.proteinG)} g protein · {g(t.carbG)} g carbs · {g(t.fatG)} g fat
	</p>
	<p class="mt-1 font-mono text-[0.6875rem] text-ink-faint">
		{fmt(data.targets.day.calories)} cal and {g(data.targets.day.proteinG)} g protein a day, split across
		{Math.round(meals)} meals{#if data.reserve > 0}, minus {fmt(data.reserve)} cal saved for later{/if}
	</p>

	{#if !data.hasBody}
		<p class="mt-3 border-l-2 border-ink pl-3 text-xs leading-relaxed text-ink-muted">
			These are the 2,000-calorie reference day printed on every nutrition label, not your numbers.
			<a
				href="/plan/profile?next={encodeURIComponent(here)}"
				class="font-semibold text-ink underline">Add your height, weight and goal</a
			> and the planner will size the meal for you.
		</p>
	{/if}

	{#each data.targets.notes as note (note)}
		<p class="mt-2 text-xs leading-relaxed text-ink-muted">{note}</p>
	{/each}
</section>

<!-- Where and when ------------------------------------------------------ -->
<div class="mt-6">
	<DateStrip
		date={state.date ?? data.today}
		today={data.today}
		href={(d) => replan(state, { date: d, excluded: [], wanted: [] })}
	/>
</div>

<section class="mt-5">
	<h2 class="eyebrow mb-1">Where are you eating?</h2>
	{#if data.halls.length === 0}
		<p class="text-sm text-ink-muted">Nothing is on the menu anywhere for this day.</p>
	{:else}
		<div class="flex flex-wrap gap-1">
			{#each data.halls as h (h.slug)}
				<a
					href={replan(state, { hall: h.slug, meal: null, excluded: [], wanted: [] })}
					aria-current={h.slug === data.hall?.slug ? 'page' : undefined}
					class="border px-2 py-1 text-xs font-semibold
						{h.slug === data.hall?.slug
						? 'border-ink-full bg-ink-full text-paper'
						: 'border-ink hover:bg-paper-sunk'}"
				>
					{h.shortName ?? h.name}
				</a>
			{/each}
		</div>
	{/if}
</section>

{#if data.menu && data.menu.sittings.length > 0}
	<div class="rule-group mt-5 flex flex-wrap gap-px pb-1">
		{#each data.menu.sittings as m (m)}
			<a
				href={replan(state, { meal: m, wanted: [] })}
				aria-current={m === data.menu.meal ? 'page' : undefined}
				class="px-3 py-1 text-xs font-bold tracking-wide uppercase
					{m === data.menu.meal ? 'bg-ink-full text-paper' : 'text-ink-muted hover:bg-paper-sunk'}"
			>
				{m}
			</a>
		{/each}
	</div>
	{#if data.menu.stations.length > 0}
		<p class="mt-1 text-[0.6875rem] text-ink-faint">
			Includes the all-day stations: {data.menu.stations.join(' · ')}
		</p>
	{/if}
{/if}

{#if data.hall}
	<!-- Filters -->
	<div class="mt-4 flex flex-wrap items-center gap-x-1 gap-y-1">
		<span class="eyebrow mr-1">Filters</span>
		<a
			href={replan(state, { skipSaladBar: !state.skipSaladBar })}
			aria-current={state.skipSaladBar ? 'true' : undefined}
			class="px-2 py-0.5 text-[0.6875rem] font-semibold
				{state.skipSaladBar
				? 'bg-ink-full text-paper'
				: 'text-ink-faint hover:bg-paper-sunk hover:text-ink'}"
		>
			Skip the salad bar
		</a>
		{#each data.dietTags.filter( (d) => ['vegetarian', 'vegan', 'halal', 'kosher', 'jain'].includes(d.slug) ) as tag (tag.slug)}
			{@const on = state.diets.includes(tag.slug)}
			<a
				href={toggleDiet(tag.slug)}
				aria-current={on ? 'true' : undefined}
				class="px-2 py-0.5 text-[0.6875rem] font-semibold
					{on ? 'bg-ink-full text-paper' : 'text-ink-faint hover:bg-paper-sunk hover:text-ink'}"
			>
				{tag.label}
			</a>
		{/each}
	</div>

	<form method="GET" action="/plan" class="mt-3 flex flex-wrap items-end gap-3">
		{#each carried(['reserve']) as [name, value], i (i)}
			<input type="hidden" {name} {value} />
		{/each}
		<label class="text-xs">
			<span class="eyebrow block">Saving room for something later?</span>
			<span class="mt-1 flex items-baseline gap-2">
				<input
					type="number"
					name="reserve"
					min="0"
					max="1500"
					step="10"
					value={data.reserve || ''}
					placeholder="0"
					class="w-24 border-0 border-b-2 border-ink bg-transparent px-0 py-1 text-sm focus:ring-0"
				/>
				<span class="text-ink-muted">cal off this meal's target</span>
			</span>
		</label>
		<button
			type="submit"
			class="border border-ink px-2 py-1 text-[0.6875rem] font-semibold hover:bg-paper-sunk"
		>
			Update
		</button>
	</form>
{/if}

{#if !data.hall}
	<p class="mt-8 text-sm leading-relaxed text-ink-muted">
		Pick a dining hall above and the planner will build a balanced plate from what it is serving.
	</p>
{:else if data.result}
	{@const result = data.result}

	<!-- What the user wants regardless ------------------------------------ -->
	<section class="mt-10">
		<h2 class="rule-group pb-1 text-lg font-bold">Something you want anyway</h2>
		<p class="mt-2 text-sm leading-relaxed text-ink-muted">
			A dessert, the soft serve, a drink. Add it here and the rest of the plate is planned around
			it.
		</p>

		{#if treats.length > 0}
			<div class="mt-3 flex flex-wrap gap-1">
				{#each treats as c (c.menuItemId)}
					<a
						href={keepHref(c.menuItemId, 1)}
						class="border border-ink px-2 py-0.5 text-[0.6875rem] font-semibold hover:bg-paper-sunk"
					>
						+ {c.name} <span class="font-normal text-ink-faint">{Math.round(c.calories)} cal</span>
					</a>
				{/each}
			</div>
		{/if}

		{#if choiceGroups.length > 0}
			<form method="GET" action="/plan" class="mt-3 flex flex-wrap items-end gap-2">
				{#each carried([]) as [name, value], i (i)}
					<input type="hidden" {name} {value} />
				{/each}
				<label class="min-w-0 flex-1">
					<span class="eyebrow block">Anything on the menu</span>
					<select
						name="want"
						required
						class="mt-1 w-full border-0 border-b-2 border-ink bg-transparent px-0 py-1.5 text-sm focus:ring-0"
					>
						<option value="">Choose a dish…</option>
						{#each choiceGroups as [group, items] (group)}
							<optgroup label={group}>
								{#each items as c (c.menuItemId)}
									<option value={c.menuItemId}>
										{c.name} — {c.serving ?? 'serving'}, {Math.round(c.calories)} cal
									</option>
								{/each}
							</optgroup>
						{/each}
					</select>
				</label>
				<button type="submit" class="bg-ink-full px-4 py-2 text-xs font-bold text-paper">Add</button
				>
			</form>
		{/if}
	</section>

	<!-- The plan ----------------------------------------------------------- -->
	<section class="mt-10">
		<div class="rule-section flex flex-wrap items-baseline justify-between gap-2 pb-1">
			<h2 class="display text-2xl">Your plate</h2>
			{#if result.optionCount > 1}
				<a
					href={plannerHref(state, { option: (result.option + 1) % result.optionCount })}
					class="text-xs font-semibold underline"
				>
					Show another option ({result.option + 1} of {result.optionCount}) &rarr;
				</a>
			{/if}
		</div>

		{#each result.notes as note (note)}
			<p class="mt-3 border-l-2 border-ink pl-3 text-xs leading-relaxed text-ink-muted">{note}</p>
		{/each}

		{#if !plan}
			<div class="mt-4 border-2 border-ink p-4">
				<h3 class="mb-1 font-bold">Nothing to plan from</h3>
				<p class="text-sm leading-relaxed text-ink-muted">
					{#if data.menu?.meal === null}
						This location has no menu published for {formatCampusDate(state.date ?? data.today)}.
					{:else}
						No dish here passed the filters and label checks for this sitting. Try putting removed
						dishes back, turning a filter off, or another hall.
					{/if}
				</p>
			</div>
		{:else}
			<ul>
				{#each plan.lines as l (l.item.menuItemId)}
					<li class="rule-hair py-2.5">
						<div class="flex items-baseline gap-3">
							<div class="min-w-0 flex-1">
								<a
									href="/item/{l.item.slug}"
									class="text-[0.9375rem] leading-snug font-semibold hover:underline"
								>
									{l.item.name}
								</a>
								<p class="mt-0.5 text-[0.6875rem] text-ink-faint">
									<span class="chip chip-diet mr-1 px-1 py-0 text-[0.625rem]">
										{l.wanted ? 'Your pick' : ROLE_LABELS[l.item.role]}
									</span>
									{l.item.venue}{#if l.item.station !== data.menu?.meal}
										· {l.item.station}{/if}
								</p>
							</div>
							<div class="shrink-0 text-right">
								<p class="text-sm font-bold">{l.portion}</p>
								<p class="tabular font-mono text-[0.6875rem] text-ink-faint">
									{[
										l.multiplier !== 1
											? `${l.multiplier} × ${l.item.servingText ?? 'serving'}`
											: null,
										l.grams ? `~${l.grams} g` : null
									]
										.filter(Boolean)
										.join(' · ')}
								</p>
							</div>
						</div>

						<div class="mt-1 flex flex-wrap items-baseline justify-between gap-2">
							<p class="tabular font-mono text-[0.6875rem]">
								<span class="font-semibold">{Math.round(l.nutrients.calories)} cal</span>
								<span class="text-ink-muted">
									· {g(l.nutrients.proteinG)}g protein · {g(l.nutrients.carbG)}g carbs · {g(
										l.nutrients.fatG
									)}g fat
								</span>
							</p>
							<div class="flex items-center gap-2 text-[0.6875rem] font-semibold">
								{#if l.wanted}
									{@const less = stepHref(l.item.menuItemId, -1)}
									{@const more = stepHref(l.item.menuItemId, 1)}
									<span class="text-ink-faint">Servings</span>
									{#if less}<a
											href={less}
											class="border border-ink px-1.5 hover:bg-paper-sunk"
											aria-label="Less">−</a
										>{/if}
									<span class="tabular">{l.multiplier}</span>
									{#if more}<a
											href={more}
											class="border border-ink px-1.5 hover:bg-paper-sunk"
											aria-label="More">+</a
										>{/if}
								{:else}
									<a
										href={keepHref(l.item.menuItemId, l.multiplier)}
										class="underline"
										title="Keep this and re-plan the rest around it"
									>
										Keep
									</a>
								{/if}
								<a
									href={removeHref(l.item.itemId, l.item.menuItemId, l.wanted)}
									class="underline"
									title="Leave this out and re-plan"
								>
									Remove
								</a>
							</div>
						</div>
					</li>
				{/each}
			</ul>

			<div class="mt-6">
				<h3 class="eyebrow rule-group pb-1">Totals against this meal's target</h3>
				<TargetMeter label="Calories" value={plan.totals.calories} target={t.calories} unit="" />
				<TargetMeter label="Protein" value={plan.totals.proteinG} target={t.proteinG} unit="g" />
				<TargetMeter label="Carbohydrate" value={plan.totals.carbG} target={t.carbG} unit="g" />
				<TargetMeter label="Fat" value={plan.totals.fatG} target={t.fatG} unit="g" />
				<TargetMeter
					label="Fiber"
					value={plan.totals.fiberG}
					target={t.fiberG}
					unit="g"
					blank={plan.totals.blanks.includes('fiberG')}
				/>
				<TargetMeter
					label="Sodium"
					value={plan.totals.sodiumMg}
					target={t.sodiumMg}
					unit="mg"
					kind="limit"
					blank={plan.totals.blanks.includes('sodiumMg')}
				/>
				<TargetMeter
					label="Saturated fat"
					value={plan.totals.satFatG}
					target={t.satFatG}
					unit="g"
					kind="limit"
					blank={plan.totals.blanks.includes('satFatG')}
				/>
				{#if plan.totals.blanks.length > 0}
					<p class="mt-2 text-[0.6875rem] text-ink-faint">
						* At least one dish's label left this blank, so the real total is somewhat higher.
					</p>
				{/if}
			</div>
		{/if}
	</section>

	<!-- What was left out, and why ----------------------------------------- -->
	{#if result.removed.length > 0}
		<section class="mt-8">
			<h2 class="eyebrow rule-hair pb-1">You removed</h2>
			<div class="mt-2 flex flex-wrap gap-1">
				{#each result.removed as r (r.itemId)}
					<a
						href={putBackHref(r.itemId)}
						class="border border-rule px-2 py-0.5 text-[0.6875rem] text-ink-muted hover:bg-paper-sunk"
						title="Put it back"
					>
						{r.name ?? 'A dish not on this menu'} <span class="font-semibold text-ink">↺</span>
					</a>
				{/each}
				<a
					href={replan(state, { excluded: [] })}
					class="ml-1 text-[0.6875rem] text-ink-muted underline"
				>
					Put all back
				</a>
			</div>
		</section>
	{/if}

	<section class="mt-8 space-y-2 text-xs leading-relaxed text-ink-muted">
		{#if data.checkingAllergens}
			<p>
				Checked against your registered allergens: {data.menu?.allergenHeld ?? 0}
				{data.menu?.allergenHeld === 1 ? 'dish was' : 'dishes were'} left out because they are flagged,
				may contain one, or could not be checked.
			</p>
		{:else if data.signedIn}
			<p>
				You have no allergens registered, so nothing was left out for them.
				<a href="/settings/allergens" class="font-semibold text-ink underline">Add yours</a>.
			</p>
		{:else}
			<p>
				Nothing here is checked against allergens, because you are not signed in.
				<a
					href="/auth/login?next={encodeURIComponent(here)}"
					class="font-semibold text-ink underline">Sign in</a
				>
				to have the planner leave out dishes you cannot eat.
			</p>
		{/if}
		{#if state.skipSaladBar && data.menu && data.menu.saladBarHeld > 0}
			<p>{data.menu.saladBarHeld} salad bar items left out.</p>
		{/if}
		{#if state.diets.length > 0 && data.menu && data.menu.dietHeld > 0}
			<p>{data.menu.dietHeld} dishes left out for not carrying the diet tags you chose.</p>
		{/if}
	</section>

	{#if result.skipped.length > 0}
		<details class="mt-6 border border-rule-hair p-3">
			<summary class="cursor-pointer text-xs font-semibold">
				{result.skipped.length}
				{result.skipped.length === 1
					? 'dish was not recommended because its label does not add up'
					: 'dishes were not recommended because their labels do not add up'}
			</summary>
			<p class="mt-2 text-xs leading-relaxed text-ink-muted">
				The university's serving sizes are sometimes wrong. Multiplying a broken label would put the
				wrong amount on your plate, so these are left out of plans. You can still add one yourself
				above.
			</p>
			<ul class="mt-2">
				{#each result.skipped as s (s.slug + s.venue)}
					<li class="rule-hair py-1.5 text-xs">
						<a href="/item/{s.slug}" class="font-semibold hover:underline">{s.name}</a>
						<span class="font-mono text-[0.6875rem] text-ink-faint"
							>{s.serving ?? ''} · {s.venue}</span
						>
						<p class="mt-0.5 text-ink-muted">{s.reason}</p>
					</li>
				{/each}
			</ul>
		</details>
	{/if}

	<p class="mt-8 text-[0.6875rem] leading-relaxed text-ink-faint">
		Portions and totals are estimates from the university's published labels, which round their
		numbers and are sometimes wrong. This is a planning aid, not medical or dietary advice. If you
		are managing a health condition, an eating disorder, or a pregnancy, plan with a clinician or a
		registered dietitian.
	</p>
{/if}

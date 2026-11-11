<script lang="ts">
	import { ACTIVITY_OPTIONS, GOAL_OPTIONS, LIMITS, SEX_OPTIONS } from '$lib/planner/targets';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const errors = $derived((form && 'errors' in form ? form.errors : {}) as Record<string, string>);
	const values = $derived(
		(form && 'values' in form ? form.values : null) as Record<string, string> | null
	);

	/** What to prefill: the failed submission first, then what is stored. */
	function value(name: string): string {
		if (values && name in values) return values[name];
		const p = data.profile;
		const m = data.measurements;
		if (!p || !m) return name === 'mealsPerDay' ? '3' : '';
		const stored: Record<string, string | number | null> = {
			sex: p.sex,
			age: p.age,
			heightFt: m.heightFt,
			heightIn: m.heightIn,
			weightLb: m.weightLb,
			heightCm: m.heightCm,
			weightKg: m.weightKg,
			activity: p.activity,
			goal: p.goal,
			mealsPerDay: p.mealsPerDay,
			caloriesOverride: p.caloriesOverride,
			proteinOverride: p.proteinOverride
		};
		const v = stored[name];
		return v === null || v === undefined ? '' : String(v);
	}

	const nextParam = $derived(`next=${encodeURIComponent(data.next)}`);
	const field =
		'mt-1 w-full border-0 border-b-2 border-ink bg-transparent px-0 py-1.5 text-sm focus:ring-0';
	const radio = 'size-4 rounded-none border-2 border-ink text-ink-full focus:ring-ink';
</script>

<svelte:head><title>Body info — uieats</title></svelte:head>

<nav class="mb-1 text-xs">
	<a href={data.next} class="text-ink-faint hover:underline">&larr; Back to the planner</a>
</nav>
<h1 class="display rule-title pb-2 text-3xl">Your body info</h1>

<p class="mt-4 text-sm leading-relaxed text-ink-muted">
	The planner uses this to estimate how much you burn in a day and how to split it across your
	meals.
	{#if data.signedIn}
		It is saved to your account and is not shown to anyone.
	{:else}
		You are not signed in, so it is kept in a cookie on this device only.
	{/if}
</p>

{#if data.targets}
	<div class="mt-5 border-2 border-ink p-4">
		<h2 class="eyebrow mb-1">Your daily targets right now</h2>
		<p class="tabular text-lg font-bold">
			{data.targets.day.calories.toLocaleString('en-US')} cal · {Math.round(
				data.targets.day.proteinG
			)} g protein
		</p>
		<p class="mt-1 font-mono text-[0.6875rem] text-ink-faint">
			{#if data.targets.bmr !== null && data.profile?.caloriesOverride === null}
				Resting ~{data.targets.bmr.toLocaleString('en-US')} cal, ~{data.targets.tdee?.toLocaleString(
					'en-US'
				)} with activity ·
			{/if}
			BMI {data.targets.bmi}
		</p>
	</div>
{/if}

<form method="POST" action="?/save&{nextParam}" class="mt-8 space-y-8">
	<input type="hidden" name="units" value={data.units} />

	<fieldset>
		<legend class="eyebrow rule-group mb-3 w-full pb-1">Sex</legend>
		<div class="flex flex-wrap gap-x-5 gap-y-2">
			{#each SEX_OPTIONS as o (o.value)}
				<label class="flex items-center gap-2 text-sm">
					<input
						type="radio"
						name="sex"
						value={o.value}
						checked={value('sex') === o.value}
						class={radio}
					/>
					{o.label}
				</label>
			{/each}
		</div>
		<p class="mt-2 text-[0.6875rem] text-ink-faint">
			Only used for the resting-energy equation, which has a different constant for each. "Prefer
			not to say" uses the midpoint.
		</p>
		{#if errors.sex}<p class="mt-1 text-xs font-semibold">{errors.sex}</p>{/if}
	</fieldset>

	<fieldset>
		<div class="rule-group mb-3 flex items-baseline justify-between pb-1">
			<legend class="eyebrow">Measurements</legend>
			<span class="text-[0.6875rem]">
				{#if data.units === 'imperial'}
					<span class="font-semibold">ft / lb</span> ·
					<a href="?units=metric&{nextParam}" class="text-ink-muted underline">cm / kg</a>
				{:else}
					<a href="?units=imperial&{nextParam}" class="text-ink-muted underline">ft / lb</a> ·
					<span class="font-semibold">cm / kg</span>
				{/if}
			</span>
		</div>

		<div class="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
			<label class="col-span-2 sm:col-span-1">
				<span class="eyebrow block">Age</span>
				<input
					type="number"
					name="age"
					min={LIMITS.age.min}
					max={LIMITS.age.max}
					inputmode="numeric"
					value={value('age')}
					class={field}
				/>
				{#if errors.age}<span class="mt-1 block text-xs font-semibold">{errors.age}</span>{/if}
			</label>

			{#if data.units === 'imperial'}
				<div class="col-span-2">
					<span class="eyebrow block">Height</span>
					<div class="flex gap-3">
						<label class="flex flex-1 items-baseline gap-1">
							<input
								type="number"
								name="heightFt"
								min="4"
								max="7"
								aria-label="Feet"
								value={value('heightFt')}
								class={field}
							/>
							<span class="text-xs text-ink-muted">ft</span>
						</label>
						<label class="flex flex-1 items-baseline gap-1">
							<input
								type="number"
								name="heightIn"
								min="0"
								max="11"
								aria-label="Inches"
								value={value('heightIn')}
								class={field}
							/>
							<span class="text-xs text-ink-muted">in</span>
						</label>
					</div>
					{#if errors.height}<span class="mt-1 block text-xs font-semibold">{errors.height}</span
						>{/if}
				</div>
				<label class="col-span-2 sm:col-span-1">
					<span class="eyebrow block">Weight</span>
					<span class="flex items-baseline gap-1">
						<input
							type="number"
							name="weightLb"
							min="77"
							max="660"
							step="0.1"
							value={value('weightLb')}
							class={field}
						/>
						<span class="text-xs text-ink-muted">lb</span>
					</span>
					{#if errors.weight}<span class="mt-1 block text-xs font-semibold">{errors.weight}</span
						>{/if}
				</label>
			{:else}
				<label class="col-span-2 sm:col-span-1">
					<span class="eyebrow block">Height</span>
					<span class="flex items-baseline gap-1">
						<input
							type="number"
							name="heightCm"
							min={LIMITS.heightCm.min}
							max={LIMITS.heightCm.max}
							value={value('heightCm')}
							class={field}
						/>
						<span class="text-xs text-ink-muted">cm</span>
					</span>
					{#if errors.height}<span class="mt-1 block text-xs font-semibold">{errors.height}</span
						>{/if}
				</label>
				<label class="col-span-2 sm:col-span-1">
					<span class="eyebrow block">Weight</span>
					<span class="flex items-baseline gap-1">
						<input
							type="number"
							name="weightKg"
							min={LIMITS.weightKg.min}
							max={LIMITS.weightKg.max}
							step="0.1"
							value={value('weightKg')}
							class={field}
						/>
						<span class="text-xs text-ink-muted">kg</span>
					</span>
					{#if errors.weight}<span class="mt-1 block text-xs font-semibold">{errors.weight}</span
						>{/if}
				</label>
			{/if}
		</div>
	</fieldset>

	<fieldset>
		<legend class="eyebrow rule-group mb-1 w-full pb-1">How active are you?</legend>
		{#each ACTIVITY_OPTIONS as o (o.value)}
			<label class="rule-hair flex items-baseline gap-3 py-2">
				<input
					type="radio"
					name="activity"
					value={o.value}
					checked={value('activity') === o.value}
					class="{radio} translate-y-0.5"
				/>
				<span class="text-[0.9375rem] font-medium">{o.label}</span>
				<span class="ml-auto text-right text-[0.6875rem] text-ink-faint">{o.detail}</span>
			</label>
		{/each}
		{#if errors.activity}<p class="mt-1 text-xs font-semibold">{errors.activity}</p>{/if}
	</fieldset>

	<fieldset>
		<legend class="eyebrow rule-group mb-1 w-full pb-1">Goal</legend>
		{#each GOAL_OPTIONS as o (o.value)}
			<label class="rule-hair flex items-baseline gap-3 py-2">
				<input
					type="radio"
					name="goal"
					value={o.value}
					checked={value('goal') === o.value}
					class="{radio} translate-y-0.5"
				/>
				<span class="text-[0.9375rem] font-medium">{o.label}</span>
				<span class="ml-auto text-right text-[0.6875rem] text-ink-faint">{o.detail}</span>
			</label>
		{/each}
		{#if errors.goal}<p class="mt-1 text-xs font-semibold">{errors.goal}</p>{/if}
	</fieldset>

	<fieldset>
		<legend class="eyebrow rule-group mb-3 w-full pb-1">Meals</legend>
		<label class="block max-w-48">
			<span class="eyebrow block">Meals a day</span>
			<select name="mealsPerDay" class={field}>
				{#each [2, 3, 4, 5] as n (n)}
					<option value={String(n)} selected={value('mealsPerDay') === String(n)}>{n}</option>
				{/each}
			</select>
			{#if errors.mealsPerDay}<span class="mt-1 block text-xs font-semibold"
					>{errors.mealsPerDay}</span
				>{/if}
		</label>
		<p class="mt-2 text-[0.6875rem] text-ink-faint">
			The day's targets are split evenly across these. Count a regular snack as a meal if you want
			room left for it.
		</p>
	</fieldset>

	<details
		class="border border-rule-hair p-3"
		open={!!(
			errors.caloriesOverride ||
			errors.proteinOverride ||
			value('caloriesOverride') ||
			value('proteinOverride')
		)}
	>
		<summary class="cursor-pointer text-xs font-semibold">Already know your numbers?</summary>
		<p class="mt-2 text-xs leading-relaxed text-ink-muted">
			If a coach or dietitian gave you daily targets, enter them and they replace the estimate.
			Leave blank to use the estimate.
		</p>
		<div class="mt-3 grid grid-cols-2 gap-5">
			<label>
				<span class="eyebrow block">Calories a day</span>
				<input
					type="number"
					name="caloriesOverride"
					min={LIMITS.calories.min}
					max={LIMITS.calories.max}
					step="10"
					value={value('caloriesOverride')}
					class={field}
				/>
				{#if errors.caloriesOverride}<span class="mt-1 block text-xs font-semibold"
						>{errors.caloriesOverride}</span
					>{/if}
			</label>
			<label>
				<span class="eyebrow block">Protein a day (g)</span>
				<input
					type="number"
					name="proteinOverride"
					min={LIMITS.protein.min}
					max={LIMITS.protein.max}
					value={value('proteinOverride')}
					class={field}
				/>
				{#if errors.proteinOverride}<span class="mt-1 block text-xs font-semibold"
						>{errors.proteinOverride}</span
					>{/if}
			</label>
		</div>
	</details>

	<div class="flex items-center gap-4">
		<button type="submit" class="bg-ink-full px-5 py-2.5 text-sm font-bold text-paper">
			Save and plan
		</button>
		{#if Object.keys(errors).length > 0}
			<p class="text-sm font-semibold">Fix the marked fields and save again.</p>
		{/if}
	</div>
</form>

{#if data.profile}
	<form method="POST" action="?/clear&{nextParam}" class="mt-12">
		<button type="submit" class="text-xs font-semibold text-ink-muted underline">
			Delete my body info
		</button>
	</form>
{:else if form && 'cleared' in form}
	<p class="mt-12 text-xs font-semibold">Deleted.</p>
{/if}

<p class="mt-10 text-[0.6875rem] leading-relaxed text-ink-faint">
	Estimates use the Mifflin-St Jeor equation and the US Dietary Guidelines. They are a starting
	point for planning a plate, not medical advice.
</p>

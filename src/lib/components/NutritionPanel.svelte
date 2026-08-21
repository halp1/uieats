<!--
	The nutrition label, rebuilt.

	This is the artifact the rest of the app's visual language is borrowed from,
	so here it is drawn faithfully: graduated rule weights, values locked right,
	indentation for sub-nutrients.

	The one rule that matters more than fidelity: a value upstream did not give
	renders as "—", never as 0. Trans fat is printed "NA" on these labels and
	Vitamin A is often blank, while Calcium genuinely does read 0%. Collapsing
	those into a zero would assert something upstream never said.
-->
<script lang="ts">
	import type { NutritionFacts } from '$lib/server/queries/items';

	let { facts }: { facts: NutritionFacts } = $props();

	function amount(value: number | null, unit: string): string {
		return value === null ? '—' : `${Number(value.toFixed(1))}${unit}`;
	}

	function percent(value: number | null): string {
		return value === null ? '—' : `${Math.round(value)}%`;
	}

	const fiber = $derived(
		facts.fiberG === null
			? '—'
			: facts.fiberIsLessThan
				? '< 1g'
				: `${Number(facts.fiberG.toFixed(1))}g`
	);

	const rows = $derived([
		{ label: 'Total Fat', value: amount(facts.totalFatG, 'g'), bold: true, indent: 0 },
		{ label: 'Saturated Fat', value: amount(facts.satFatG, 'g'), bold: false, indent: 1 },
		{ label: 'Trans Fat', value: amount(facts.transFatG, 'g'), bold: false, indent: 1 },
		{ label: 'Polyunsaturated Fat', value: amount(facts.polyFatG, 'g'), bold: false, indent: 1 },
		{ label: 'Monounsaturated Fat', value: amount(facts.monoFatG, 'g'), bold: false, indent: 1 },
		{ label: 'Cholesterol', value: amount(facts.cholesterolMg, 'mg'), bold: true, indent: 0 },
		{ label: 'Sodium', value: amount(facts.sodiumMg, 'mg'), bold: true, indent: 0 },
		{ label: 'Potassium', value: amount(facts.potassiumMg, 'mg'), bold: true, indent: 0 },
		{ label: 'Total Carbohydrate', value: amount(facts.totalCarbG, 'g'), bold: true, indent: 0 },
		{ label: 'Dietary Fiber', value: fiber, bold: false, indent: 1 },
		{ label: 'Sugars', value: amount(facts.sugarsG, 'g'), bold: false, indent: 1 },
		{ label: 'Protein', value: amount(facts.proteinG, 'g'), bold: true, indent: 0 }
	]);

	const vitamins = $derived([
		{ label: 'Vitamin A', value: percent(facts.vitADv) },
		{ label: 'Vitamin C', value: percent(facts.vitCDv) },
		{ label: 'Calcium', value: percent(facts.calciumDv) },
		{ label: 'Iron', value: percent(facts.ironDv) }
	]);
</script>

<div class="tabular border-2 border-ink-full p-3 font-sans">
	<h3 class="display rule-title pb-0.5 text-2xl">Nutrition Facts</h3>

	{#if facts.servingSizeText}
		<p class="rule-group py-1 text-xs font-semibold">
			Serving size {facts.servingSizeText}
		</p>
	{/if}

	<div class="rule-section flex items-end justify-between py-1">
		<span class="text-base font-extrabold">Calories</span>
		<span class="text-2xl font-extrabold">
			{facts.calories === null ? '—' : Math.round(facts.calories)}
		</span>
	</div>

	<dl class="text-[0.8125rem]">
		{#each rows as row (row.label)}
			<div
				class="rule-hair flex justify-between gap-4 py-0.5"
				style:padding-left="{row.indent * 0.75}rem"
			>
				<dt class:font-bold={row.bold}>{row.label}</dt>
				<dd class="shrink-0">{row.value}</dd>
			</div>
		{/each}
	</dl>

	<div class="rule-section mt-1"></div>

	<dl class="flex flex-wrap gap-x-6 gap-y-0.5 pt-1 text-xs">
		{#each vitamins as v (v.label)}
			<div class="flex gap-1.5">
				<dt>{v.label}</dt>
				<dd class="font-semibold">{v.value}</dd>
			</div>
		{/each}
	</dl>

	<p class="mt-2 text-[0.625rem] leading-snug text-ink-faint">
		A dash means the university's label left that value blank or printed "NA" — not that the value
		is zero. Percentages are daily values from upstream, on a 2,000 calorie diet.
	</p>
</div>

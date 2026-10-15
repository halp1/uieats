<!--
	One nutrient against its target, as a label line with a bar beneath.

	Greyscale like everything else: the fill is ink, the target is a hairline
	tick, and going over a LIMIT (sodium, saturated fat) is carried by the
	words "over limit" rather than by a colour nobody is allowed to use here.
-->
<script lang="ts">
	let {
		label,
		value,
		target,
		unit,
		kind = 'goal',
		blank = false
	}: {
		label: string;
		value: number;
		target: number;
		unit: string;
		/** A goal is aimed at; a limit is only a problem when exceeded. */
		kind?: 'goal' | 'limit';
		/** Some line in the total left this value blank upstream. */
		blank?: boolean;
	} = $props();

	// The bar spans 150% of target, so both a shortfall and an overshoot show.
	const span = $derived(Math.max(target * 1.5, value, 1));
	const fill = $derived(Math.min(100, (value / span) * 100));
	const tick = $derived((target / span) * 100);
	const over = $derived(kind === 'limit' && value > target);
</script>

<div class="rule-hair py-1.5">
	<div class="flex items-baseline justify-between gap-3 text-[0.8125rem]">
		<span class="font-semibold">{label}</span>
		<span class="tabular font-mono text-[0.6875rem]">
			<span class="font-semibold text-ink">{Math.round(value)}{unit}</span>
			<span class="text-ink-faint">
				{kind === 'limit' ? 'limit' : 'of'}
				{Math.round(target)}{unit}{#if blank}*{/if}
			</span>
			{#if over}<span class="ml-1 font-bold">over limit</span>{/if}
		</span>
	</div>
	<div class="relative mt-1 h-1.5 bg-paper-sunk" aria-hidden="true">
		<div
			class="absolute inset-y-0 left-0 {kind === 'limit' && !over ? 'bg-rule' : 'bg-ink-full'}"
			style:width="{fill}%"
		></div>
		<div class="absolute -inset-y-0.5 w-px bg-ink-full" style:left="{tick}%"></div>
	</div>
</div>

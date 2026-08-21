<!--
	The day switcher, and the app's primary control.

	The date leads the URL because it leads the decision: a student picks "today,
	dinner" before they pick a building. Upstream buries the same choice in a
	dropdown behind two page loads.

	A window of days rather than a calendar widget -- the useful range is a
	fortnight, which fits on a strip, and a strip is one tap instead of three.
-->
<script lang="ts">
	import { addDays, formatCampusDate } from '$lib/dates';

	let {
		date,
		today,
		href,
		span = 7
	}: {
		date: string;
		today: string;
		/** Builds the link for a date, preserving the rest of the route. */
		href: (date: string) => string;
		span?: number;
	} = $props();

	// Centred on the selected day, so paging forward never strands the user at
	// the edge of the strip.
	const days = $derived(
		Array.from({ length: span }, (_, i) => addDays(date, i - Math.floor(span / 2)))
	);

	function dayNumber(d: string): string {
		return String(Number(d.slice(8, 10)));
	}
	function dayLetter(d: string): string {
		return formatCampusDate(d).slice(0, 3).toUpperCase();
	}
</script>

<nav aria-label="Choose a day" class="rule-group flex items-stretch gap-px overflow-x-auto pb-1">
	<a
		href={href(addDays(date, -1))}
		class="flex shrink-0 items-center px-2 font-mono text-xs text-ink-faint hover:text-ink"
		aria-label="Previous day"
	>
		&larr;
	</a>

	{#each days as day (day)}
		{@const isSelected = day === date}
		{@const isToday = day === today}
		<a
			href={href(day)}
			aria-current={isSelected ? 'page' : undefined}
			class="flex min-w-11 shrink-0 flex-col items-center px-2 py-1 leading-none
				{isSelected ? 'bg-ink-full text-paper' : 'text-ink-muted hover:bg-paper-sunk'}"
		>
			<span class="text-[0.5625rem] font-bold tracking-[0.14em]">{dayLetter(day)}</span>
			<span class="tabular mt-1 text-lg font-extrabold">{dayNumber(day)}</span>
			<!-- Today is marked structurally, with a bar, so it reads even when it
			     is also the selected day and the whole cell is inverted. -->
			<span
				class="mt-1 h-0.5 w-4 {isToday
					? isSelected
						? 'bg-paper'
						: 'bg-ink-full'
					: 'bg-transparent'}"
			></span>
		</a>
	{/each}

	<a
		href={href(addDays(date, 1))}
		class="flex shrink-0 items-center px-2 font-mono text-xs text-ink-faint hover:text-ink"
		aria-label="Next day"
	>
		&rarr;
	</a>
</nav>

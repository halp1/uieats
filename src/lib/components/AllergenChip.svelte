<!--
	One allergen verdict, rendered.

	Severity is carried by FORM, never by colour: filled, outlined, dashed,
	hairline, hatched. Each also gets its own icon, so the difference survives a
	greyscale print, a low-contrast screen, and colour-blindness -- which the
	usual red/amber/green would not.

	The `title` is always the verdict's own `basis` string, so any chip can be
	interrogated for why it says what it says. That auditability is the point:
	this app asks to be checked, not trusted.
-->
<script lang="ts">
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Minus from '@lucide/svelte/icons/minus';
	import OctagonAlert from '@lucide/svelte/icons/octagon-alert';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import type { Verdict, VerdictResult } from '$lib/server/allergens/verdict';

	let { verdict, compact = false }: { verdict: VerdictResult; compact?: boolean } = $props();

	const STYLES: Record<Verdict, string> = {
		'flagged-declared': 'chip-declared',
		'flagged-likely': 'chip-likely',
		'flagged-may-contain': 'chip-may-contain',
		'flagged-possible': 'chip-possible',
		'no-declared': 'chip-none',
		unknown: 'chip-unknown'
	};

	const ICONS = {
		'flagged-declared': OctagonAlert,
		'flagged-likely': TriangleAlert,
		// A shield: this is about what may have touched the dish, not what is in it.
		'flagged-may-contain': ShieldAlert,
		'flagged-possible': CircleHelp,
		'no-declared': Minus,
		unknown: CircleDashed
	};

	const Icon = $derived(ICONS[verdict.verdict]);
	// Compact mode drops the "No X declared" wording to just the allergen, since
	// a menu row already groups chips under a heading that says what they are.
	const text = $derived(
		compact && verdict.verdict === 'no-declared' ? verdict.allergen.label : verdict.chipLabel
	);
</script>

<span class="chip {STYLES[verdict.verdict]}" title={verdict.basis}>
	<Icon class="size-3 shrink-0" aria-hidden="true" />
	<span>{text}</span>
</span>

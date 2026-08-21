<!--
	The cross-contact disclaimer.

	Permanent, on every page, and worded to be read rather than skipped. This
	app can only ever repeat what the university published; it cannot see a
	shared fryer, a reused pair of tongs, or a substituted delivery. Someone
	relying on the chips deserves that said plainly, in the same place, every
	time -- not buried in a terms page.
-->
<script lang="ts">
	let { compact = false }: { compact?: boolean } = $props();
</script>

{#if compact}
	<p class="text-xs leading-relaxed text-ink-muted">
		Allergen data comes from the university's own labels and can be incomplete or out of date.
		Shared fryers, utensils and serving lines mean cross-contact this data cannot show. If a
		reaction would be serious, ask the dining staff before you eat.
	</p>
{:else}
	<div class="border-2 border-ink p-4">
		<h2 class="eyebrow mb-2">Before you rely on this</h2>
		<ul class="space-y-1.5 text-sm leading-relaxed text-ink-muted">
			<li>
				Every allergen flag here is repeated from the university's published labels. uieats adds
				nothing of its own except reading the ingredient text for allergens the labels do not name.
			</li>
			<li>
				<strong class="font-semibold text-ink">Nothing on this page means an item is fine.</strong>
				A grey chip means nothing was found in what has been read so far. Recipes change, labels lag,
				and a dish can be re-made with a different supplier the same week.
			</li>
			<li>
				Shared fryers, utensils and serving lines cause cross-contact that no label records. This
				data cannot show it and neither can we.
			</li>
			<li>Ask the dining hall staff before eating anything that would cause a serious reaction.</li>
		</ul>
	</div>
{/if}

<!--
	Diet filters, as links rather than a form.

	Each tag is a toggle that rewrites the query string, so filter state lives in
	the URL: it survives a reload, it can be shared ("Ike, vegan, today"), and it
	needs no client JavaScript. The date strip and meal tabs work the same way,
	which keeps the whole browse surface navigable with nothing but anchors.

	These are the university's own dietary tags, never a safety claim -- so they
	are styled as the quietest thing on the page and never share the chip
	vocabulary that allergen severity uses.
-->
<script lang="ts">
	import type { AllergenRef } from '$lib/server/allergens/verdict';

	let {
		tags,
		active,
		url
	}: {
		tags: AllergenRef[];
		active: string[];
		/** The current page URL, which the toggles are built from. */
		url: URL;
	} = $props();

	/**
	 * Built from URLSearchParams rather than a cloned URL: nothing here needs an
	 * origin, and a mutable URL derived from `page.url` is a reactivity trap.
	 */
	function href(params: URLSearchParams): string {
		const query = params.toString();
		return query ? `${url.pathname}?${query}` : url.pathname;
	}

	function toggleHref(slug: string): string {
		// A throwaway string builder inside a pure function, not reactive state:
		// the Svelte variant would make it reactive, which is the opposite of what
		// is wanted here.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const params = new URLSearchParams(url.search);
		const current = params.getAll('diet');
		params.delete('diet');
		for (const existing of current) {
			if (existing !== slug) params.append('diet', existing);
		}
		if (!current.includes(slug)) params.append('diet', slug);
		return href(params);
	}

	const clearHref = $derived.by(() => {
		// Same as above: a local builder, deliberately not reactive.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const params = new URLSearchParams(url.search);
		params.delete('diet');
		return href(params);
	});
</script>

<div class="mt-4 flex flex-wrap items-center gap-x-1 gap-y-1">
	<span class="eyebrow mr-1">Diet</span>
	{#each tags as tag (tag.slug)}
		{@const on = active.includes(tag.slug)}
		<!--
			A link, so aria-pressed does not apply. `aria-current` is the right
			property for "this is the state you are looking at".
		-->
		<a
			href={toggleHref(tag.slug)}
			aria-current={on ? 'true' : undefined}
			class="px-2 py-0.5 text-[0.6875rem] font-semibold
				{on ? 'bg-ink-full text-paper' : 'text-ink-faint hover:bg-paper-sunk hover:text-ink'}"
		>
			{tag.label}
		</a>
	{/each}

	{#if active.length > 0}
		<a href={clearHref} class="ml-2 text-[0.6875rem] text-ink-muted underline">Clear</a>
	{/if}
</div>

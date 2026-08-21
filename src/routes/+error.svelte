<!--
	The error page.

	A 404 here almost always means a stale link — a venue slug from before a
	rename, or a date outside the window uieats holds — so the page's job is to
	get someone back to a menu rather than to apologise. Kit's default page is a
	status code and a sentence, which for a browsing app is a dead end.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { campusToday } from '$lib/dates';

	// The layout already loaded, so `today` is normally to hand -- but an error
	// early enough in the request skips the layout load, and this page still has
	// to render.
	const today = $derived(page.data.today ?? campusToday());

	const headline = $derived.by(() => {
		if (page.status === 404) return 'That page is not here';
		if (page.status === 400) return 'That address does not look right';
		if (page.status >= 500) return 'Something broke on our side';
		return 'That did not work';
	});
</script>

<svelte:head><title>{page.status} — uieats</title></svelte:head>

<div class="max-w-lg">
	<p class="eyebrow">{page.status}</p>
	<h1 class="display rule-title mt-1 pb-2 text-3xl">{headline}</h1>

	<p class="mt-4 text-sm leading-relaxed text-ink-muted">
		{page.error?.message ?? 'No further detail.'}
	</p>

	{#if page.status === 404}
		<p class="mt-3 text-sm leading-relaxed text-ink-muted">
			Venue links are built from names the university publishes, and menus only run a couple of
			weeks ahead — so an old bookmark or a distant date will both land here.
		</p>
	{/if}

	<ul class="mt-8">
		<li class="rule-hair py-2">
			<a href="/d/{today}" class="text-[0.9375rem] font-semibold hover:underline">
				Today's menus &rarr;
			</a>
		</li>
		<li class="rule-hair py-2">
			<a href="/search" class="text-[0.9375rem] font-semibold hover:underline">
				Search for a dish &rarr;
			</a>
		</li>
	</ul>
</div>

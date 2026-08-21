<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Sign out — uieats</title></svelte:head>

<div class="max-w-md">
	<h1 class="display rule-title pb-2 text-3xl">Sign out</h1>
	<p class="mt-4 text-sm leading-relaxed text-ink-muted">
		You are signed in as <span class="font-mono font-semibold text-ink">{data.email}</span>. Your
		allergens and saved dishes stay on your account.
	</p>

	<form method="POST" class="mt-8">
		<button type="submit" class="w-full bg-ink-full px-4 py-2.5 text-sm font-bold text-paper">
			Sign out on this device
		</button>
	</form>
</div>

<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Enter your code — uieats</title></svelte:head>

<div class="max-w-md">
	<h1 class="display rule-title pb-2 text-3xl">Check your email</h1>
	<p class="mt-4 text-sm leading-relaxed text-ink-muted">
		We sent a six-digit code to <span class="font-mono font-semibold text-ink">{data.email}</span>.
		It works once and expires in ten minutes.
	</p>

	<form method="POST" class="mt-8">
		<label for="code" class="eyebrow block">Six-digit code</label>
		<input
			id="code"
			name="code"
			type="text"
			inputmode="numeric"
			autocomplete="one-time-code"
			pattern="[0-9]*"
			maxlength="6"
			required
			class="tabular mt-1 w-full border-0 border-b-2 border-ink bg-transparent px-0 py-2 font-mono text-3xl tracking-[0.3em] focus:ring-0"
		/>

		{#if form?.message}
			<p class="mt-4 border-l-2 border-ink pl-3 text-sm text-ink">{form.message}</p>
		{/if}

		<button type="submit" class="mt-6 w-full bg-ink-full px-4 py-2.5 text-sm font-bold text-paper">
			Sign in
		</button>
	</form>

	<p class="mt-6 text-xs text-ink-faint">
		{#if form && 'restart' in form && form.restart}
			<a href="/auth/login" class="font-semibold text-ink underline">Request a new code</a>
		{:else}
			Nothing arrived?
			<a href="/auth/login" class="font-semibold text-ink underline">Send another code</a>
			— check your spam folder first, and that you typed the right address. You get
			{data.maxAttempts} tries per code.
		{/if}
	</p>
</div>

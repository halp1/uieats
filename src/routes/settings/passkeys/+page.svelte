<script lang="ts">
	import { startRegistration } from '@simplewebauthn/browser';
	import { invalidateAll } from '$app/navigation';
	import { describeAge } from '$lib/dates';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let name = $state('');
	let busy = $state(false);
	let message = $state<string | null>(null);

	/**
	 * Passkey registration is the one flow here that cannot be a plain form
	 * post: the browser's credential API has to run on the client. So it is
	 * offered as an addition to an account that already exists and already works
	 * by email, rather than as a route in.
	 */
	async function addPasskey() {
		busy = true;
		message = null;
		try {
			const optionsResponse = await fetch('/api/webauthn/register/options', { method: 'POST' });
			if (!optionsResponse.ok) throw new Error('Could not start registration.');
			const { options, challengeId } = await optionsResponse.json();

			const attestation = await startRegistration({ optionsJSON: options });

			const verifyResponse = await fetch('/api/webauthn/register/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ challengeId, response: attestation, name })
			});
			const result = await verifyResponse.json();
			if (!result.ok) throw new Error(result.message ?? 'That passkey could not be saved.');

			name = '';
			message = 'Passkey added. You can use it to sign in from now on.';
			await invalidateAll();
		} catch (err) {
			// Includes the user simply cancelling the browser prompt, which is not
			// an error worth alarming them about.
			const text = err instanceof Error ? err.message : String(err);
			message = /abort|cancel|NotAllowed/i.test(text)
				? 'No passkey was added.'
				: `Could not add a passkey: ${text}`;
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Passkeys — uieats</title></svelte:head>

<h1 class="display rule-title pb-2 text-3xl">Passkeys</h1>
<p class="mt-4 text-sm leading-relaxed text-ink-muted">
	A passkey signs you in with your device's own unlock — face, fingerprint or PIN — instead of
	waiting for an email. Your email code keeps working either way.
</p>

<section class="mt-8">
	<h2 class="eyebrow rule-group pb-1">On your account</h2>

	{#if data.credentials.length === 0}
		<p class="mt-3 text-sm text-ink-faint">No passkeys yet.</p>
	{:else}
		<ul class="mt-1">
			{#each data.credentials as credential (credential.id)}
				<li class="rule-hair flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
					<div class="min-w-0">
						<p class="text-sm font-medium">
							{credential.name ?? credential.deviceType ?? 'Passkey'}
						</p>
						<p class="font-mono text-[0.6875rem] text-ink-faint">
							added {describeAge(credential.createdAt)}
							{#if credential.lastUsedAt}
								· last used {describeAge(credential.lastUsedAt)}
							{:else}
								· never used
							{/if}
							{#if credential.backedUp}
								· synced
							{/if}
						</p>
					</div>

					<form method="POST" action="?/remove" class="shrink-0">
						<input type="hidden" name="id" value={credential.id} />
						<button
							type="submit"
							class="border border-ink px-2 py-0.5 text-[0.6875rem] font-semibold hover:bg-paper-sunk"
						>
							Remove
						</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	{#if form?.message}
		<p class="mt-3 border-l-2 border-ink pl-3 text-sm">{form.message}</p>
	{/if}
	{#if form?.removed}
		<p class="mt-3 text-sm font-semibold">Passkey removed.</p>
	{/if}
</section>

<section class="mt-10">
	<h2 class="eyebrow rule-group pb-1">Add one</h2>
	<div class="mt-3 flex flex-wrap items-end gap-3">
		<label class="flex-1">
			<span class="sr-only">Name this passkey</span>
			<input
				type="text"
				bind:value={name}
				placeholder="Phone, laptop…"
				maxlength="40"
				class="w-full border-0 border-b-2 border-ink bg-transparent px-0 py-1.5 text-sm focus:ring-0"
			/>
		</label>
		<button
			type="button"
			onclick={addPasskey}
			disabled={busy}
			class="bg-ink-full px-4 py-2 text-sm font-bold text-paper disabled:opacity-50"
		>
			{busy ? 'Waiting for your device…' : 'Add a passkey'}
		</button>
	</div>
	<p class="mt-2 text-xs text-ink-faint">
		Naming it is optional, and only helps you tell them apart later.
	</p>

	{#if message}
		<p class="mt-3 border-l-2 border-ink pl-3 text-sm">{message}</p>
	{/if}
</section>

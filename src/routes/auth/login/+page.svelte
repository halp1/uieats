<script lang="ts">
	import { startAuthentication } from '@simplewebauthn/browser';
	import { goto } from '$app/navigation';
	import { ELIGIBLE_DOMAIN_LABEL } from '$lib/server/auth/email';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let passkeyBusy = $state(false);
	let passkeyMessage = $state<string | null>(null);

	/**
	 * Passkey sign-in, offered second.
	 *
	 * The email form is first and works without JavaScript, because it is the
	 * only route that can create an account -- which is where the
	 * @illinois.edu rule lives. A passkey is a faster way back into an account
	 * that already exists, so it sits below and never replaces the form.
	 */
	async function signInWithPasskey() {
		passkeyBusy = true;
		passkeyMessage = null;
		try {
			const optionsResponse = await fetch('/api/webauthn/authenticate/options', {
				method: 'POST'
			});
			if (!optionsResponse.ok) throw new Error('Could not start sign-in.');
			const { options, challengeId } = await optionsResponse.json();

			const assertion = await startAuthentication({ optionsJSON: options });

			const verifyResponse = await fetch('/api/webauthn/authenticate/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ challengeId, response: assertion, next: data.next })
			});
			const result = await verifyResponse.json();
			if (!result.ok) throw new Error(result.message ?? 'That passkey was not accepted.');

			await goto(result.next, { invalidateAll: true });
		} catch (err) {
			const text = err instanceof Error ? err.message : String(err);
			passkeyMessage = /abort|cancel|NotAllowed/i.test(text)
				? 'Sign-in cancelled.'
				: `Passkey sign-in failed: ${text}`;
		} finally {
			passkeyBusy = false;
		}
	}
</script>

<svelte:head><title>Sign in — uieats</title></svelte:head>

<div class="max-w-md">
	<h1 class="display rule-title pb-2 text-3xl">Sign in</h1>
	<p class="mt-4 text-sm leading-relaxed text-ink-muted">
		There is no password. Enter your university address and we will email you a code.
	</p>

	<form method="POST" class="mt-8">
		{#if data.next}
			<input type="hidden" name="next" value={data.next} />
		{/if}

		<label for="email" class="eyebrow block">University email</label>
		<input
			id="email"
			name="email"
			type="email"
			required
			autocomplete="email"
			autocapitalize="off"
			spellcheck="false"
			placeholder="netid{ELIGIBLE_DOMAIN_LABEL}"
			value={form && 'email' in form ? form.email : ''}
			class="mt-1 w-full border-0 border-b-2 border-ink bg-transparent px-0 py-2 text-lg focus:ring-0"
		/>
		<!-- The rule is stated before typing, not after: the response cannot say
		     whether an address was eligible without also saying which addresses
		     exist. -->
		<p class="mt-2 text-xs text-ink-faint">
			Accounts are limited to {ELIGIBLE_DOMAIN_LABEL} addresses.
		</p>

		{#if form?.message}
			<p class="mt-4 border-l-2 border-ink pl-3 text-sm text-ink">{form.message}</p>
		{/if}

		<button type="submit" class="mt-6 w-full bg-ink-full px-4 py-2.5 text-sm font-bold text-paper">
			Email me a code
		</button>
	</form>

	<div class="rule-hair mt-10 pb-4">
		<h2 class="eyebrow">Already set up a passkey?</h2>
		<button
			type="button"
			onclick={signInWithPasskey}
			disabled={passkeyBusy}
			class="mt-2 w-full border-2 border-ink px-4 py-2 text-sm font-bold hover:bg-paper-sunk disabled:opacity-50"
		>
			{passkeyBusy ? 'Waiting for your device…' : 'Sign in with a passkey'}
		</button>
		{#if passkeyMessage}
			<p class="mt-3 border-l-2 border-ink pl-3 text-sm">{passkeyMessage}</p>
		{/if}
	</div>

	<p class="mt-8 text-xs leading-relaxed text-ink-faint">
		uieats stores your address, the allergens you register and the dishes you save. Nothing else,
		and nothing is shared.
	</p>
</div>

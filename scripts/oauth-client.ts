#!/usr/bin/env node
/**
 * Registers an OAuth client with a pre-shared id and secret, for MCP clients
 * that ask for them instead of registering themselves.
 *
 *   node scripts/oauth-client.ts --name=Gemini --redirect='https://oauth-redirect.googleusercontent.com/r/*'
 *
 * --redirect may repeat. A trailing `*` makes it a prefix, which Google needs
 * because its callback path carries a per-project id. The secret is printed
 * once and only its hash is stored.
 *
 * `--gemini` is shorthand for Google's documented redirect hosts.
 */
import { parseArgs } from 'node:util';
import { getDb } from '../src/lib/server/db/index.ts';
import { registerClient } from '../src/lib/server/auth/oauth.ts';

const GOOGLE_REDIRECTS = [
	'https://oauth-redirect.googleusercontent.com/*',
	'https://oauth-redirect-sandbox.googleusercontent.com/*',
	'https://oauth-redirect-test.googleusercontent.com/*'
];

const { values } = parseArgs({
	options: {
		name: { type: 'string' },
		redirect: { type: 'string', multiple: true },
		gemini: { type: 'boolean' },
		public: { type: 'boolean' }
	}
});

const redirects = [...(values.redirect ?? []), ...(values.gemini ? GOOGLE_REDIRECTS : [])];
if (redirects.length === 0) {
	console.error('Give at least one --redirect, or --gemini.');
	process.exit(1);
}

const { client, clientSecret } = registerClient(getDb(), {
	name: values.name ?? (values.gemini ? 'Gemini' : 'MCP client'),
	redirectUris: redirects,
	confidential: !values.public,
	source: 'manual'
});

console.log(`client_id      ${client.id}`);
if (clientSecret) console.log(`client_secret  ${clientSecret}`);
console.log(`redirects      ${client.redirectUris.join('\n               ')}`);

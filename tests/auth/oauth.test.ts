/**
 * The authorization server's rules. Each case here is a way OAuth servers are
 * commonly broken: open redirects, PKCE that is not actually checked, codes
 * that can be replayed, tokens that outlive revocation.
 */
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import {
	ACCESS_TOKEN_TTL,
	OAuthError,
	checkAuthorizeRequest,
	deleteStaleOAuthRows,
	disconnectApp,
	exchangeCode,
	issueCode,
	listConnectedApps,
	readAuthorizeParams,
	redirectUriAllowed,
	refreshTokens,
	registerClient,
	resolveAccessToken,
	revokeToken,
	authenticateClient,
	type OAuthClient
} from '../../src/lib/server/auth/oauth.ts';
import { handleRegisterRequest, handleTokenRequest } from '../../src/lib/server/auth/oauth-http.ts';

const NOW = 1_760_000_000;
const REDIRECT = 'https://client.example/callback';

let db: Db;
let userId: number;

beforeEach(() => {
	db = createMemoryDb();
	userId = db
		.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)')
		.run('student@illinois.edu', NOW).lastInsertRowid;
});

function pkce() {
	const verifier = randomBytes(32).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function publicClient(): OAuthClient {
	return registerClient(
		db,
		{ name: 'Test', redirectUris: [REDIRECT], confidential: false, source: 'dynamic' },
		NOW
	).client;
}

function codeFor(client: OAuthClient, challenge: string) {
	return issueCode(
		db,
		{ clientId: client.id, userId, redirectUri: REDIRECT, codeChallenge: challenge, scope: 'mcp' },
		NOW
	);
}

function authorize(overrides: Record<string, string | null>) {
	const p = new URLSearchParams();
	const base: Record<string, string | null> = {
		response_type: 'code',
		code_challenge: pkce().challenge,
		code_challenge_method: 'S256',
		...overrides
	};
	for (const [k, v] of Object.entries(base)) if (v !== null) p.set(k, v);
	return checkAuthorizeRequest(db, readAuthorizeParams(p));
}

describe('authorization request', () => {
	it.each([
		['unknown client', { client_id: 'nope' }, 'fatal'],
		['unregistered redirect', { redirect_uri: 'https://evil.example/cb' }, 'fatal'],
		['missing PKCE', { code_challenge: null }, 'redirect-error'],
		['plain PKCE', { code_challenge_method: 'plain' }, 'redirect-error'],
		['token response type', { response_type: 'token' }, 'redirect-error'],
		['valid', {}, 'ok']
	])('%s', (_, overrides, kind) => {
		const client = publicClient();
		const result = authorize({ client_id: client.id, redirect_uri: REDIRECT, ...overrides });
		expect(result.kind).toBe(kind);
		// Errors only ever redirect to the registered URI, never to one supplied.
		if (result.kind === 'redirect-error') expect(result.redirectUri).toBe(REDIRECT);
	});

	it('only operator clients get prefix redirects, and a prefix pins the host', () => {
		expect(() =>
			registerClient(
				db,
				{
					name: 'x',
					redirectUris: ['https://a.example/*'],
					confidential: false,
					source: 'dynamic'
				},
				NOW
			)
		).toThrow(OAuthError);
		expect(() =>
			registerClient(
				db,
				{ name: 'x', redirectUris: ['https://a.example*'], confidential: true, source: 'manual' },
				NOW
			)
		).toThrow(OAuthError);

		const { client } = registerClient(
			db,
			{
				name: 'Gemini',
				redirectUris: ['https://oauth-redirect.googleusercontent.com/*'],
				confidential: true,
				source: 'manual'
			},
			NOW
		);
		expect(redirectUriAllowed(client, 'https://oauth-redirect.googleusercontent.com/r/proj')).toBe(
			true
		);
		expect(redirectUriAllowed(client, 'https://oauth-redirect.googleusercontent.com.evil/r')).toBe(
			false
		);
	});

	it('rejects plain http except on loopback', () => {
		for (const [uri, ok] of [
			['http://localhost:6274/cb', true],
			['http://127.0.0.1/cb', true],
			['http://client.example/cb', false],
			['https://client.example/cb#frag', false]
		] as const) {
			const attempt = () =>
				registerClient(
					db,
					{ name: 'x', redirectUris: [uri], confidential: false, source: 'dynamic' },
					NOW
				);
			if (ok) expect(attempt).not.toThrow();
			else expect(attempt).toThrow(OAuthError);
		}
	});
});

describe('code exchange', () => {
	it('issues working tokens once, with PKCE actually checked', () => {
		const client = publicClient();
		const { verifier, challenge } = pkce();
		const code = codeFor(client, challenge);

		expect(() =>
			exchangeCode(db, client, { code, redirectUri: REDIRECT, codeVerifier: pkce().verifier }, NOW)
		).toThrow(/PKCE/);

		const tokens = exchangeCode(
			db,
			client,
			{ code, redirectUri: REDIRECT, codeVerifier: verifier },
			NOW
		);
		expect(resolveAccessToken(db, tokens.access_token, NOW)).toMatchObject({ id: userId });
		expect(resolveAccessToken(db, tokens.access_token, NOW + ACCESS_TOKEN_TTL)).toBeNull();
	});

	it('a replayed code fails and revokes what the first exchange issued', () => {
		const client = publicClient();
		const { verifier, challenge } = pkce();
		const code = codeFor(client, challenge);
		const input = { code, redirectUri: REDIRECT, codeVerifier: verifier };

		const first = exchangeCode(db, client, input, NOW);
		expect(() => exchangeCode(db, client, input, NOW)).toThrow(/already used/);
		expect(resolveAccessToken(db, first.access_token, NOW)).toBeNull();
		expect(() => refreshTokens(db, client, first.refresh_token, NOW)).toThrow(OAuthError);
	});

	it.each([
		['another client', 'client'],
		['an expired code', 'expired'],
		['a different redirect_uri', 'redirect']
	])('refuses %s', (_, variant) => {
		const client = publicClient();
		const { verifier, challenge } = pkce();
		const code = codeFor(client, challenge);
		const other = variant === 'client' ? publicClient() : client;
		const at = variant === 'expired' ? NOW + 3600 : NOW;
		const redirectUri = variant === 'redirect' ? 'https://client.example/other' : REDIRECT;
		expect(() =>
			exchangeCode(db, other, { code, redirectUri, codeVerifier: verifier }, at)
		).toThrow(OAuthError);
	});
});

describe('grants', () => {
	function connect() {
		const client = publicClient();
		const { verifier, challenge } = pkce();
		const tokens = exchangeCode(
			db,
			client,
			{ code: codeFor(client, challenge), redirectUri: REDIRECT, codeVerifier: verifier },
			NOW
		);
		return { client, tokens };
	}

	it('refresh keeps the same refresh token and mints a new access token', () => {
		const { client, tokens } = connect();
		const later = NOW + ACCESS_TOKEN_TTL + 10;
		const next = refreshTokens(db, client, tokens.refresh_token, later);
		expect(next.refresh_token).toBe(tokens.refresh_token);
		expect(resolveAccessToken(db, next.access_token, later)).toMatchObject({ id: userId });
		expect(() => refreshTokens(db, publicClient(), tokens.refresh_token, later)).toThrow(
			OAuthError
		);
	});

	it.each(['access', 'refresh'] as const)('revoking the %s token ends the whole grant', (kind) => {
		const { client, tokens } = connect();
		revokeToken(db, client, kind === 'access' ? tokens.access_token : tokens.refresh_token);
		expect(resolveAccessToken(db, tokens.access_token, NOW)).toBeNull();
		expect(listConnectedApps(db, userId)).toEqual([]);
	});

	it('disconnecting from settings is scoped to the owner', () => {
		const { tokens } = connect();
		const [app] = listConnectedApps(db, userId);
		const stranger = db
			.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)')
			.run('other@illinois.edu', NOW).lastInsertRowid;

		expect(disconnectApp(db, stranger, app.id)).toBe(false);
		expect(resolveAccessToken(db, tokens.access_token, NOW)).not.toBeNull();
		expect(disconnectApp(db, userId, app.id)).toBe(true);
		expect(resolveAccessToken(db, tokens.access_token, NOW)).toBeNull();
	});

	it('housekeeping drops unused dynamic clients but keeps connected ones', () => {
		const unused = publicClient();
		const { client } = connect();
		deleteStaleOAuthRows(db, NOW + 2 * 24 * 3600);
		const ids = db
			.prepare<{ id: string }>('SELECT id FROM oauth_client')
			.all()
			.map((r) => r.id);
		expect(ids).toEqual([client.id]);
		expect(ids).not.toContain(unused.id);
	});
});

describe('confidential clients', () => {
	it('require their secret', () => {
		const { client, clientSecret } = registerClient(
			db,
			{ name: 'x', redirectUris: [REDIRECT], confidential: true, source: 'manual' },
			NOW
		);
		expect(() => authenticateClient(db, client.id, null)).toThrow(OAuthError);
		expect(() => authenticateClient(db, client.id, 'uieats_cs_wrong')).toThrow(OAuthError);
		expect(authenticateClient(db, client.id, clientSecret).id).toBe(client.id);
		// Nothing secret is stored in the clear.
		expect(JSON.stringify(db.prepare('SELECT * FROM oauth_client').all())).not.toContain(
			clientSecret
		);
	});
});

describe('wire format', () => {
	it('registers dynamically, then exchanges over HTTP with client_secret_basic', async () => {
		const reg = await handleRegisterRequest(
			db,
			new Request('http://localhost/oauth/register', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ client_name: 'Gemini', redirect_uris: [REDIRECT] })
			})
		);
		expect(reg.status).toBe(201);
		const { client_id, client_secret } = await reg.json();
		expect(client_secret).toBeTruthy();

		const { verifier, challenge } = pkce();
		const code = issueCode(db, {
			clientId: client_id,
			userId,
			redirectUri: REDIRECT,
			codeChallenge: challenge,
			scope: 'mcp'
		});
		const basic = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
		const res = await handleTokenRequest(
			db,
			new Request('http://localhost/oauth/token', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					authorization: `Basic ${basic}`
				},
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code,
					redirect_uri: REDIRECT,
					code_verifier: verifier
				}).toString()
			})
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ token_type: 'Bearer', scope: 'mcp' });
		expect(resolveAccessToken(db, body.access_token)).toMatchObject({ id: userId });
	});
});

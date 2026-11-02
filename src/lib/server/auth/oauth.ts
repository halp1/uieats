/**
 * A minimal OAuth 2.1 authorization server, for MCP clients that cannot take a
 * pasted token.
 *
 * Exactly one flow: authorization code with PKCE (S256 only), plus refresh.
 * One scope, `mcp`, which is read only. Clients come from dynamic registration
 * (RFC 7591) or from `scripts/oauth-client.ts`.
 *
 * Every secret here (client secret, code, access token, refresh token) is 32
 * random bytes with a recognisable prefix, and only its sha256 is stored, the
 * same rule as sessions and personal access tokens.
 *
 * Pure functions over the database: no SvelteKit, no Request. The routes under
 * `src/routes/oauth` are thin adapters, and the tests drive this module.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/driver.ts';
import { unixNow } from '../../dates.ts';
import type { SessionUser } from './session.ts';

export const SCOPE = 'mcp';
export const ACCESS_TOKEN_TTL = 60 * 60;
export const CODE_TTL = 10 * 60;
/** A dynamic client nobody ever authorized is garbage after this long. */
const UNUSED_CLIENT_TTL = 24 * 60 * 60;
const TOUCH_AFTER_SECONDS = 300;
const MAX_DYNAMIC_PER_HOUR = 200;

const PREFIX = {
	client: 'uieats_client_',
	secret: 'uieats_cs_',
	code: 'uieats_ac_',
	access: 'uieats_at_',
	refresh: 'uieats_rt_'
} as const;

export const ACCESS_TOKEN_PREFIX = PREFIX.access;

/** An OAuth error, carrying the wire `error` code from RFC 6749 / 7591. */
export class OAuthError extends Error {
	code: string;
	status: number;
	constructor(code: string, description: string, status = 400) {
		super(description);
		this.code = code;
		this.status = status;
	}
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function secret(prefix: string): string {
	return prefix + randomBytes(32).toString('base64url');
}

function equalHex(a: string, b: string): boolean {
	const x = Buffer.from(a, 'hex');
	const y = Buffer.from(b, 'hex');
	return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- clients

export interface OAuthClient {
	id: string;
	name: string;
	redirectUris: string[];
	isConfidential: boolean;
	source: 'dynamic' | 'manual';
}

interface ClientRow {
	id: string;
	secret_hash: string | null;
	name: string;
	redirect_uris: string;
	source: string;
}

function toClient(row: ClientRow): OAuthClient {
	return {
		id: row.id,
		name: row.name,
		redirectUris: JSON.parse(row.redirect_uris),
		isConfidential: row.secret_hash !== null,
		source: row.source as OAuthClient['source']
	};
}

/**
 * Plain https anywhere, or http on a loopback host for local tools such as the
 * MCP inspector. No fragments, per RFC 6749 section 3.1.2.
 */
export function isAcceptableRedirectUri(raw: string, allowPrefix = false): boolean {
	if (raw.length > 500) return false;
	const body = allowPrefix && raw.endsWith('*') ? raw.slice(0, -1) : raw;
	// A literal '*' anywhere else would later read as a wildcard.
	if (body.includes('*')) return false;
	let url: URL;
	try {
		url = new URL(body);
	} catch {
		return false;
	}
	if (url.hash !== '' || body.includes('#')) return false;
	// A prefix must pin the host: "https://a.com*" would also match a.com.evil.com.
	if (body !== raw && !body.startsWith(`${url.origin}/`)) return false;
	if (url.protocol === 'https:') return true;
	return (
		url.protocol === 'http:' &&
		(url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
	);
}

export interface RegisterInput {
	name: string;
	redirectUris: string[];
	/** Public clients authenticate with PKCE alone. */
	confidential: boolean;
	source: 'dynamic' | 'manual';
}

export function registerClient(
	db: Db,
	input: RegisterInput,
	now: number = unixNow()
): { client: OAuthClient; clientSecret: string | null } {
	const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Unnamed app';
	const uris = [...new Set(input.redirectUris)];
	if (uris.length === 0 || uris.length > 10) {
		throw new OAuthError('invalid_redirect_uri', 'Between one and ten redirect_uris are required.');
	}
	if (input.source === 'dynamic') {
		// Registration is unauthenticated by design, so it is the one write a
		// stranger can make. Cap the rate rather than the total: housekeeping
		// deletes registrations nobody ever used.
		const recent = db
			.prepare<{ c: number }>(
				"SELECT COUNT(*) AS c FROM oauth_client WHERE source = 'dynamic' AND created_at > ?"
			)
			.get(now - 60 * 60)!.c;
		if (recent >= MAX_DYNAMIC_PER_HOUR) {
			throw new OAuthError('temporarily_unavailable', 'Too many registrations. Try later.', 429);
		}
	}
	const allowPrefix = input.source === 'manual';
	const bad = uris.find((u) => !isAcceptableRedirectUri(u, allowPrefix));
	if (bad !== undefined) {
		throw new OAuthError('invalid_redirect_uri', `Redirect URI not allowed: ${bad}`);
	}

	const id = secret(PREFIX.client);
	const clientSecret = input.confidential ? secret(PREFIX.secret) : null;
	db.prepare(
		`INSERT INTO oauth_client (id, secret_hash, name, redirect_uris, source, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(
		id,
		clientSecret === null ? null : sha256(clientSecret),
		name,
		JSON.stringify(uris),
		input.source,
		now
	);

	return {
		client: {
			id,
			name,
			redirectUris: uris,
			isConfidential: clientSecret !== null,
			source: input.source
		},
		clientSecret
	};
}

export function getClient(db: Db, id: string | null | undefined): OAuthClient | null {
	if (!id) return null;
	const row = db
		.prepare<ClientRow>(
			'SELECT id, secret_hash, name, redirect_uris, source FROM oauth_client WHERE id = ?'
		)
		.get(id);
	return row ? toClient(row) : null;
}

/** Exact match, except an operator-registered entry ending in `*` is a prefix. */
export function redirectUriAllowed(client: OAuthClient, uri: string): boolean {
	return client.redirectUris.some((allowed) =>
		client.source === 'manual' && allowed.endsWith('*')
			? uri.startsWith(allowed.slice(0, -1)) && isAcceptableRedirectUri(uri)
			: allowed === uri
	);
}

/**
 * Client authentication at the token and revocation endpoints. A confidential
 * client must prove its secret. A public client is identified by id alone and
 * leans on PKCE, which is the point of PKCE.
 */
export function authenticateClient(
	db: Db,
	id: string | null,
	presentedSecret: string | null
): OAuthClient {
	const row = id
		? db
				.prepare<ClientRow>(
					'SELECT id, secret_hash, name, redirect_uris, source FROM oauth_client WHERE id = ?'
				)
				.get(id)
		: undefined;
	if (!row) throw new OAuthError('invalid_client', 'Unknown client.', 401);
	if (row.secret_hash !== null) {
		if (!presentedSecret || !equalHex(row.secret_hash, sha256(presentedSecret))) {
			throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
		}
	}
	return toClient(row);
}

// ----------------------------------------------------------- authorization

export interface AuthorizeParams {
	responseType: string | null;
	clientId: string | null;
	redirectUri: string | null;
	codeChallenge: string | null;
	codeChallengeMethod: string | null;
	scope: string | null;
	state: string | null;
}

export function readAuthorizeParams(params: URLSearchParams | FormData): AuthorizeParams {
	const get = (k: string) => {
		const v = params.get(k);
		return typeof v === 'string' && v !== '' ? v : null;
	};
	return {
		responseType: get('response_type'),
		clientId: get('client_id'),
		redirectUri: get('redirect_uri'),
		codeChallenge: get('code_challenge'),
		codeChallengeMethod: get('code_challenge_method'),
		scope: get('scope'),
		state: get('state')
	};
}

export type AuthorizeCheck =
	/** Cannot safely send the user back anywhere: show the error here. */
	| { kind: 'fatal'; message: string }
	/** Send the error back to the client's redirect URI. */
	| { kind: 'redirect-error'; redirectUri: string; error: string; description: string }
	| { kind: 'ok'; client: OAuthClient; redirectUri: string; codeChallenge: string; scope: string };

/**
 * Validation order matters. Until the client and redirect URI are both known
 * good, an error must NOT redirect, or this endpoint becomes an open redirect.
 */
export function checkAuthorizeRequest(db: Db, p: AuthorizeParams): AuthorizeCheck {
	const client = getClient(db, p.clientId);
	if (!client) return { kind: 'fatal', message: 'This app is not registered with uieats.' };

	let redirectUri = p.redirectUri;
	if (
		redirectUri === null &&
		client.redirectUris.length === 1 &&
		!client.redirectUris[0].endsWith('*')
	) {
		redirectUri = client.redirectUris[0];
	}
	if (redirectUri === null || !redirectUriAllowed(client, redirectUri)) {
		return {
			kind: 'fatal',
			message: 'This app asked to return to an address it did not register.'
		};
	}

	const fail = (error: string, description: string): AuthorizeCheck => ({
		kind: 'redirect-error',
		redirectUri: redirectUri!,
		error,
		description
	});

	if (p.responseType !== 'code') {
		return fail('unsupported_response_type', 'Only response_type=code is supported.');
	}
	if (!p.codeChallenge || !/^[A-Za-z0-9_-]{43,128}$/.test(p.codeChallenge)) {
		return fail('invalid_request', 'PKCE code_challenge is required.');
	}
	if ((p.codeChallengeMethod ?? 'plain') !== 'S256') {
		return fail('invalid_request', 'code_challenge_method must be S256.');
	}

	// Unknown scopes are dropped rather than refused: clients routinely ask for
	// openid/profile out of habit, and there is only one thing to grant anyway.
	return { kind: 'ok', client, redirectUri, codeChallenge: p.codeChallenge, scope: SCOPE };
}

export function withQuery(uri: string, params: Record<string, string | null>): string {
	const url = new URL(uri);
	for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
	return url.toString();
}

export function issueCode(
	db: Db,
	input: {
		clientId: string;
		userId: number;
		redirectUri: string;
		codeChallenge: string;
		scope: string;
	},
	now: number = unixNow()
): string {
	const code = secret(PREFIX.code);
	db.prepare(
		`INSERT INTO oauth_code (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(
		sha256(code),
		input.clientId,
		input.userId,
		input.redirectUri,
		input.codeChallenge,
		input.scope,
		now + CODE_TTL
	);
	return code;
}

// ------------------------------------------------------------------ tokens

export interface TokenResponse {
	access_token: string;
	token_type: 'Bearer';
	expires_in: number;
	refresh_token: string;
	scope: string;
}

function issueAccessToken(db: Db, grantId: number, now: number): string {
	const token = secret(PREFIX.access);
	db.prepare(
		'INSERT INTO oauth_access_token (token_hash, grant_id, expires_at) VALUES (?, ?, ?)'
	).run(sha256(token), grantId, now + ACCESS_TOKEN_TTL);
	return token;
}

function s256(verifier: string): string {
	return createHash('sha256').update(verifier).digest('base64url');
}

export function exchangeCode(
	db: Db,
	client: OAuthClient,
	input: { code: string | null; redirectUri: string | null; codeVerifier: string | null },
	now: number = unixNow()
): TokenResponse {
	if (!input.code || !input.codeVerifier) {
		throw new OAuthError('invalid_request', 'code and code_verifier are required.');
	}

	const hash = sha256(input.code);
	const replayOf = db
		.prepare<{ grant_id: number | null }>(
			`SELECT grant_id FROM oauth_code
			 WHERE code_hash = ? AND client_id = ? AND consumed_at IS NOT NULL`
		)
		.get(hash, client.id);
	if (replayOf) {
		// A replay. Whoever holds this code is not who it was issued to, or the
		// legitimate client is retrying something it already received: either
		// way the tokens it produced can no longer be trusted. Done outside the
		// transaction below so the throw does not roll the revocation back.
		if (replayOf.grant_id !== null) {
			db.prepare('DELETE FROM oauth_grant WHERE id = ?').run(replayOf.grant_id);
		}
		throw new OAuthError('invalid_grant', 'Authorization code already used.');
	}

	return db.transaction(() => {
		const row = db
			.prepare<{
				client_id: string;
				user_id: number;
				redirect_uri: string;
				code_challenge: string;
				scope: string;
				expires_at: number;
				consumed_at: number | null;
				grant_id: number | null;
			}>(
				`SELECT client_id, user_id, redirect_uri, code_challenge, scope, expires_at, consumed_at, grant_id
				 FROM oauth_code WHERE code_hash = ?`
			)
			.get(hash);

		if (!row || row.client_id !== client.id) {
			throw new OAuthError('invalid_grant', 'Unknown authorization code.');
		}
		// Raced by a concurrent exchange of the same code.
		if (row.consumed_at !== null) {
			throw new OAuthError('invalid_grant', 'Authorization code already used.');
		}
		if (row.expires_at <= now) throw new OAuthError('invalid_grant', 'Authorization code expired.');
		if (input.redirectUri !== null && input.redirectUri !== row.redirect_uri) {
			throw new OAuthError('invalid_grant', 'redirect_uri does not match.');
		}
		if (!equalHex(sha256(s256(input.codeVerifier!)), sha256(row.code_challenge))) {
			throw new OAuthError('invalid_grant', 'PKCE verification failed.');
		}

		const refresh = secret(PREFIX.refresh);
		const grantId = db
			.prepare(
				`INSERT INTO oauth_grant (client_id, user_id, refresh_hash, scope, created_at, last_used_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(client.id, row.user_id, sha256(refresh), row.scope, now, now).lastInsertRowid;
		db.prepare('UPDATE oauth_code SET consumed_at = ?, grant_id = ? WHERE code_hash = ?').run(
			now,
			grantId,
			hash
		);

		return {
			access_token: issueAccessToken(db, grantId, now),
			token_type: 'Bearer' as const,
			expires_in: ACCESS_TOKEN_TTL,
			refresh_token: refresh,
			scope: row.scope
		};
	});
}

/**
 * Persistent refresh: the same refresh token comes back. Google's account
 * linking asks for this, and it means a response lost in transit cannot strand
 * the client holding a refresh token that no longer exists.
 */
export function refreshTokens(
	db: Db,
	client: OAuthClient,
	refreshToken: string | null,
	now: number = unixNow()
): TokenResponse {
	if (!refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required.');
	const grant = db
		.prepare<{ id: number; client_id: string; scope: string }>(
			'SELECT id, client_id, scope FROM oauth_grant WHERE refresh_hash = ?'
		)
		.get(sha256(refreshToken));
	if (!grant || grant.client_id !== client.id) {
		throw new OAuthError('invalid_grant', 'Unknown or revoked refresh token.');
	}

	return db.transaction(() => {
		db.prepare('UPDATE oauth_grant SET last_used_at = ? WHERE id = ?').run(now, grant.id);
		// Expired access tokens for this grant are dead weight; drop them here
		// rather than waiting for housekeeping.
		db.prepare('DELETE FROM oauth_access_token WHERE grant_id = ? AND expires_at <= ?').run(
			grant.id,
			now
		);
		return {
			access_token: issueAccessToken(db, grant.id, now),
			token_type: 'Bearer' as const,
			expires_in: ACCESS_TOKEN_TTL,
			refresh_token: refreshToken,
			scope: grant.scope
		};
	});
}

/**
 * RFC 7009. Either token type revokes the whole grant, which is what a user
 * disconnecting an app means. Unknown tokens are not an error.
 */
export function revokeToken(db: Db, client: OAuthClient, token: string | null): void {
	if (!token) return;
	const hash = sha256(token);
	const grantId =
		db
			.prepare<{ id: number }>(
				'SELECT id FROM oauth_grant WHERE refresh_hash = ? AND client_id = ?'
			)
			.get(hash, client.id)?.id ??
		db
			.prepare<{ id: number }>(
				`SELECT g.id FROM oauth_access_token t JOIN oauth_grant g ON g.id = t.grant_id
				 WHERE t.token_hash = ? AND g.client_id = ?`
			)
			.get(hash, client.id)?.id;
	if (grantId !== undefined) db.prepare('DELETE FROM oauth_grant WHERE id = ?').run(grantId);
}

export function resolveAccessToken(
	db: Db,
	raw: string | null | undefined,
	now: number = unixNow()
): SessionUser | null {
	if (!raw || !raw.startsWith(PREFIX.access)) return null;
	const hash = sha256(raw);
	const row = db
		.prepare<{
			token_hash: string;
			expires_at: number;
			grant_id: number;
			last_used_at: number | null;
			user_id: number;
			email: string;
			display_name: string | null;
		}>(
			`SELECT t.token_hash, t.expires_at, t.grant_id, g.last_used_at, u.id AS user_id, u.email, u.display_name
			 FROM oauth_access_token t
			 JOIN oauth_grant g ON g.id = t.grant_id
			 JOIN user u ON u.id = g.user_id
			 WHERE t.token_hash = ?`
		)
		.get(hash);
	if (!row || !equalHex(row.token_hash, hash) || row.expires_at <= now) return null;

	if (row.last_used_at === null || now - row.last_used_at >= TOUCH_AFTER_SECONDS) {
		db.prepare('UPDATE oauth_grant SET last_used_at = ? WHERE id = ?').run(now, row.grant_id);
	}
	return { id: row.user_id, email: row.email, displayName: row.display_name };
}

// -------------------------------------------------------- user management

export interface ConnectedApp {
	id: number;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
}

export function listConnectedApps(db: Db, userId: number): ConnectedApp[] {
	return db
		.prepare<{ id: number; name: string; created_at: number; last_used_at: number | null }>(
			`SELECT g.id, c.name, g.created_at, g.last_used_at
			 FROM oauth_grant g JOIN oauth_client c ON c.id = g.client_id
			 WHERE g.user_id = ? ORDER BY g.created_at DESC, g.id DESC`
		)
		.all(userId)
		.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

/** Scoped to the user in SQL. Cascades to the grant's access tokens. */
export function disconnectApp(db: Db, userId: number, grantId: number): boolean {
	return (
		db.prepare('DELETE FROM oauth_grant WHERE id = ? AND user_id = ?').run(grantId, userId)
			.changes > 0
	);
}

export function deleteStaleOAuthRows(db: Db, now: number = unixNow()): number {
	let n = 0;
	n += db.prepare('DELETE FROM oauth_access_token WHERE expires_at <= ?').run(now).changes;
	// Kept a day past expiry so a late replay is still recognised as one.
	n += db.prepare('DELETE FROM oauth_code WHERE expires_at <= ?').run(now - 24 * 60 * 60).changes;
	n += db
		.prepare(
			`DELETE FROM oauth_client
			 WHERE source = 'dynamic' AND created_at <= ?
			   AND NOT EXISTS (SELECT 1 FROM oauth_grant g WHERE g.client_id = oauth_client.id)`
		)
		.run(now - UNUSED_CLIENT_TTL).changes;
	return n;
}

// ---------------------------------------------------------------- metadata

export function authorizationServerMetadata(origin: string) {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/oauth/token`,
		registration_endpoint: `${origin}/oauth/register`,
		revocation_endpoint: `${origin}/oauth/revoke`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
		revocation_endpoint_auth_methods_supported: [
			'client_secret_basic',
			'client_secret_post',
			'none'
		],
		scopes_supported: [SCOPE],
		service_documentation: `${origin}/settings/tokens`
	};
}

/** `resourcePath` is the MCP endpoint the metadata describes, e.g. `/mcp/me`. */
export function protectedResourceMetadata(origin: string, resourcePath: string) {
	return {
		resource: `${origin}${resourcePath}`,
		authorization_servers: [origin],
		scopes_supported: [SCOPE],
		bearer_methods_supported: ['header'],
		resource_name: 'uieats'
	};
}

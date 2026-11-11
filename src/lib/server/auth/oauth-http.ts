/**
 * Wire format for the OAuth endpoints: parse requests, shape JSON responses.
 * The rules live in `oauth.ts`. This file only translates.
 */
import type { Db } from '../db/driver.ts';
import {
	OAuthError,
	authenticateClient,
	authorizationServerMetadata,
	exchangeCode,
	protectedResourceMetadata,
	refreshTokens,
	registerClient,
	revokeToken
} from './oauth.ts';

/** Token, registration and metadata are called from browser-based clients too. */
export const OAUTH_CORS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version',
	'Access-Control-Max-Age': '86400'
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...OAUTH_CORS,
			...extra
		}
	});
}

export function preflight(): Response {
	return new Response(null, { status: 204, headers: OAUTH_CORS });
}

function errorResponse(err: unknown, usedBasic = false): Response {
	if (!(err instanceof OAuthError)) throw err;
	return json(
		{ error: err.code, error_description: err.message },
		err.status,
		err.status === 401 && usedBasic ? { 'WWW-Authenticate': 'Basic realm="uieats"' } : {}
	);
}

/** Form or JSON bodies; some clients send JSON to the token endpoint anyway. */
async function readParams(request: Request): Promise<URLSearchParams> {
	const type = (request.headers.get('content-type') ?? '').toLowerCase();
	if (type.includes('application/json')) {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const out = new URLSearchParams();
		for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out.set(k, v);
		return out;
	}
	return new URLSearchParams(await request.text());
}

/** client_secret_basic, falling back to client_secret_post or a bare client_id. */
function clientCredentials(
	request: Request,
	params: URLSearchParams
): { id: string | null; secret: string | null; usedBasic: boolean } {
	const header = request.headers.get('authorization');
	const match = header ? /^Basic\s+(\S+)$/i.exec(header.trim()) : null;
	if (match) {
		const decoded = Buffer.from(match[1], 'base64').toString('utf8');
		const i = decoded.indexOf(':');
		if (i > 0) {
			return {
				id: decodeURIComponent(decoded.slice(0, i)),
				secret: decodeURIComponent(decoded.slice(i + 1)),
				usedBasic: true
			};
		}
	}
	return { id: params.get('client_id'), secret: params.get('client_secret'), usedBasic: false };
}

export async function handleTokenRequest(db: Db, request: Request): Promise<Response> {
	const params = await readParams(request);
	const creds = clientCredentials(request, params);
	try {
		const client = authenticateClient(db, creds.id, creds.secret);
		const grantType = params.get('grant_type');
		if (grantType === 'authorization_code') {
			return json(
				exchangeCode(db, client, {
					code: params.get('code'),
					redirectUri: params.get('redirect_uri'),
					codeVerifier: params.get('code_verifier')
				})
			);
		}
		if (grantType === 'refresh_token') {
			return json(refreshTokens(db, client, params.get('refresh_token')));
		}
		throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
	} catch (err) {
		return errorResponse(err, creds.usedBasic);
	}
}

export async function handleRevokeRequest(db: Db, request: Request): Promise<Response> {
	const params = await readParams(request);
	const creds = clientCredentials(request, params);
	try {
		revokeToken(db, authenticateClient(db, creds.id, creds.secret), params.get('token'));
		return json({});
	} catch (err) {
		return errorResponse(err, creds.usedBasic);
	}
}

/** RFC 7591 dynamic client registration. */
export async function handleRegisterRequest(db: Db, request: Request): Promise<Response> {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== 'object') {
			throw new OAuthError('invalid_client_metadata', 'Send client metadata as JSON.');
		}
		const uris = Array.isArray(body.redirect_uris)
			? body.redirect_uris.filter((u): u is string => typeof u === 'string')
			: [];
		const method =
			typeof body.token_endpoint_auth_method === 'string'
				? body.token_endpoint_auth_method
				: 'client_secret_basic';
		if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method)) {
			throw new OAuthError('invalid_client_metadata', `Unsupported auth method ${method}.`);
		}

		const { client, clientSecret } = registerClient(db, {
			name: typeof body.client_name === 'string' ? body.client_name : '',
			redirectUris: uris,
			confidential: method !== 'none',
			source: 'dynamic'
		});

		return json(
			{
				client_id: client.id,
				...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
				client_id_issued_at: Math.floor(Date.now() / 1000),
				client_name: client.name,
				redirect_uris: client.redirectUris,
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: method,
				scope: 'mcp'
			},
			201
		);
	} catch (err) {
		return errorResponse(err);
	}
}

export function authorizationServerMetadataResponse(origin: string): Response {
	return json(authorizationServerMetadata(origin), 200, { 'Cache-Control': 'max-age=3600' });
}

/**
 * The suffix is the path of the MCP endpoint being described (RFC 9728 puts it
 * after the well-known segment). Bare requests describe the personal endpoint,
 * which is the one that needs a token.
 */
export function protectedResourceMetadataResponse(origin: string, suffix: string): Response {
	const path = suffix === '' ? '/mcp/me' : `/${suffix.replace(/^\/+/, '')}`;
	if (path !== '/mcp' && path !== '/mcp/me') return json({ error: 'not_found' }, 404);
	return json(protectedResourceMetadata(origin, path), 200, { 'Cache-Control': 'max-age=3600' });
}

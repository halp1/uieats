/**
 * HTTP entry for the MCP endpoint, kept out of the route so tests can drive it
 * against an in-memory database.
 *
 * Stateless Streamable HTTP with JSON responses: a fresh server and transport
 * per request. Every tool is a synchronous SQLite read, so there is nothing to
 * stream and no session worth holding.
 *
 * Identity comes from a bearer token and ONLY from a bearer token. The session
 * cookie is ignored here, which is what makes `Access-Control-Allow-Origin: *`
 * safe: a page on another origin cannot borrow a signed-in visitor's cookie to
 * read their allergen list.
 *
 * A token that is present but wrong is a 401, never a silent fall back to
 * anonymous. An anonymous answer carries no allergen verdicts, and an agent
 * that did not notice the downgrade could read "no verdicts" as "nothing
 * flagged".
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { parseBearer, resolveApiToken } from '../auth/tokens.ts';
import type { Db } from '../db/driver.ts';
import { buildMcpServer } from './server.ts';

export const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers':
		'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
	'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
	'Access-Control-Max-Age': '86400'
};

function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

function unauthorized(message: string): Response {
	return withCors(
		new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
			status: 401,
			headers: {
				'Content-Type': 'application/json',
				'WWW-Authenticate': `Bearer error="invalid_token", error_description="${message}"`
			}
		})
	);
}

export async function handleMcpRequest(db: Db, request: Request): Promise<Response> {
	const bearer = parseBearer(request.headers.get('authorization'));
	let user = null;
	if (bearer.kind === 'malformed') {
		return unauthorized('Authorization must be "Bearer <token>"');
	}
	if (bearer.kind === 'token') {
		user = resolveApiToken(db, bearer.token);
		if (!user) return unauthorized('Unknown or revoked access token');
	}

	const server = buildMcpServer(db, user);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await server.connect(transport);
	try {
		return withCors(await transport.handleRequest(request));
	} finally {
		// JSON mode has resolved every response by now, so closing is safe.
		await server.close();
	}
}

export function mcpPreflight(): Response {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function mcpMethodNotAllowed(): Response {
	return withCors(
		new Response(
			JSON.stringify({
				jsonrpc: '2.0',
				error: { code: -32000, message: 'Method not allowed. This endpoint is stateless.' },
				id: null
			}),
			{ status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' } }
		)
	);
}

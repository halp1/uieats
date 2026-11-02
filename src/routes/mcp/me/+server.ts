/**
 * The same MCP server as /mcp, but sign-in is required.
 *
 * An OAuth-only client (Gemini, Claude.ai) starts the sign-in flow when its
 * first request gets a 401 pointing at the OAuth metadata. /mcp answers
 * anonymous callers, so such a client would never sign in there. This path is
 * the one to give those clients.
 */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { handleMcpRequest, mcpMethodNotAllowed, mcpPreflight } from '$lib/server/mcp/http';

export const POST: RequestHandler = ({ request, url }) =>
	handleMcpRequest(getDb(), request, { origin: url.origin, requireAuth: true });
export const OPTIONS: RequestHandler = () => mcpPreflight();
export const GET: RequestHandler = () => mcpMethodNotAllowed();
export const DELETE: RequestHandler = () => mcpMethodNotAllowed();

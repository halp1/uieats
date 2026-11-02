/**
 * The MCP endpoint. Everything lives in `$lib/server/mcp`; this only routes.
 * `locals.user` is deliberately never read: see the note in `mcp/http.ts`.
 */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { handleMcpRequest, mcpMethodNotAllowed, mcpPreflight } from '$lib/server/mcp/http';

export const POST: RequestHandler = ({ request }) => handleMcpRequest(getDb(), request);
export const OPTIONS: RequestHandler = () => mcpPreflight();
export const GET: RequestHandler = () => mcpMethodNotAllowed();
export const DELETE: RequestHandler = () => mcpMethodNotAllowed();

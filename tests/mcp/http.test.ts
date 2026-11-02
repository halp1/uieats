/** Thin smoke test of the HTTP boundary: routing of auth, status codes, CORS. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import { createApiToken, revokeApiToken } from '../../src/lib/server/auth/tokens.ts';
import { handleMcpRequest } from '../../src/lib/server/mcp/http.ts';

let db: Db;
let userId: number;

beforeEach(() => {
	db = createMemoryDb();
	userId = db
		.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)')
		.run('student@illinois.edu', 1).lastInsertRowid;
});

function post(body: unknown, auth?: string) {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream'
	};
	if (auth) headers.authorization = auth;
	return handleMcpRequest(
		db,
		new Request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify(body) })
	);
}

const initialize = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 't', version: '0' }
	}
};

describe('POST /mcp', () => {
	it('initializes anonymously and with a valid token, with CORS', async () => {
		const { token } = createApiToken(db, userId, 'test');
		for (const auth of [undefined, `Bearer ${token}`]) {
			const res = await post(initialize, auth);
			expect(res.status).toBe(200);
			expect(res.headers.get('access-control-allow-origin')).toBe('*');
			expect((await res.json()).result.serverInfo.name).toBe('uieats');
		}
	});

	it('rejects bad credentials with 401 rather than falling back to anonymous', async () => {
		const { id, token } = createApiToken(db, userId, 'test');
		revokeApiToken(db, userId, id);
		for (const auth of ['Bearer garbage', 'Basic abc', `Bearer ${token}`]) {
			const res = await post(initialize, auth);
			expect(res.status).toBe(401);
			expect(res.headers.get('www-authenticate')).toMatch(/^Bearer /);
		}
	});
});

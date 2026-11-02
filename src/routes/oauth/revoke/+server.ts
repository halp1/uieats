import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { handleRevokeRequest, preflight } from '$lib/server/auth/oauth-http';

export const POST: RequestHandler = ({ request }) => handleRevokeRequest(getDb(), request);
export const OPTIONS: RequestHandler = () => preflight();

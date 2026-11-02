import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { handleTokenRequest, preflight } from '$lib/server/auth/oauth-http';

export const POST: RequestHandler = ({ request }) => handleTokenRequest(getDb(), request);
export const OPTIONS: RequestHandler = () => preflight();

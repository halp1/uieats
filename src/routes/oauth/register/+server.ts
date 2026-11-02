import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { handleRegisterRequest, preflight } from '$lib/server/auth/oauth-http';

export const POST: RequestHandler = ({ request }) => handleRegisterRequest(getDb(), request);
export const OPTIONS: RequestHandler = () => preflight();

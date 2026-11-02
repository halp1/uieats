import type { RequestHandler } from './$types';
import { preflight, protectedResourceMetadataResponse } from '$lib/server/auth/oauth-http';

export const GET: RequestHandler = ({ url, params }) =>
	protectedResourceMetadataResponse(url.origin, params.path);
export const OPTIONS: RequestHandler = () => preflight();

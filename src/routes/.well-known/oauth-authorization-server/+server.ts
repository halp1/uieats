import type { RequestHandler } from './$types';
import { authorizationServerMetadataResponse, preflight } from '$lib/server/auth/oauth-http';

export const GET: RequestHandler = ({ url }) => authorizationServerMetadataResponse(url.origin);
export const OPTIONS: RequestHandler = () => preflight();

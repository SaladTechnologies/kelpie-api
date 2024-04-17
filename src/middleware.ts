import { Env, AuthedRequest } from './types';
import { error } from './utils/error';

export async function validateAuth(req: AuthedRequest, env: Env) {
	const token = req.headers.get(env.API_HEADER);
	if (!token) {
		return error(401, { error: 'Unauthorized', message: 'API Key required' });
	}
	let idAndOrg = await env.sisyphus_user_tokens.get(token);
	if (!idAndOrg) {
		return error(403, { error: 'Forbidden', message: 'Invalid API Key' });
	}
	const [id, org, project] = idAndOrg.split('|');
	req.userId = id;
	req.saladOrg = org;
	req.saladProject = project;

	return;
}

export async function adminOnly(req: AuthedRequest, env: Env) {
	if (req.userId !== env.ADMIN_ID) {
		return error(403, { error: 'Forbidden', message: 'Admin Only' });
	}
	return;
}

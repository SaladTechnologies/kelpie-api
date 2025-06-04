import { Env, AuthedRequest, ApiKeyValidationResponse, SaladJWTPayload } from './types';
import { error } from './utils/error';
import * as jose from 'jose';
import { listContainerGroups } from './utils/salad';
import { createUser, getUserByUsername } from './db/users';

export async function validateAuth(req: AuthedRequest, env: Env) {
	const kelpieApiKey = req.headers.get(env.API_HEADER);
	const saladApiKey = req.headers.get('Salad-Api-Key');
	const saladOrg = req.headers.get('Salad-Organization-Name');
	const saladProject = req.headers.get('Salad-Project-Name');
	const authHeader = req.headers.get('Authorization');

	if (saladApiKey && (!saladOrg || !saladProject)) {
		return error(400, { error: 'Bad Request', message: 'Salad API Key requires Salad-Organization-Name and Salad-Project-Name headers' });
	} else if (authHeader && !saladProject) {
		return error(400, { error: 'Bad Request', message: 'Bearer Token requires Salad-Project-Name header' });
	}

	if (kelpieApiKey) {
		/**
		 * This remains for backwards compatibility with the old API Key system.
		 */
		let idAndOrg = await env.user_tokens.get(kelpieApiKey);
		if (!idAndOrg) {
			return error(403, { error: 'Forbidden', message: 'Invalid API Key' });
		}
		const [id, org, project] = idAndOrg.split('|');
		req.userId = id;
		req.saladOrg = org;
		req.saladProject = project;
	} else if (saladApiKey && saladOrg && saladProject) {
		/**
		 * If a user includes a Salad API Key, we check if we have a cached user ID and organization.
		 */
		let idAndOrg = await env.user_tokens.get(`${saladApiKey}|${saladProject}`);
		if (idAndOrg) {
			const [id, org, project] = idAndOrg.split('|');
			req.userId = id;
			req.saladOrg = org;
			req.saladProject = project;
		} else {
			/**
			 * If we don't have a cached user ID, we need to validate the API Key.
			 */
			try {
				const payload = await validateSaladApiKey(env, saladApiKey, saladOrg || '');
				req.saladOrg = payload.organization_name;
				payload.organization_id;
				try {
					await listContainerGroups(env, req.saladOrg, saladProject, true);
					req.saladProject = saladProject;
					/**
					 * If everything is valid, we check to see if we have a user provisioned for this org already.
					 */
					const user = await getUserByUsername(env, req.saladOrg);
					let userId: string | undefined;
					if (!user) {
						/**
						 * If we don't have a user, we create one.
						 */
						userId = await createUser(env, req.saladOrg);
					} else {
						userId = user.id;
					}
					req.userId = userId;
					/**
					 * Finally, we cache the user ID and organization for future requests. This token expires
					 * so that we have to revalidate the API Key periodically.
					 */
					await env.user_tokens.put(`${saladApiKey}|${saladProject}`, `${userId}|${req.saladOrg}|${saladProject}`, {
						expirationTtl: parseInt(env.TOKEN_CACHE_TTL),
					});
				} catch (err: any) {
					return error(403, { error: 'Forbidden', message: `Invalid Project '${saladProject}': ${err.message}` });
				}
			} catch (err: any) {
				return error(403, { error: 'Forbidden', message: err.message });
			}
		}
	} else if (authHeader && authHeader.startsWith('Bearer ') && saladProject) {
		const [, imdsJwt] = authHeader.split(' ');
		try {
			/**
			 * If a user includes a Bearer Token, we validate the JWT and extract the organization and workload ID.
			 */
			const payload = await validateSaladJWT(env, imdsJwt);
			req.saladOrg = payload.salad_organization_name;

			/**
			 * We check if we have a cached user ID and organization for the workload ID and organization.
			 */
			const idAndOrg = await env.user_tokens.get(`${payload.salad_workload_id}|${req.saladOrg}`);
			if (idAndOrg) {
				const [id, org, project] = idAndOrg.split('|');
				req.userId = id;
				req.saladOrg = org;
				req.saladProject = project;
			} else {
				/**
				 * If we check to make sure the project exists and is valid.
				 */
				try {
					await listContainerGroups(env, req.saladOrg, saladProject, true);
					req.saladProject = saladProject;

					/**
					 * If everything is valid, we check to see if we have a user provisioned for this org already.
					 */
					const user = await getUserByUsername(env, req.saladOrg);
					let userId: string | undefined;
					if (user) {
						userId = user.id;
					} else {
						userId = await createUser(env, req.saladOrg);
					}

					/**
					 * Finally, we cache the user ID and organization for future requests. This token does not expire
					 * because we validate the JWT on each request.
					 */
					req.userId = userId;
					await env.user_tokens.put(`${payload.salad_workload_id}|${req.saladOrg}`, `${userId}|${req.saladOrg}|${saladProject}`);
				} catch (err: any) {
					return error(403, { error: 'Forbidden', message: `Invalid Project '${saladProject}': ${err.message}` });
				}
			}
		} catch (err: any) {
			return error(403, { error: 'Forbidden', message: err.message });
		}
	} else {
		return error(401, { error: 'Unauthorized', message: 'API Key or Bearer Token Required' });
	}
	return;
}

export async function adminOnly(req: AuthedRequest, env: Env) {
	if (req.userId !== env.ADMIN_ID) {
		return error(403, { error: 'Forbidden', message: 'Admin Only' });
	}
	return;
}

export async function validateSaladApiKey(env: Env, apiKey: string, orgName: string): Promise<ApiKeyValidationResponse> {
	if (!apiKey || !orgName) {
		throw new Error('API Key and Organization Name Required');
	}
	const cacheKey = `${apiKey}:${orgName}`;
	const cacheTtl = parseInt(env.TOKEN_CACHE_TTL);
	const cached = await env.token_cache.get<ApiKeyValidationResponse>(cacheKey, {
		type: 'json',
		cacheTtl,
	});

	if (cached) {
		return cached;
	}

	const response = await fetch(env.AUTH_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Basic ${Buffer.from(`${env.SALAD_USERNAME}:${env.SALAD_PASSWORD}`).toString('base64')}`,
		},
		body: JSON.stringify({ api_key: apiKey, organization_name: orgName }),
	});

	if (!response.ok) {
		console.error(await response.text());
		throw new Error('Error Accessing Authentication Service');
	}

	const body = (await response.json()) as ApiKeyValidationResponse;

	if (!body.is_api_key_valid) {
		throw new Error('Invalid API Key');
	}

	if (!body.is_organization_name_valid) {
		throw new Error('Invalid Organization Name');
	}

	if (!body.is_entitled) {
		throw new Error('This organization is not entitled to use the Kelpie API');
	}

	await env.token_cache.put(cacheKey, JSON.stringify(body), {
		expirationTtl: cacheTtl,
	});

	return body;
}

export async function getJWKs(env: Env): Promise<jose.JSONWebKeySet> {
	const cacheKey = 'jwks';
	const cacheTtl = parseInt(env.JWKS_CACHE_TTL);
	const cached = await env.token_cache.get<jose.JSONWebKeySet>(cacheKey, {
		type: 'json',
		cacheTtl,
	});
	if (cached) {
		return cached;
	}

	const response = await fetch(env.JWKS_URL);
	if (!response.ok) {
		console.error(await response.text());
		throw new Error('Error Accessing JWKS');
	}

	const body = (await response.json()) as jose.JSONWebKeySet;

	await env.token_cache.put(cacheKey, JSON.stringify(body), {
		expirationTtl: cacheTtl,
	});

	return body;
}

export async function validateSaladJWT(env: Env, token: string): Promise<SaladJWTPayload> {
	const jwksRaw = await getJWKs(env);
	const jwks = jose.createLocalJWKSet(jwksRaw);

	const { payload } = await jose.jwtVerify(token, jwks);

	return payload as SaladJWTPayload;
}

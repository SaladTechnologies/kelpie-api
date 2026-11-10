import { Env, AuthedRequest, ApiKeyValidationResponse, SaladJWTPayload } from './types';
import { error } from './utils/error';
import * as jose from 'jose';
import { listContainerGroups } from './utils/salad';
import { createUser, getUserByUsername } from './db/users';
import { Buffer } from 'node:buffer';
import { emitSafeEvent } from './utils/observability';

interface SaladAuthorizationCacheEntry {
	version: 1;
	userId: string;
	requestOrganization: string;
	organization: string;
	project: string;
	expiresAt: number;
}

// Hash a serialized tuple rather than joining with a delimiter. This separates
// this cache from legacy keys/JWT entries and avoids retaining credentials in keys.
export async function saladAuthorizationCacheKey(apiKey: string, organization: string, project: string): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify([apiKey, organization, project]));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return 'salad-auth:v1:' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readSaladAuthorization(raw: string | null, organization: string, project: string): SaladAuthorizationCacheEntry | undefined {
	try {
		const entry = JSON.parse(raw || 'null');
		if (
			entry?.version === 1 &&
			typeof entry.userId === 'string' && entry.userId.trim().length > 0 &&
			entry.requestOrganization === organization &&
			typeof entry.organization === 'string' && entry.organization.trim().length > 0 &&
			entry.project === project &&
			typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) && entry.expiresAt > Date.now()
		) {
			return entry;
		}
	} catch {
		// Untrusted/malformed cache data must never authorize a request.
	}
	return undefined;
}

export async function validateAuth(req: AuthedRequest, env: Env) {
	const kelpieApiKey = req.headers.get(env.API_HEADER);
	const saladApiKey = req.headers.get('Salad-Api-Key');
	const saladOrg = req.headers.get('Salad-Organization');
	const saladProject = req.headers.get('Salad-Project');
	const authHeader = req.headers.get('Authorization');

	if (saladApiKey && (!saladOrg || !saladProject)) {
		return error(400, { error: 'Bad Request', message: 'Salad API Key requires Salad-Organization and Salad-Project headers' });
	} else if (authHeader && !saladProject) {
		return error(400, { error: 'Bad Request', message: 'Bearer Token requires Salad-Project header' });
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
		const cacheKey = await saladAuthorizationCacheKey(saladApiKey, saladOrg, saladProject);
		let cached: SaladAuthorizationCacheEntry | undefined;
		try {
			cached = readSaladAuthorization(await env.user_tokens.get(cacheKey), saladOrg, saladProject);
		} catch {
			emitSafeEvent('auth_cache_error', { operation: 'read', cache: 'salad_authorization' });
			// KV availability is not an authorization decision: validate normally.
		}
		if (cached) {
			req.userId = cached.userId;
			req.saladOrg = cached.organization;
			req.saladProject = cached.project;
		} else {
			/**
			 * If we don't have a cached user ID, we need to validate the API Key.
			 */
			try {
				try {
					const payload = await validateSaladApiKey(env, saladApiKey, saladOrg || '');
					req.saladOrg = payload.organization_name;
				} catch {
					req.saladOrg = saladOrg;
				}
				try {
					await listContainerGroups(env, req.saladOrg, saladProject, true, saladApiKey ?? undefined);
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
					const ttl = Number(env.TOKEN_CACHE_TTL);
					// KV requires a minimum 60s TTL. Invalid configuration disables
					// this optimization rather than failing validated credentials.
					if (Number.isSafeInteger(ttl) && ttl >= 60) {
						const entry: SaladAuthorizationCacheEntry = {
							version: 1,
							userId,
							requestOrganization: saladOrg,
							organization: req.saladOrg,
							project: saladProject,
							expiresAt: Date.now() + ttl * 1000,
						};
						try {
							await env.user_tokens.put(cacheKey, JSON.stringify(entry), { expirationTtl: ttl });
						} catch {
							emitSafeEvent('auth_cache_error', { operation: 'write', cache: 'salad_authorization' });
							// Cache writes are best-effort after successful validation.
						}
					}
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
					await listContainerGroups(env, req.saladOrg, saladProject, true, saladApiKey ?? undefined);
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
		try { await response.body?.cancel(); } catch { /* Best-effort connection cleanup; never expose the response body. */ }
		emitSafeEvent('auth_upstream_error', { operation: 'api_key_validation', http_status: response.status });
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
		emitSafeEvent('auth_entitlement', { entitled: false });
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
		try { await response.body?.cancel(); } catch { /* Best-effort connection cleanup; never expose the response body. */ }
		emitSafeEvent('auth_upstream_error', { operation: 'jwks_fetch', http_status: response.status });
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

	const decoded = jose.decodeJwt(token);

	const { payload } = await jose.jwtVerify(token, jwks);

	return payload as SaladJWTPayload;
}

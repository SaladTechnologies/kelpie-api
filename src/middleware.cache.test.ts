import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { validateAuth, saladAuthorizationCacheKey, validateSaladApiKey, getJWKs } from './middleware';
import { listContainerGroups } from './utils/salad';
import { createUser, getUserByUsername } from './db/users';
import type { AuthedRequest, Env } from './types';

vi.mock('./utils/salad', () => ({ listContainerGroups: vi.fn() }));
vi.mock('./db/users', () => ({ createUser: vi.fn(), getUserByUsername: vi.fn() }));

// Deliberately isolated KV model, with an explicit clock. No network, credentials,
// real bindings or eventual-consistency assumptions are needed for these tests.
function memoryKV() {
	const entries = new Map<string, { value: string; expiresAt?: number }>();
	const get = vi.fn(async (key: string, options?: { type?: string }) => {
		const entry = entries.get(key);
		if (!entry || (entry.expiresAt !== undefined && entry.expiresAt <= Date.now())) return null;
		return options?.type === 'json' ? JSON.parse(entry.value) : entry.value;
	});
	const put = vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
		entries.set(key, { value, expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined });
	});
	return { get, put, entries };
}

let now: number;
let users: ReturnType<typeof memoryKV>;
let tokens: ReturnType<typeof memoryKV>;
let env: Env;
let upstream: ReturnType<typeof vi.fn>;

function request(org = 'org-a', project = 'default', key = 'secret-api-key'): AuthedRequest {
	return new Request('https://example.test/jobs', { headers: {
		'Salad-Api-Key': key, 'Salad-Organization': org, 'Salad-Project': project,
	} }) as AuthedRequest;
}

beforeEach(() => {
	vi.resetAllMocks();
	now = Date.UTC(2026, 10, 10);
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	users = memoryKV();
	tokens = memoryKV();
	env = {
		API_HEADER: 'x-kelpie-key', TOKEN_CACHE_TTL: '60', JWKS_CACHE_TTL: '600',
		AUTH_URL: 'https://auth.example.test', JWKS_URL: 'https://jwks.example.test',
		user_tokens: users, token_cache: tokens,
	} as unknown as Env;
	vi.mocked(listContainerGroups).mockResolvedValue([]);
	vi.mocked(getUserByUsername).mockResolvedValue({ id: 'user-1' } as any);
	vi.mocked(createUser).mockResolvedValue('new-user');
	upstream = vi.fn(async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		return Response.json({ is_api_key_valid: true, is_organization_name_valid: true, is_entitled: true, organization_name: body.organization_name });
	});
	vi.stubGlobal('fetch', upstream);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Salad API-key authorization cache', () => {
	it('validates then reuses the exact identity and does not refresh TTL on hits', async () => {
		const first = request();
		expect(await validateAuth(first, env)).toBeUndefined();
		const key = await saladAuthorizationCacheKey('secret-api-key', 'org-a', 'default');
		expect(users.put).toHaveBeenCalledWith(key, expect.any(String), { expirationTtl: 60 });
		const original = users.entries.get(key);
		now += 30_000;
		const repeated = request();
		expect(await validateAuth(repeated, env)).toBeUndefined();
		expect([repeated.userId, repeated.saladOrg, repeated.saladProject]).toEqual(['user-1', 'org-a', 'default']);
		expect(listContainerGroups).toHaveBeenCalledTimes(1);
		expect(upstream).toHaveBeenCalledTimes(1);
		expect(users.put).toHaveBeenCalledTimes(1);
		expect(users.entries.get(key)).toEqual(original);
	});

	it('separates organizations, projects and keys', async () => {
		for (const req of [request(), request('org-b'), request('org-a', 'other'), request('org-a', 'default', 'another-key')]) {
			expect(await validateAuth(req, env)).toBeUndefined();
		}
		expect(listContainerGroups).toHaveBeenCalledTimes(4);
		expect(users.entries.size).toBe(4);
		expect(listContainerGroups).toHaveBeenCalledWith(env, 'org-b', 'default', true, 'secret-api-key');
	});

	it('uses unambiguous fixed-size credential-free keys', async () => {
		const first = await saladAuthorizationCacheKey('a|b', 'c', 'd');
		const second = await saladAuthorizationCacheKey('a', 'b|c', 'd');
		expect(first).not.toEqual(second);
		expect(first).toMatch(/^salad-auth:v1:[a-f0-9]{64}$/);
	});

	it('does not reuse legacy organization-less or old scoped entries', async () => {
		await users.put('secret-api-key|default', 'wrong-user|other-org|default');
		await users.put('secret-api-key|org-a|default', 'wrong-user|other-org|default');
		const req = request();
		expect(await validateAuth(req, env)).toBeUndefined();
		expect(req.userId).toBe('user-1');
		expect(listContainerGroups).toHaveBeenCalledTimes(1);
	});

	it('revalidates after expiry and denies a revoked key when both caches expire', async () => {
		expect(await validateAuth(request(), env)).toBeUndefined();
		now += 60_001;
		upstream.mockResolvedValue(Response.json({ is_api_key_valid: false }));
		vi.mocked(listContainerGroups).mockRejectedValue(new Error('Forbidden'));
		expect((await validateAuth(request(), env))?.status).toBe(403);
		expect(upstream).toHaveBeenCalledTimes(2);
		expect(users.put).toHaveBeenCalledTimes(1);
	});

	it('rejects a stale KV value even if KV returns it after its embedded expiry', async () => {
		expect(await validateAuth(request(), env)).toBeUndefined();
		const key = await saladAuthorizationCacheKey('secret-api-key', 'org-a', 'default');
		const value = users.entries.get(key)!.value;
		now += 60_001;
		users.get.mockResolvedValue(value);
		expect(await validateAuth(request(), env)).toBeUndefined();
		expect(listContainerGroups).toHaveBeenCalledTimes(2);
	});

	it.each([
		'not json', 'null', '{}',
		JSON.stringify({ version: 1, userId: '', requestOrganization: 'org-a', organization: 'org-a', project: 'default', expiresAt: 9999999999999 }),
		JSON.stringify({ version: 1, userId: 'wrong', requestOrganization: 'org-b', organization: 'org-b', project: 'default', expiresAt: 9999999999999 }),
		JSON.stringify({ version: 1, userId: 'wrong', requestOrganization: 'org-a', organization: 'org-a', project: 'other', expiresAt: 9999999999999 }),
	])('requires validation for malformed or mismatched records (%s)', async (value) => {
		const key = await saladAuthorizationCacheKey('secret-api-key', 'org-a', 'default');
		await users.put(key, value);
		vi.mocked(listContainerGroups).mockRejectedValue(new Error('Forbidden'));
		const req = request();
		expect((await validateAuth(req, env))?.status).toBe(403);
		expect(req.userId).toBeUndefined();
	});

	it('does not leak keys or raw upstream bodies in auth diagnostics', async () => {
		const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		upstream.mockResolvedValue(new Response('raw-sensitive-auth-body', { status: 503 }));
		vi.mocked(listContainerGroups).mockRejectedValue(new Error('Forbidden'));
		expect((await validateAuth(request(), env))?.status).toBe(403);
		const emitted = JSON.stringify([...logs.mock.calls, ...errors.mock.calls]);
		expect(emitted).toContain('api_key_validation');
		expect(emitted).toContain('503');
		expect(emitted).not.toContain('secret-api-key');
		expect(emitted).not.toContain('raw-sensitive-auth-body');
	});

	it('uses normal validation on a cache-read failure', async () => {
		users.get.mockRejectedValue(new Error('KV unavailable'));
		const req = request();
		expect(await validateAuth(req, env)).toBeUndefined();
		expect(req.userId).toBe('user-1');
		expect(listContainerGroups).toHaveBeenCalledTimes(1);
	});

	it('does not authorize when cache reading and upstream project validation fail', async () => {
		users.get.mockRejectedValue(new Error('KV unavailable'));
		vi.mocked(listContainerGroups).mockRejectedValue(new Error('Forbidden'));
		expect((await validateAuth(request(), env))?.status).toBe(403);
	});

	it('does not reject validated credentials when best-effort cache writing fails', async () => {
		users.put.mockRejectedValue(new Error('KV unavailable'));
		const req = request();
		expect(await validateAuth(req, env)).toBeUndefined();
		expect(req.userId).toBe('user-1');
	});

	it('rejects invalid keys or unauthorized projects and does not cache success', async () => {
		upstream.mockResolvedValue(Response.json({ is_api_key_valid: false }));
		vi.mocked(listContainerGroups).mockRejectedValue(new Error('Forbidden'));
		expect((await validateAuth(request(), env))?.status).toBe(403);
		expect(users.put).not.toHaveBeenCalled();
	});

	it('preserves validated canonical organization without mixing the request scope', async () => {
		upstream.mockResolvedValue(Response.json({ is_api_key_valid: true, is_organization_name_valid: true, is_entitled: true, organization_name: 'canonical-org' }));
		const first = request('Org-A');
		expect(await validateAuth(first, env)).toBeUndefined();
		const second = request('Org-A');
		expect(await validateAuth(second, env)).toBeUndefined();
		expect(second.saladOrg).toBe('canonical-org');
		expect(listContainerGroups).toHaveBeenCalledTimes(1);
		await validateAuth(request('org-a'), env);
		expect(listContainerGroups).toHaveBeenCalledTimes(2);
	});

	it('keeps the configured TTL rather than substituting a longer default', async () => {
		env.TOKEN_CACHE_TTL = '120';
		expect(await validateAuth(request(), env)).toBeUndefined();
		expect(users.put).toHaveBeenCalledWith(expect.any(String), expect.any(String), { expirationTtl: 120 });
	});

	it('disables this cache for invalid TTL configuration without rejecting valid auth', async () => {
		env.TOKEN_CACHE_TTL = 'bad';
		expect(await validateAuth(request(), env)).toBeUndefined();
		expect(users.put).not.toHaveBeenCalled();
	});
});

describe('unchanged authentication paths', () => {
	it('uses an existing legacy Kelpie key', async () => {
		await users.put('legacy-key', 'legacy-user|legacy-org|legacy-project');
		const req = new Request('https://example.test/jobs', { headers: { 'x-kelpie-key': 'legacy-key' } }) as AuthedRequest;
		expect(await validateAuth(req, env)).toBeUndefined();
		expect([req.userId, req.saladOrg, req.saladProject]).toEqual(['legacy-user', 'legacy-org', 'legacy-project']);
		expect(listContainerGroups).not.toHaveBeenCalled();
	});

	it('validates a signed JWT and preserves its existing workload cache behavior', async () => {
		const { privateKey, publicKey } = await generateKeyPair('RS256');
		const jwk = await exportJWK(publicKey);
		jwk.kid = 'test-key';
		await tokens.put('jwks', JSON.stringify({ keys: [jwk] }));
		const jwt = await new SignJWT({ salad_organization_name: 'jwt-org', salad_workload_id: 'workload-1' })
			.setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
		const req = new Request('https://example.test/jobs', { headers: { Authorization: 'Bearer ' + jwt, 'Salad-Project': 'default' } }) as AuthedRequest;
		expect(await validateAuth(req, env)).toBeUndefined();
		expect([req.userId, req.saladOrg, req.saladProject]).toEqual(['user-1', 'jwt-org', 'default']);
		expect(users.put).toHaveBeenCalledWith('workload-1|jwt-org', 'user-1|jwt-org|default');
	});
});

describe('failed authentication response cleanup', () => {
	it.each(['api-key', 'jwks'])('cancels %s error bodies without reading or logging them', async (path) => {
		const cancel = vi.fn(async () => {});
		const text = vi.fn();
		upstream.mockResolvedValue({ ok: false, status: 503, body: { cancel }, text });
		const action = path === 'api-key' ? validateSaladApiKey(env, 'secret-api-key', 'org-a') : getJWKs(env);
		await expect(action).rejects.toThrow(path === 'api-key' ? 'Error Accessing Authentication Service' : 'Error Accessing JWKS');
		expect(cancel).toHaveBeenCalledOnce();
		expect(text).not.toHaveBeenCalled();
	});
	it.each(['api-key', 'jwks'])('preserves the %s error when cancellation fails', async (path) => {
		const cancel = vi.fn(async () => { throw new Error('cleanup failure'); });
		upstream.mockResolvedValue({ ok: false, status: 503, body: { cancel } });
		const action = path === 'api-key' ? validateSaladApiKey(env, 'secret-api-key', 'org-a') : getJWKs(env);
		await expect(action).rejects.toThrow(path === 'api-key' ? 'Error Accessing Authentication Service' : 'Error Accessing JWKS');
	});
});

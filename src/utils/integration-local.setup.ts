import { beforeAll } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../index';
import type { Env } from '../types';

const fixtureEnv = env as unknown as Env & { SCHEMAS: string; CONTAINER_FIXTURE: string };
let jwks: { keys: any[] } = { keys: [] };
const group = JSON.parse(fixtureEnv.CONTAINER_FIXTURE);

// No call can escape to a real localhost server or an external network.
// Use the actual Worker router and actual isolated D1/KV for HTTP tests.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	if (url.origin === 'http://localhost:8787') {
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, fixtureEnv, ctx);
		await waitOnExecutionContext(ctx);
		return response;
	}
	if (request.url === fixtureEnv.AUTH_URL && request.method === 'POST') {
		const body = await request.json() as { api_key: string; organization_name: string };
		return Response.json({
			is_api_key_valid: body.api_key === fixtureEnv.TEST_API_KEY,
			is_organization_name_valid: body.organization_name === fixtureEnv.TEST_ORG,
			is_entitled: true,
			organization_id: fixtureEnv.TEST_ORG_ID,
			organization_name: fixtureEnv.TEST_ORG,
		});
	}
	if (request.url === fixtureEnv.JWKS_URL && request.method === 'GET') return Response.json(jwks);
	if (url.origin === 'https://api.salad.com' && request.method === 'GET' &&
		/^\/api\/public\/organizations\/[^/]+\/projects\/[^/]+\/containers$/.test(url.pathname)) {
		const key = request.headers.get('Salad-Api-Key');
		if (key !== fixtureEnv.TEST_API_KEY && key !== fixtureEnv.SALAD_API_KEY)
			return new Response('Invalid fixture key', { status: 403 });
		return Response.json({ items: [group] });
	}
	throw new Error('Unexpected request blocked by isolated integration harness');
}) as typeof fetch;

beforeAll(async () => {
	for (const statement of fixtureEnv.SCHEMAS.split(';').map(s => s.trim()).filter(Boolean)) {
		await fixtureEnv.DB.prepare(statement).run();
	}
	await fixtureEnv.user_tokens.put('178f0334-69b1-4d03-a96b-b9cfc7ee4b22',
		fixtureEnv.ADMIN_ID + '|<ROOT>|<ROOT>');
	await fixtureEnv.salad_cache.put(group.id, JSON.stringify(group));
	const { privateKey, publicKey } = await generateKeyPair('RS256');
	const publicJwk = await exportJWK(publicKey);
	jwks = { keys: [{ ...publicJwk, kid: 'local-integration', alg: 'RS256', use: 'sig' }] };
	fixtureEnv.TEST_JWT = await new SignJWT({
		salad_machine_id: '123',
		salad_organization_id: fixtureEnv.TEST_ORG_ID,
		salad_organization_name: fixtureEnv.TEST_ORG,
		salad_workload_id: 'testgroup123',
		salad_workload_name: 'integration-workload',
	}).setProtectedHeader({ alg: 'RS256', kid: 'local-integration' })
		.setIssuedAt().setExpirationTime('1h').sign(privateKey);
});

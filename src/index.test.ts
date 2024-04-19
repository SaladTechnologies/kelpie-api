import { expect, it, describe } from 'vitest';
import { Env } from './types';
import assert from 'assert';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

// local admin key
const adminToken = '178f0334-69b1-4d03-a96b-b9cfc7ee4b22';

describe('GET /unknown', () => {
	it('should return 404 for an unmatched route', async () => {
		const response = await fetch('http://localhost:8787/unknown', {
			headers: {
				'X-Kelpie-Key': adminToken,
			},
		});
		expect(response.status).toEqual(404);
		const { error } = (await response.json()) as any;
		expect(error).toEqual('Route Not Found');
	});
});

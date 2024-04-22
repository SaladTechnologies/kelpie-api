import { expect, it, describe } from 'vitest';
import { adminToken } from './utils/test';

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

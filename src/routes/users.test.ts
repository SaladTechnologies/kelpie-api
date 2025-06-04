import { expect, it, describe, beforeAll, afterAll } from 'vitest';
import { adminToken, clearUsers, createUser } from '../utils/test';
import { env } from 'cloudflare:test';

beforeAll(clearUsers);

describe('POST /users', () => {
	it('Creates a new user', async () => {
		const response = await fetch('http://localhost:8787/users', {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': adminToken,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				username: 'testuser-post-users',
			}),
		});

		expect(response.status).toEqual(201);

		const { id } = (await response.json()) as any;
		expect(id).toBeDefined();
	});
});

describe('POST /users/:id/token', () => {
	it('Creates a new token for a user', async () => {
		const userResponse = await fetch('http://localhost:8787/users', {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': adminToken,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				username: 'testuser-post-tokens',
			}),
		});
		const user = (await userResponse.json()) as any;

		const response = await fetch(`http://localhost:8787/users/${user.id}/token`, {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': adminToken,
			},
			body: JSON.stringify({
				org_name: 'testorg',
				project_name: 'testproject',
			}),
		});

		expect(response.status).toEqual(201);

		const { token } = (await response.json()) as any;
		expect(token).toBeDefined();
	});
});

describe('GET /users/me', () => {
	it('Returns the current user from a kelpie api key', async () => {
		const { user, token } = await createUser('testuser-get-me-kelpie');
		const response = await fetch('http://localhost:8787/users/me', {
			method: 'GET',
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		const body = await response.text();

		expect(response.status).toEqual(200);

		const userResponse = JSON.parse(body) as any;
		expect(userResponse).toMatchObject(user);
	});

	it('Returns the current user from a Salad API Key', async () => {
		expect(env.TEST_API_KEY).toBeDefined();
		expect(env.TEST_ORG).toBeDefined();
		const response = await fetch('http://localhost:8787/users/me', {
			method: 'GET',
			headers: {
				'Salad-Api-Key': env.TEST_API_KEY!,
				'Salad-Organization': env.TEST_ORG!,
				'Salad-Project': 'default',
			},
		});

		const body = await response.text();

		expect(response.status).toEqual(200);

		const userResponse = JSON.parse(body) as any;
		expect(userResponse.username).toEqual(env.TEST_ORG!);
	});
});

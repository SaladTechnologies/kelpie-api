import { expect, it, describe, beforeAll, afterAll } from 'vitest';
import { adminToken, clearUsers, createUser } from '../utils/test';

beforeAll(clearUsers);
afterAll(clearUsers);

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
	let user: any;
	let token: string;
	beforeAll(async () => {
		await clearUsers();
		const { user: u, token: t } = await createUser('testuser-jobs');
		user = u;
		token = t;
	});

	afterAll(async () => {
		await clearUsers();
	});
	it('Returns the current user', async () => {
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
});

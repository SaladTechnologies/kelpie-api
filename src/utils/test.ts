import { Env } from '../types';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

// local admin key
export const adminToken = '178f0334-69b1-4d03-a96b-b9cfc7ee4b22';

export async function clearUsers() {
	await fetch('http://localhost:8787/users', {
		method: 'DELETE',
		headers: {
			'X-Kelpie-Key': adminToken,
		},
	});
}

export async function clearJobs() {
	await fetch('http://localhost:8787/jobs', {
		method: 'DELETE',
		headers: {
			'X-Kelpie-Key': adminToken,
		},
	});
}

export async function clearScalingRules() {
	await fetch('http://localhost:8787/scaling-rules', {
		method: 'DELETE',
		headers: {
			'X-Kelpie-Key': adminToken,
		},
	});
}

export async function createUser(username: string): Promise<{ user: any; token: string }> {
	const userResp = await fetch('http://localhost:8787/users', {
		method: 'POST',
		headers: {
			'X-Kelpie-Key': adminToken,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			username,
		}),
	});
	const user = (await userResp.json()) as any;

	const tokenResp = await fetch(`http://localhost:8787/users/${user.id}/token`, {
		method: 'POST',
		headers: {
			'X-Kelpie-Key': adminToken,
		},
		body: JSON.stringify({
			org_name: 'testorg',
			project_name: 'testproject',
		}),
	});
	const token = ((await tokenResp.json()) as any).token;

	return { user, token };
}

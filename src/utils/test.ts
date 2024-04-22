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

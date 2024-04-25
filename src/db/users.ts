import { Env, DBUser } from '../types';

export async function createUser(env: Env, username: string): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare('INSERT INTO Users (id, username) VALUES (?, ?)').bind(id, username).run();
	return id;
}

export async function getUserById(env: Env, id: string): Promise<DBUser | null> {
	const { results } = await env.DB.prepare('SELECT * FROM Users WHERE id = ?').bind(id).all();
	if (!results.length) {
		return null;
	}
	return results[0] as unknown as DBUser;
}

export async function getUserByUsername(env: Env, username: string): Promise<DBUser | null> {
	const { results } = await env.DB.prepare('SELECT id FROM Users WHERE username = ?').bind(username).all();
	if (!results.length) {
		return null;
	}
	return results[0] as unknown as DBUser;
}

export async function clearAllNonAdminUsers(env: Env): Promise<void> {
	await env.DB.prepare('DELETE FROM Users WHERE id != ?').bind(env.ADMIN_ID).run();
}

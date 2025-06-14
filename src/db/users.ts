import { Env, DBUser } from '../types';

/**
 * Create a new user in the database.
 * @param env The environment object.
 * @param username The username of the new user.
 * @returns The ID of the newly created user.
 */
export async function createUser(env: Env, username: string): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare('INSERT INTO Users (id, username) VALUES (?, ?)').bind(id, username).run();
	return id;
}

/**
 * Update the username of an existing user.
 * @param env The environment object.
 * @param id The ID of the user to update.
 * @param username The new username for the user.
 */
export async function getUserById(env: Env, id: string): Promise<DBUser | null> {
	const { results } = await env.DB.prepare('SELECT * FROM Users WHERE id = ?').bind(id).all();
	if (!results.length) {
		return null;
	}
	return results[0] as unknown as DBUser;
}

/**
 * Get a user by their username.
 * @param env The environment object.
 * @param username The username of the user to retrieve.
 * @returns The user object, or null if not found.
 */
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

export async function clearAllNonAdminUserTokens(env: Env): Promise<void> {
	let cursor: string | undefined;

	const deletePromises: Promise<void>[] = [];
	do {
		let tokens = await env.user_tokens.list({ cursor });

		if (!tokens.list_complete) {
			cursor = tokens.cursor;
		} else {
			cursor = undefined;
		}

		for (const keyObj of tokens.keys) {
			const val = await env.user_tokens.get(keyObj.name);
			const [userId, orgName, projectName] = val?.split('|') || [];
			if (userId !== env.ADMIN_ID) {
				deletePromises.push(env.user_tokens.delete(keyObj.name));
			}
		}
	} while (cursor);

	await Promise.all(deletePromises);
}

import { expect, it, describe, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { adminToken, clearUsers, clearScalingRules, createUser } from '../utils/test';

let user: any;
let token: string;
beforeAll(async () => {
	await clearUsers();
	await clearScalingRules();
	const { user: u, token: t } = await createUser('testuser-scaling-rules');
	user = u;
	token = t;
});

afterAll(async () => {
	await clearUsers();
	await clearScalingRules();
});

async function createScalingRule(overrides: any = {}): Promise<any> {
	const rule = {
		container_group_id: '014cfb51-fad8-4d9a-a058-68c24477f494',
		min_replicas: 1,
		max_replicas: 10,
		idle_threshold_seconds: 300,
		...overrides,
	};
	const response = await fetch('http://localhost:8787/scaling-rules', {
		method: 'POST',
		headers: {
			'X-Kelpie-Key': token,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(rule),
	});
	return response.json();
}

describe('POST /scaling-rules', () => {
	beforeEach(clearScalingRules);

	it('Creates a new scaling rule', async () => {
		const rule = {
			container_group_id: '014cfb51-fad8-4d9a-a058-68c24477f494',
			min_replicas: 1,
			max_replicas: 10,
			idle_threshold_seconds: 300,
		};
		const response = await fetch('http://localhost:8787/scaling-rules', {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': token,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(rule),
		});
		const createdRule = (await response.json()) as any;
		expect(response.status).toEqual(201);

		expect(createdRule).toMatchObject({ ...rule, org_name: 'testorg', project_name: 'testproject', user_id: user.id });
	});
});

describe('PATCH /scaling-rules/:id', () => {
	beforeEach(clearScalingRules);

	it('Updates an existing scaling rule', async () => {
		const createdRule = await createScalingRule();

		const updatedRule = {
			min_replicas: 3,
		};
		const updateResponse = await fetch(`http://localhost:8787/scaling-rules/${createdRule.container_group_id}`, {
			method: 'PATCH',
			headers: {
				'X-Kelpie-Key': token,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(updatedRule),
		});

		expect(updateResponse.status).toEqual(200);

		const updatedRuleResponse = (await updateResponse.json()) as any;
		expect(updatedRuleResponse).toMatchObject({ ...createdRule, ...updatedRule });
	});
});

describe('GET /scaling-rules', () => {
	beforeEach(clearScalingRules);

	it('Lists all scaling rules', async () => {
		await createScalingRule();

		const response = await fetch('http://localhost:8787/scaling-rules', {
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		expect(response.status).toEqual(200);

		const { _count, rules } = (await response.json()) as any;
		expect(_count).toEqual(1);
		expect(rules).toHaveLength(1);
	});
});

describe('GET /scaling-rules/:id', () => {
	beforeEach(clearScalingRules);

	it('Gets a scaling rule by id', async () => {
		const createdRule = await createScalingRule();

		const response = await fetch(`http://localhost:8787/scaling-rules/${createdRule.container_group_id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		expect(response.status).toEqual(200);

		const rule = (await response.json()) as any;
		expect(rule).toMatchObject(createdRule);
	});
});

describe('DELETE /scaling-rules/:id', () => {
	beforeEach(clearScalingRules);

	it('Deletes a scaling rule', async () => {
		const createdRule = await createScalingRule();

		const response = await fetch(`http://localhost:8787/scaling-rules/${createdRule.container_group_id}`, {
			method: 'DELETE',
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		expect(response.status).toEqual(204);

		const getResponse = await fetch(`http://localhost:8787/scaling-rules/${createdRule.container_group_id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		expect(getResponse.status).toEqual(404);
	});
});

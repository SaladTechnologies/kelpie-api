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
		container_group_id: crypto.randomUUID(),
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
			container_group_id: crypto.randomUUID(),
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

		expect(response.status).toEqual(201);

		const createdRule = (await response.json()) as any;
		expect(createdRule).toMatchObject(rule);
	});
});

describe('PATCH /scaling-rules', () => {
	beforeEach(clearScalingRules);

	it('Updates an existing scaling rule', async () => {
		const createdRule = await createScalingRule();

		const updatedRule = {
			container_group_id: createdRule.container_group_id,
			min_replicas: 3,
		};
		const updateResponse = await fetch('http://localhost:8787/scaling-rules', {
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
		const ruleCreations = [];
		for (let i = 0; i < 3; i++) {
			ruleCreations.push(createScalingRule());
		}
		await Promise.all(ruleCreations);

		const response = await fetch('http://localhost:8787/scaling-rules', {
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		expect(response.status).toEqual(200);

		const { _count, rules } = (await response.json()) as any;
		expect(_count).toEqual(3);
		expect(rules).toHaveLength(3);
	});
});

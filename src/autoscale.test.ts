import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoscaleDependencies, evaluateAllScalingRules, evaluateScalingRule, setReplicasForContainerGroup } from './autoscale';
import { runScheduledAutoscaling } from './index';
import { DBScalingRule, Env, SaladContainerGroup } from './types';

const env = {
	MAX_CONCURRENT_SCALING_RULES: '1',
} as Env;

function makeRule(containerGroupId: string): DBScalingRule {
	return {
		container_group_id: containerGroupId,
		org_name: 'org',
		project_name: 'project',
		container_group_name: `group-${containerGroupId}`,
		user_id: 'user',
		min_replicas: 0,
		max_replicas: 10,
		idle_threshold_seconds: 300,
	};
}

function makeGroup(id: string, status = 'running'): SaladContainerGroup {
	return {
		id,
		current_state: { status },
	} as SaladContainerGroup;
}

function makeDependencies(overrides: Partial<AutoscaleDependencies> = {}): AutoscaleDependencies {
	return {
		listScalingRules: vi.fn(async () => []),
		countActiveAndRecentlyActiveJobsInContainerGroup: vi.fn(async () => 0),
		getContainerGroupByName: vi.fn(async (_env, _org, _project, containerGroupName) =>
			makeGroup(containerGroupName.replace('group-', ''))
		),
		setContainerGroupReplicas: vi.fn(async () => undefined),
		startContainerGroup: vi.fn(async () => undefined),
		stopContainerGroup: vi.fn(async () => undefined),
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('autoscaling failure isolation', () => {
	it('continues with later rules when one rule evaluation fails', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const firstRule = makeRule('first');
		const secondRule = makeRule('second');
		const dependencies = makeDependencies({
			listScalingRules: vi.fn(async () => [firstRule, secondRule]),
			countActiveAndRecentlyActiveJobsInContainerGroup: vi.fn(async (containerGroupId) => {
				if (containerGroupId === firstRule.container_group_id) {
					throw new Error('D1 unavailable');
				}
				return 3;
			}),
		});

		await expect(evaluateAllScalingRules(env, dependencies)).resolves.toBeUndefined();

		expect(dependencies.countActiveAndRecentlyActiveJobsInContainerGroup).toHaveBeenCalledTimes(2);
		expect(dependencies.setContainerGroupReplicas).toHaveBeenCalledOnce();
		expect(dependencies.setContainerGroupReplicas).toHaveBeenCalledWith(env, 'org', 'project', 'group-second', 3);
	});

	it('propagates a failure that occurs before per-rule evaluation', async () => {
		const dependencies = makeDependencies({
			listScalingRules: vi.fn(async () => {
				throw new Error('D1 unavailable');
			}),
		});

		await expect(evaluateAllScalingRules(env, dependencies)).rejects.toThrow('D1 unavailable');
	});

	it('logs and preserves a failed Cron outcome', async () => {
		const error = new Error('could not list scaling rules');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		await expect(runScheduledAutoscaling(env, vi.fn(async () => Promise.reject(error)))).rejects.toBe(error);

		expect(consoleError).toHaveBeenCalledWith(`Scheduled autoscaling evaluation failed: ${error}`);
	});
});

describe('container group lookups', () => {
	it('keeps an ambiguous 404 non-destructive and skips the D1 job count', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const dependencies = makeDependencies({
			getContainerGroupByName: vi.fn(async () => null),
		});

		await evaluateScalingRule(env, makeRule('missing'), dependencies);

		expect(dependencies.countActiveAndRecentlyActiveJobsInContainerGroup).not.toHaveBeenCalled();
		expect(dependencies.startContainerGroup).not.toHaveBeenCalled();
		expect(dependencies.stopContainerGroup).not.toHaveBeenCalled();
		expect(dependencies.setContainerGroupReplicas).not.toHaveBeenCalled();
	});

	it('does not count or scale when the name now belongs to a replacement group', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const dependencies = makeDependencies({
			getContainerGroupByName: vi.fn(async () => makeGroup('replacement')),
		});

		await evaluateScalingRule(env, makeRule('original'), dependencies);

		expect(dependencies.countActiveAndRecentlyActiveJobsInContainerGroup).not.toHaveBeenCalled();
		expect(dependencies.startContainerGroup).not.toHaveBeenCalled();
		expect(dependencies.stopContainerGroup).not.toHaveBeenCalled();
		expect(dependencies.setContainerGroupReplicas).not.toHaveBeenCalled();
	});

	it('does not let direct replica changes target a same-name replacement group', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const dependencies = makeDependencies({
			getContainerGroupByName: vi.fn(async () => makeGroup('replacement')),
		});

		await setReplicasForContainerGroup(env, 5, 'org', 'project', 'group-original', 'original', dependencies);

		expect(dependencies.startContainerGroup).not.toHaveBeenCalled();
		expect(dependencies.stopContainerGroup).not.toHaveBeenCalled();
		expect(dependencies.setContainerGroupReplicas).not.toHaveBeenCalled();
	});

	it('reuses the successful lookup and preserves start-then-set behavior', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const dependencies = makeDependencies({
			getContainerGroupByName: vi.fn(async () => makeGroup('stopped', 'stopped')),
			countActiveAndRecentlyActiveJobsInContainerGroup: vi.fn(async () => 12),
		});

		await evaluateScalingRule(env, makeRule('stopped'), dependencies);

		expect(dependencies.getContainerGroupByName).toHaveBeenCalledOnce();
		expect(dependencies.startContainerGroup).toHaveBeenCalledOnce();
		expect(dependencies.setContainerGroupReplicas).toHaveBeenCalledWith(env, 'org', 'project', 'group-stopped', 10);
		expect(vi.mocked(dependencies.startContainerGroup).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(dependencies.setContainerGroupReplicas).mock.invocationCallOrder[0]
		);
	});
});

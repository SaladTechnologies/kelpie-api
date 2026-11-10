import { afterEach, describe, expect, it, vi } from 'vitest';
import { error } from './error';
import { observeRequest, operationForRequest, recordHandledFailure } from './observability';

afterEach(() => vi.restoreAllMocks());
describe('safe HTTP observability', () => {
	it('records a handled 500 even when execution resolves normally', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const response = await observeRequest(new Request('https://example.test/jobs/secret/heartbeat', { method: 'POST' }), async () =>
			error(500, { error: 'Internal server error', message: 'D1_ERROR: overloaded secret-SQL' }));
		expect(response.status).toBe(500);
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
			event: 'http_response', operation: 'job_heartbeat', http_status: 500,
			outcome: 'http_error', error_kind: 'd1_overload', sample_rate: 1,
		});
		expect(log.mock.calls[0][0]).not.toContain('secret');
	});
	it('retains D1 classification when existing auth handling returns 403', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const response = await observeRequest(new Request('https://test/users/me'), async () =>
			error(403, { message: 'Invalid Project: D1_ERROR: internal failure secret' }));
		expect(response.status).toBe(403);
		expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ http_status: 403, error_kind: 'd1_internal' });
		expect(log.mock.calls[0][0]).not.toContain('secret');
	});
	it('records lifecycle response success, not a job outcome', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const original = new Response('accepted', { status: 202 });
		expect(await observeRequest(new Request('https://test/jobs', { method: 'POST' }), async () => original)).toBe(original);
		expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ http_status: 202, outcome: 'http_success', operation: 'job_submit' });
		expect(JSON.parse(log.mock.calls[0][0]).error_kind).toBeUndefined();
	});
	it('samples successful heartbeat and polling without sampling errors', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await observeRequest(new Request('https://test/work'), async () => new Response('ok'), () => 0.5);
		expect(log).not.toHaveBeenCalled();
		await observeRequest(new Request('https://test/work'), async () => new Response('ok'), () => 0);
		expect(JSON.parse(log.mock.calls[0][0]).sample_rate).toBe(0.01);
		await observeRequest(new Request('https://test/work'), async () => error(403, { message: 'secret' }), () => 0.99);
		expect(JSON.parse(log.mock.calls[1][0])).toMatchObject({ http_status: 403, sample_rate: 1, error_kind: 'forbidden' });
	});
	it('does not log URL parameters, bodies, auth headers or thrown error text', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const request = new Request('https://test/jobs/id-secret?token=query-secret', {
			method: 'GET', headers: { Authorization: 'Bearer header-secret' },
		});
		const thrown = new Error('D1_ERROR: internal SQL body-secret');
		await expect(observeRequest(request, async () => { throw thrown; })).rejects.toBe(thrown);
		expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'http_exception', operation: 'job_get', error_kind: 'd1_internal' });
		expect(log.mock.calls[0][0]).not.toContain('secret');
		expect(operationForRequest(new Request('https://test/unknown-secret'))).toBe('other');
	});
	it('logging failure cannot change response or exception', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('logger unavailable'); });
		const response = new Response('same', { status: 500 });
		expect(await observeRequest(new Request('https://test/jobs'), async () => response)).toBe(response);
		const original = new Error('original');
		await expect(observeRequest(new Request('https://test/jobs'), async () => { throw original; })).rejects.toBe(original);
	});
	it('isolates overlapping requests', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const first = observeRequest(new Request('https://test/jobs/a'), async () => {
			recordHandledFailure('D1_ERROR: overloaded');
			await gate;
			return new Response('', { status: 500 });
		});
		await observeRequest(new Request('https://test/jobs/b'), async () => new Response('', { status: 403 }));
		release();
		await first;
		const records = log.mock.calls.map(([text]) => JSON.parse(text));
		expect(records[0].error_kind).toBe('forbidden');
		expect(records[1].error_kind).toBe('d1_overload');
		expect(records[0].request_id).not.toBe(records[1].request_id);
	});
});

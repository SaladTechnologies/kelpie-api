import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithRetries } from './salad';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('records final upstream failure without URLs or bodies and preserves 404 behavior', async () => {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	const response = new Response('secret-body', { status: 404 });
	const fetchMock = vi.fn().mockResolvedValue(response);
	vi.stubGlobal('fetch', fetchMock);
	expect(await fetchWithRetries('https://api.salad.com/api/public/organizations/secret-org/projects/secret-project/containers',
		{ headers: { 'Salad-Api-Key': 'secret-key' } })).toBe(response);
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
		event: 'salad_api_failure', operation: 'container_list', http_status: 404, attempts: 1, sample_rate: 1,
	});
	expect(log.mock.calls[0][0]).not.toContain('secret');
	expect(await response.text()).toBe('secret-body');
});
it('does not change retry count or delay and records only final failure', async () => {
	vi.useFakeTimers();
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	const response = new Response('', { status: 403 });
	const fetchMock = vi.fn().mockResolvedValue(response);
	vi.stubGlobal('fetch', fetchMock);
	const pending = fetchWithRetries('https://api.salad.com/api/public/organizations/a/projects/b/containers', {}, 3);
	await vi.runAllTimersAsync();
	expect(await pending).toBe(response);
	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(log).toHaveBeenCalledTimes(1);
	expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ http_status: 403, attempts: 3 });
});
it('logs transport failures without exception content and rethrows unchanged', async () => {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	const original = new Error('secret signed URL');
	vi.stubGlobal('fetch', vi.fn().mockRejectedValue(original));
	await expect(fetchWithRetries('https://api.salad.com/a', {})).rejects.toBe(original);
	expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ error_kind: 'transport_error', attempts: 1 });
	expect(log.mock.calls[0][0]).not.toContain('secret');
});

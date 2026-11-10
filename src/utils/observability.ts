import { AsyncLocalStorage } from 'node:async_hooks';

type FailureKind = 'd1_overload' | 'd1_internal' | 'd1_error' | 'application_error';
type RequestContext = { requestId: string; failures: Set<FailureKind> };
const requestContext = new AsyncLocalStorage<RequestContext>();

// Never emit exception text, SQL, URLs, headers, or bodies. Classify in memory only.
export function classifyFailure(value: unknown): FailureKind {
	let message = '';
	if (value instanceof Error) message = value.message;
	else if (typeof value === 'string') message = value;
	const text = message.toLowerCase();
	if (text.includes('d1') && (text.includes('overload') || text.includes('too many requests'))) return 'd1_overload';
	if (text.includes('d1') && text.includes('internal')) return 'd1_internal';
	if (text.includes('d1') || text.includes('sqlite_')) return 'd1_error';
	return 'application_error';
}

export function recordHandledFailure(value: unknown): void {
	try { requestContext.getStore()?.failures.add(classifyFailure(value)); } catch { /* Observability is best effort. */ }
}

export function emitSafeEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
	try {
		const requestId = requestContext.getStore()?.requestId;
		console.log(JSON.stringify({ event, ...fields, ...(requestId ? { request_id: requestId } : {}) }));
	} catch { /* Never change application behavior if logging fails. */ }
}

// A closed set of route templates prevents IDs, secrets and query strings entering logs.
export function operationForRequest(request: Request): string {
	const method = request.method;
	const path = new URL(request.url).pathname;
	const routes: [string, RegExp, string][] = [
		['POST', /^\/jobs$/, 'job_submit'],
		['POST', /^\/jobs\/batch$/, 'job_batch_submit'],
		['GET', /^\/jobs$/, 'job_list'],
		['GET', /^\/jobs\/[^/]+$/, 'job_get'],
		['DELETE', /^\/jobs\/[^/]+$/, 'job_cancel'],
		['GET', /^\/work$/, 'work_poll'],
		['POST', /^\/jobs\/[^/]+\/heartbeat$/, 'job_heartbeat'],
		['POST', /^\/jobs\/[^/]+\/completed$/, 'job_complete'],
		['POST', /^\/jobs\/[^/]+\/failed$/, 'job_fail'],
		['DELETE', /^\/jobs\/container-groups\/[^/]+$/, 'job_group_purge'],
		['DELETE', /^\/jobs$/, 'job_clear'],
		['POST', /^\/users$/, 'user_create'],
		['GET', /^\/users\/me$/, 'user_get'],
		['POST', /^\/users\/[^/]+\/token$/, 'user_token_create'],
		['DELETE', /^\/users$/, 'user_clear'],
		['GET', /^\/scaling-rules$/, 'scaling_rule_list'],
		['POST', /^\/scaling-rules$/, 'scaling_rule_create'],
		['GET', /^\/scaling-rules\/[^/]+$/, 'scaling_rule_get'],
		['PATCH', /^\/scaling-rules\/[^/]+$/, 'scaling_rule_update'],
		['DELETE', /^\/scaling-rules\/[^/]+$/, 'scaling_rule_delete'],
		['DELETE', /^\/scaling-rules$/, 'scaling_rule_clear'],
	];
	return routes.find(([verb, pattern]) => verb === method && pattern.test(path))?.[2] ?? 'other';
}

export async function observeRequest(
	request: Request,
	handle: () => Promise<Response>,
	random: () => number = Math.random
): Promise<Response> {
	const context: RequestContext = { requestId: crypto.randomUUID(), failures: new Set() };
	return requestContext.run(context, async () => {
		const started = Date.now();
		const operation = operationForRequest(request);
		try {
			const response = await handle();
			const failed = response.status >= 400;
			const lifecycle = ['job_submit', 'job_batch_submit', 'job_complete'].includes(operation);
			const sampleRate = failed || lifecycle ? 1 : ['work_poll', 'job_heartbeat'].includes(operation) ? 0.01 : 0.1;
			if (sampleRate === 1 || random() < sampleRate) {
				emitSafeEvent('http_response', {
					operation, http_status: response.status,
					outcome: failed ? 'http_error' : 'http_success',
					error_kind: context.failures.size ? [...context.failures].sort().join(',') :
						response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : undefined,
					duration_ms: Date.now() - started, sample_rate: sampleRate,
				});
			}
			return response;
		} catch (err) {
			emitSafeEvent('http_exception', {
				operation, error_kind: classifyFailure(err), duration_ms: Date.now() - started, sample_rate: 1,
			});
			throw err;
		}
	});
}

export function upstreamOperation(url: string, method?: string): string {
	// Match only known Salad operations. Never return any part of a caller-provided URL.
	try {
		const parsed = new URL(url);
		if (parsed.origin !== 'https://api.salad.com') return 'other';
		const path = parsed.pathname;
		if (/\/instances\/[^/]+\/reallocate$/.test(path)) return 'instance_reallocate';
		if (/\/containers\/[^/]+\/instances$/.test(path)) return 'instance_list';
		if (/\/containers\/[^/]+\/start$/.test(path)) return 'container_start';
		if (/\/containers\/[^/]+\/stop$/.test(path)) return 'container_stop';
		if (/\/containers$/.test(path)) return 'container_list';
		if (/\/containers\/[^/]+$/.test(path)) return method === 'PATCH' ? 'container_scale' : 'container_get';
	} catch { /* Unknown operation. */ }
	return 'other';
}

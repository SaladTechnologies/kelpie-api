import { readFileSync } from 'node:fs';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// This runs the existing HTTP tests entirely in an isolated worker with local
// ephemeral D1/KV. It never loads wrangler.toml, .dev.vars, or a live localhost server.
export default defineWorkersConfig({
	test: {
		include: ['src/index.test.ts', 'src/routes/*.test.ts'],
		setupFiles: ['./src/utils/integration-local.setup.ts'],
		poolOptions: {
			workers: {
				miniflare: {
					compatibilityDate: '2024-02-08',
					compatibilityFlags: ['nodejs_compat'],
					d1Databases: ['DB'],
					kvNamespaces: ['user_tokens', 'token_cache', 'salad_cache', 'banned_workers'],
					bindings: {
						API_HEADER: 'x-kelpie-key',
						MAX_FAILURES_PER_WORKER: '3',
						ADMIN_ID: '00000000-0000-0000-0000-000000000000',
						TOKEN_CACHE_TTL: '60',
						JWKS_CACHE_TTL: '600',
						MAX_CONCURRENT_SCALING_RULES: '4',
						MAX_SALAD_API_RETRIES: '1',
						AUTH_URL: 'https://auth.integration.invalid/validate',
						JWKS_URL: 'https://auth.integration.invalid/jwks',
						SALAD_API_KEY: 'fake-admin-api-key',
						SALAD_PASSWORD: 'fake-password',
						SALAD_USERNAME: 'fake-user',
						TEST_API_KEY: 'fake-customer-api-key',
						TEST_ORG: 'integration-org',
						TEST_ORG_ID: '00000000-0000-0000-0000-000000000001',
						SCHEMAS: ['users', 'jobs', 'scaling-rules'].map(name =>
							readFileSync(new URL('./schemas/' + name + '.sql', import.meta.url), 'utf8')).join('\n'),
						CONTAINER_FIXTURE: readFileSync(new URL('./fixtures/container-group.json', import.meta.url), 'utf8'),
					},
				},
			},
		},
	},
});

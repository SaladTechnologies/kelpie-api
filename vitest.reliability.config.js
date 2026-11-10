import { readFileSync } from 'node:fs';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Isolated, credential-free fixtures. Never load production wrangler.toml or .dev.vars.
export default defineWorkersConfig({
	test: {
		include: ['src/middleware.cache.test.ts', 'src/db/jobs.listing.test.ts', 'src/db/jobs.claim.test.ts', 'src/utils/observability.test.ts', 'src/utils/salad.observability.test.ts'],
		poolOptions: {
			workers: {
				miniflare: {
					compatibilityDate: '2024-02-08',
					compatibilityFlags: ['nodejs_compat'],
					d1Databases: ['DB'],
					kvNamespaces: ['user_tokens', 'token_cache', 'salad_cache', 'banned_workers'],
					bindings: {
						JOBS_SCHEMA: readFileSync(new URL('./schemas/jobs.sql', import.meta.url), 'utf8'),
						LISTING_MIGRATION: readFileSync(new URL('./migrations/0004_add_job_listing_index.sql', import.meta.url), 'utf8'),
					},
				},
			},
		},
	},
});

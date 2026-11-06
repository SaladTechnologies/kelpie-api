import { readFileSync } from 'node:fs';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Deliberately avoid wrangler.toml, .dev.vars, credentials, cron triggers and
// localhost:8787. This suite owns an ephemeral, isolated D1 database.
export default defineWorkersConfig({
	test: {
		include: ['src/db/jobs.autoscale.test.ts', 'src/autoscale.test.ts'],
		poolOptions: {
			workers: {
				miniflare: {
					compatibilityDate: '2025-01-01',
					compatibilityFlags: ['nodejs_compat'],
					d1Databases: ['DB'],
					bindings: {
						JOBS_SCHEMA: readFileSync(new URL('./schemas/jobs.sql', import.meta.url), 'utf8'),
						AUTOSCALE_MIGRATION: readFileSync(
							new URL('./migrations/0003_add_autoscale_timestamp_indexes.sql', import.meta.url),
							'utf8'
						),
					},
				},
			},
		},
	},
});

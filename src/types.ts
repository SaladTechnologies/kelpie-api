import { z } from 'zod';

export interface Env {
	API_KEY: string;
	API_HEADER: string;
	MAX_STORED_CHECKPOINTS: string;
	MAX_HEARTBEAT_AGE: string;
	MAX_FAILED_ATTEMPTS: string;
	MAX_FAILURES_PER_WORKER: string;

	sisyphus_upload_tokens: KVNamespace;
	sisyphus_download_tokens: KVNamespace;
	sisyphus_user_tokens: KVNamespace;
	sisyphus_banned_workers: KVNamespace;

	DB: D1Database;
}

export interface SaladData {
	machine_id?: string;
	container_group_id?: string;
}

export interface StatusWebhook extends SaladData {
	status: string;
	job_id: string;
}

export interface DBJob {
	id: string; // UNIQUEIDENTIFIER
	user_id: string;
	status: 'pending' | 'started' | 'completed' | 'canceled' | 'failed'; // Possible statuses
	created: Date; // TIMESTAMP, defaulting to current timestamp
	started?: Date; // Optional TIMESTAMP
	completed?: Date; // Optional TIMESTAMP
	canceled?: Date; // Optional TIMESTAMP
	failed?: Date; // Optional TIMESTAMP
	command: string; // TEXT
	arguments: string; // TEXT, default '[]'
	input_bucket: string; // TEXT
	input_prefix: string; // TEXT
	checkpoint_bucket: string; // TEXT
	checkpoint_prefix: string; // TEXT
	output_bucket: string; // TEXT
	output_prefix: string; // TEXT
	webhook?: string; // Optional TEXT
	heartbeat?: Date; // Optional TIMESTAMP
	num_failures: number; // INT, default 0
	container_group_id: string; // TEXT
}

export const APIJobSubmissionSchema = z.object({
	command: z.string(),
	arguments: z
		.string()
		.array()
		.default(() => []), // Default as an empty array
	input_bucket: z.string(),
	input_prefix: z.string(),
	checkpoint_bucket: z.string(),
	checkpoint_prefix: z.string(),
	output_bucket: z.string(),
	output_prefix: z.string(),
	webhook: z.string().optional(),
	container_group_id: z.string(),
});

export type APIJobSubmission = z.infer<typeof APIJobSubmissionSchema>;

export const APIJobMetaData = z.object({
	id: z.string(), // UNIQUEIDENTIFIER is typically a UUID in string format
	user_id: z.string(),
	status: z.enum(['pending', 'started', 'completed', 'canceled', 'failed']),
	created: z.date(), // Defaults to the current timestamp
	started: z.date().optional(),
	completed: z.date().optional(),
	canceled: z.date().optional(),
	failed: z.date().optional(),
	heartbeat: z.date().optional(),
	num_failures: z.number().default(0),
});

export const APIJobResponseSchema = APIJobMetaData.merge(APIJobSubmissionSchema);

export type APIJobResponse = z.infer<typeof APIJobResponseSchema>;

export interface AuthedRequest extends Request {
	userId?: string;
	saladOrg?: string;
}

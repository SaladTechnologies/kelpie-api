import { z } from 'zod';

export interface Env {
	API_HEADER: string;
	MAX_FAILURES_PER_WORKER: string;
	SALAD_API_KEY: string;
	ADMIN_ID: string;

	upload_tokens: KVNamespace;
	download_tokens: KVNamespace;
	user_tokens: KVNamespace;
	banned_workers: KVNamespace;
	salad_cache: KVNamespace;

	DB: D1Database;
}

export const SaladDataSchema = z.object({
	machine_id: z.string(),
	container_group_id: z.string(),
});

export type SaladData = z.infer<typeof SaladDataSchema>;

export interface DBJob {
	id: string; // UNIQUEIDENTIFIER
	user_id: string;
	status: 'pending' | 'running' | 'completed' | 'canceled' | 'failed'; // Possible statuses
	created?: Date; // TIMESTAMP, defaulting to current timestamp
	started?: Date; // Optional TIMESTAMP
	completed?: Date; // Optional TIMESTAMP
	canceled?: Date; // Optional TIMESTAMP
	failed?: Date; // Optional TIMESTAMP
	heartbeat?: Date; // Optional TIMESTAMP
	num_failures: number; // INT, default 0
	machine_id?: string; // Optional TEXT

	command: string; // TEXT
	arguments: string; // TEXT, default '[]'
	environment: string; // TEXT, default '{}'
	input_bucket: string; // TEXT
	input_prefix: string; // TEXT
	checkpoint_bucket: string; // TEXT
	checkpoint_prefix: string; // TEXT
	output_bucket: string; // TEXT
	output_prefix: string; // TEXT
	max_failures: number; // INT, default 3
	heartbeat_interval: number; // INT, default 30
	webhook?: string; // Optional TEXT
	container_group_id: string; // TEXT
}

export const APIJobSubmissionSchema = z.object({
	command: z.string(),
	arguments: z.string().array().default([]), // Default as an empty array
	environment: z.record(z.string()).optional().default({}),
	input_bucket: z.string(),
	input_prefix: z.string(),
	checkpoint_bucket: z.string(),
	checkpoint_prefix: z.string(),
	output_bucket: z.string(),
	output_prefix: z.string(),
	max_failures: z.number().optional().default(3),
	heartbeat_interval: z.number().optional().default(30),
	webhook: z.string().optional(),
	container_group_id: z.string(),
});

export type APIJobSubmission = z.infer<typeof APIJobSubmissionSchema>;

export const APIJobMetaData = z.object({
	id: z.string(), // UNIQUEIDENTIFIER is typically a UUID in string format
	user_id: z.string(),
	status: z.enum(['pending', 'running', 'completed', 'canceled', 'failed']),
	created: z.date(), // Defaults to the current timestamp
	started: z.date().optional(),
	completed: z.date().optional(),
	canceled: z.date().optional(),
	failed: z.date().optional(),
	heartbeat: z.date().optional(),
	num_failures: z.number().default(0),
	machine_id: z.string().optional(),
});

export const APIJobResponseSchema = APIJobMetaData.merge(APIJobSubmissionSchema);

export type APIJobResponse = z.infer<typeof APIJobResponseSchema>;

export const APIScalingRuleSchema = z.object({
	container_group_id: z.string().uuid(),
	min_replicas: z.number().int().min(0).max(250),
	max_replicas: z.number().int().min(0).max(250),
	idle_threshold_seconds: z.number().int().min(0).max(3600),
});

export type APIScalingRule = z.infer<typeof APIScalingRuleSchema>;

export const APIScalingRuleUpdateSchema = APIScalingRuleSchema.partial();
export type APIScalingRuleUpdate = z.infer<typeof APIScalingRuleUpdateSchema>;

export const APIScalingRuleResponseSchema = APIScalingRuleSchema.merge(
	z.object({
		user_id: z.string().uuid(),
		created: z.date(),
		updated: z.date().optional(),
	})
);

export interface AuthedRequest extends Request {
	userId?: string;
	saladOrg?: string;
	saladProject?: string;
}

export interface SaladContainerGroup {
	id: string;
	name: string;
	display_name: string;
	container: Container;
	autostart_policy: boolean;
	restart_policy: string;
	replicas: number;
	current_state: CurrentState;
	country_codes: string[];
	networking: Networking;
	create_time: string;
	update_time: string;
	pending_change: boolean;
	version: number;
}

export interface Container {
	image: string;
	resources: ContainerResources;
	command: string[];
	size: number;
	hash: string;
}

export interface ContainerResources {
	cpu: number;
	memory: number;
	gpu_classes: string[];
}

export interface CurrentState {
	status: string;
	description: string;
	start_time: string;
	finish_time: string;
	instance_status_count: InstanceStatusCount;
}

export interface InstanceStatusCount {
	allocating_count: number;
	creating_count: number;
	running_count: number;
	stopping_count: number;
}

export interface Networking {
	protocol: string;
	port: number;
	auth: boolean;
	dns: string;
}

export interface ListContainerGroupsResponse {
	items: SaladContainerGroup[];
}

export interface DBUser {
	id: string;
	username: string;
	created: Date;
}

export interface DBScalingRules {
	container_group_id: string;
	user_id: string;
	created?: Date;
	updated?: Date;
	min_replicas: number;
	max_replicas: number;
	idle_threshold_seconds: number;
}

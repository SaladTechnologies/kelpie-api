export interface Env {
	API_KEY: string;
	API_HEADER: string;
	MAX_STORED_CHECKPOINTS: string;
	MAX_HEARTBEAT_AGE: string;
	MAX_FAILED_ATTEMPTS: string;
	MAX_FAILURES_PER_WORKER: string;
	INPUT_PREFIX: string;
	OUTPUT_PREFIX: string;
	CHECKPOINT_PREFIX: string;

	sisyphus_upload_tokens: KVNamespace;
	sisyphus_download_tokens: KVNamespace;
	sisyphus_user_tokens: KVNamespace;
	sisyphus_banned_workers: KVNamespace;

	DB: D1Database;
	DATA_BUCKET: R2Bucket;
}

export interface SaladData {
	organization_name?: string;
	project_name?: string;
	container_group_name?: string;
	machine_id?: string;
	container_group_id?: string;
}

export interface StatusWebhook extends SaladData {
	status: string;
	job_id: string;
}

export interface UploadDownloadParams {
	key: string;
	prefix: string;
}

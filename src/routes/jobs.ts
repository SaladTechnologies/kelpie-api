import { OpenAPIRoute, Path, Query, Enumeration } from '@cloudflare/itty-router-openapi';
import { error } from '../utils/error';
import { APIJobSubmissionSchema, APIJobResponseSchema, APIJobSubmission, AuthedRequest, SaladData } from '../types';

export class CreateJob extends OpenAPIRoute {
	static schema = {
		summary: 'Create a new job',
		description: 'Create a new job',
		requestBody: APIJobSubmissionSchema,
		responses: {
			'202': {
				description: 'Job created',
				schema: APIJobResponseSchema,
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: any, ctx: any, data: { body: APIJobSubmission }) {
		return error(500, { error: 'Not Implemented', message: 'Not Implemented' });
	}
}

export class GetJob extends OpenAPIRoute {
	static schema = {
		summary: 'Get a job',
		description: 'Get a job by ID',
		parameters: {
			id: Path(String, { description: 'Job ID', required: true }),
		},
		responses: {
			'200': {
				description: 'Job found',
				schema: APIJobResponseSchema,
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'Job not found',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: any, ctx: any, data: { params: { id: string } }) {
		return error(500, { error: 'Not Implemented', message: 'Not Implemented' });
	}
}

export class GetWork extends OpenAPIRoute {
	static schema = {
		summary: 'Get work',
		description: 'Get a job to work on',
		parameters: {
			machine_id: Query(String, { description: 'Machine ID', required: true }),
			container_group_id: Query(String, { description: 'Container Group ID', required: true }),
		},
		responses: {
			'200': {
				description: 'Job found',
				schema: APIJobResponseSchema,
			},
			'204': {
				description: 'No work available',
				schema: {
					error: String,
					message: String,
				},
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: any, ctx: any, data: { query: SaladData }) {
		return error(500, { error: 'Not Implemented', message: 'Not Implemented' });
	}
}

export class JobHeartbeat extends OpenAPIRoute {
	static schema = {
		summary: 'Job heartbeat',
		description: 'Update the heartbeat for a job',
		parameters: {
			id: Path(String, { description: 'Job ID', required: true }),
			machine_id: Query(String, { description: 'Machine ID', required: true }),
			container_group_id: Query(String, { description: 'Container Group ID', required: true }),
		},
		responses: {
			'200': {
				description: 'Job heartbeat updated',
				schema: {
					status: new Enumeration({
						values: ['pending', 'started', 'completed', 'canceled', 'failed'],
						description: 'Job status',
					}),
				},
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'Job not found',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: any, ctx: any, data: { params: { id: string }; query: SaladData }) {
		return error(500, { error: 'Not Implemented', message: 'Not Implemented' });
	}
}

export class ReportJobFailure extends OpenAPIRoute {
	static schema = {
		summary: 'Report job failure',
		description: 'Report a job failure',
		parameters: {
			id: Path(String, { description: 'Job ID', required: true }),
			machine_id: Query(String, { description: 'Machine ID', required: true }),
			container_group_id: Query(String, { description: 'Container Group ID', required: true }),
		},
		responses: {
			'202': {
				description: 'Job failure reported',
				schema: {
					message: String,
				},
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'Job not found',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: any, ctx: any, data: { params: { id: string }; query: SaladData }) {
		return error(500, { error: 'Not Implemented', message: 'Not Implemented' });
	}
}

export class ReportJobCompleted extends OpenAPIRoute {
	static schema = {
		summary: 'Report job completed',
		description: 'Report a job completed',
		parameters: {
			id: Path(String, { description: 'Job ID', required: true }),
			machine_id: Query(String, { description: 'Machine ID', required: true }),
			container_group_id: Query(String, { description: 'Container Group ID', required: true }),
		},
		responses: {
			'202': {
				description: 'Job completed reported',
				schema: {
					message: String,
				},
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'Job not found',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: any, ctx: any, data: { params: { id: string }; query: SaladData }) {
		return error(500, { error: 'Not Implemented', message: 'Not Implemented' });
	}
}

export class CancelJob extends OpenAPIRoute {
	static schema = {
		summary: 'Cancel job',
		description: 'Cancel a job',
		parameters: {
			id: Path(String, { description: 'Job ID', required: true }),
		},
		responses: {
			'202': {
				description: 'Job canceled',
				schema: {
					message: String,
				},
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'Job not found',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: any, ctx: any, data: { params: { id: string } }) {
		return error(500, { error: 'Not Implemented', message: 'Not Implemented' });
	}
}

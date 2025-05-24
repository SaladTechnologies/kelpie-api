import { Env, SaladContainerGroup, ListContainerGroupsResponse, InstanceList } from '../types';

const saladBaseUrl = 'https://api.salad.com/api/public';

export async function getContainerGroupByID(
	env: Env,
	id: string,
	orgName: string,
	projectName: string,
	noCache = false
): Promise<SaladContainerGroup | null> {
	// Check to see if we cached the value already
	if (!noCache) {
		const cachedValue = await env.salad_cache.get(id);
		if (cachedValue) {
			return JSON.parse(cachedValue) as SaladContainerGroup;
		}
	}

	// Fetch the container group from Salad
	const url = `${saladBaseUrl}/organizations/${orgName}/projects/${projectName}/containers`;
	const response = await fetch(url, { headers: { 'Salad-Api-Key': env.SALAD_API_KEY } });
	if (!response.ok) {
		console.log(`Failed to fetch container group: ${response.status}`);
		console.log(await response.text());
		return null;
	}
	const data = (await response.json()) as ListContainerGroupsResponse;
	const containerGroup = data.items.find((group) => group.id === id) || null;

	// Cache the value
	if (containerGroup) {
		await env.salad_cache.put(id, JSON.stringify(containerGroup));
	}
	return containerGroup;
}

export async function reallocateInstance(
	env: Env,
	orgName: string,
	projectName: string,
	containerGroupName: string,
	machineId: string
): Promise<void> {
	const url = `${saladBaseUrl}/organizations/${orgName}/projects/${projectName}/containers/${containerGroupName}/instances/${machineId}/reallocate`;
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Salad-Api-Key': env.SALAD_API_KEY,
		},
	});
	if (!response.ok) {
		if (response.status === 400) {
			const errorResponse = await response.text();
			throw new Error(`Failed to reallocate instance: ${errorResponse}`);
		}
		console.log(`Failed to reallocate instance: ${response.status}: ${response.statusText}`);
		console.log(await response.text());
	}
}

export async function stopContainerGroup(env: Env, orgName: string, projectName: string, containerGroupName: string): Promise<void> {
	const url = `https://api.salad.com/api/public/organizations/${orgName}/projects/${projectName}/containers/${containerGroupName}/stop`;
	const stopResponse = await fetch(url, {
		method: 'POST',
		headers: {
			'Salad-Api-Key': env.SALAD_API_KEY,
		},
	});
	if (!stopResponse.ok) {
		if (stopResponse.status === 400) {
			const errorResponse = await stopResponse.text();
			throw new Error(`Failed to stop container group: ${errorResponse}`);
		}
		throw new Error(`Failed to stop container group: ${stopResponse.status}: ${stopResponse.statusText}`);
	}
	return;
}

export async function startContainerGroup(env: Env, orgName: string, projectName: string, containerGroupName: string): Promise<void> {
	const url = `https://api.salad.com/api/public/organizations/${orgName}/projects/${projectName}/containers/${containerGroupName}/start`;
	const startResponse = await fetch(url, {
		method: 'POST',
		headers: {
			'Salad-Api-Key': env.SALAD_API_KEY,
		},
	});
	if (!startResponse.ok) {
		if (startResponse.status === 400) {
			const errorResponse = await startResponse.text();
			throw new Error(`Failed to start container group: ${errorResponse}`);
		}
		throw new Error(`Failed to start container group: ${startResponse.status}: ${startResponse.statusText}`);
	}
	return;
}

export async function listContainerGroupInstances(
	env: Env,
	orgName: string,
	projectName: string,
	containerGroupName: string
): Promise<InstanceList> {
	const url = `https://api.salad.com/api/public/organizations/${orgName}/projects/${projectName}/containers/${containerGroupName}/instances`;
	const response = await fetch(url, {
		headers: {
			'Salad-Api-Key': env.SALAD_API_KEY,
		},
	});
	if (!response.ok) {
		if (response.status === 400) {
			const errorResponse = await response.text();
			throw new Error(`Failed to list container group instances: ${errorResponse}`);
		}
		throw new Error(`Failed to list container group instances: ${response.status}: ${response.statusText}`);
	}
	const data = (await response.json()) as InstanceList;
	return data;
}

export async function setContainerGroupReplicas(
	env: Env,
	orgName: string,
	projectName: string,
	containerGroupName: string,
	numReplicas: number
): Promise<void> {
	const url = `https://api.salad.com/api/public/organizations/${orgName}/projects/${projectName}/containers/${containerGroupName}`;
	const response = await fetch(url, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/merge-patch+json',
			Accept: 'application/merge-patch+json',
			'Salad-Api-Key': env.SALAD_API_KEY,
		},
		body: JSON.stringify({ replicas: numReplicas }),
	});
	if (!response.ok) {
		if (response.status === 400) {
			const errorResponse = await response.text();
			throw new Error(`Failed to set container group replicas: ${errorResponse}`);
		}
		throw new Error(`Failed to set container group replicas: ${response.status}: ${response.statusText}`);
	}
	return;
}

export async function getContainerGroupByName(
	env: Env,
	orgName: string,
	projectName: string,
	containerGroupName: string
): Promise<SaladContainerGroup | null> {
	const url = `https://api.salad.com/api/public/organizations/${orgName}/projects/${projectName}/containers/${containerGroupName}`;
	const response = await fetch(url, {
		headers: {
			'Salad-Api-Key': env.SALAD_API_KEY,
		},
	});
	if (!response.ok) {
		if (response.status === 400) {
			const errorResponse = await response.text();
			throw new Error(`Failed to get container group: ${errorResponse}`);
		}
		if (response.status === 404) {
			return null;
		}
		throw new Error(`Failed to get container group: ${response.status}: ${response.statusText}`);
	}
	const data = (await response.json()) as SaladContainerGroup;
	return data;
}

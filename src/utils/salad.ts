import { Env, SaladContainerGroup, ListContainerGroupsResponse } from '../types';

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
		console.log(`Failed to reallocate instance: ${response.status}`);
		console.log(await response.text());
	}
}

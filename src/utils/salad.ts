import { Env, SaladContainerGroup, ListContainerGroupsResponse } from '../types';

const saladBaseUrl = 'https://api.salad.com/api/public';

export async function GetContainerGroupByID(
	env: Env,
	id: string,
	orgName: string,
	projectName: string,
	noCache = false
): Promise<SaladContainerGroup | null> {
	// Check to see if we cached the value already
	if (!noCache) {
		const cachedValue = await env.kelpie_salad_cache.get(id);
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
	const data: ListContainerGroupsResponse = await response.json();
	const containerGroup = data.items.find((group) => group.id === id) || null;

	// Cache the value
	if (containerGroup) {
		await env.kelpie_salad_cache.put(id, JSON.stringify(containerGroup));
	}
	return containerGroup;
}

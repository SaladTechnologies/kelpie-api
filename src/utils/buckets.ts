export const sortBucketObjectsByDateDesc = (objects: R2Object[]) => {
	// Sort by .uploaded, newest first
	const sorted = objects.sort((a, b) => {
		if (a.uploaded === b.uploaded) {
			return 0;
		}
		return a.uploaded > b.uploaded ? -1 : 1;
	});
	return sorted;
};

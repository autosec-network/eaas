import type { Chalk } from 'chalk';

export class Helpers {
	/**
	 * Generates a unique RGB color based unique to the provided string ID. The RGB values are clamped to a range that ensures the resulting color is legible
	 *
	 * @param id - The input string used to generate the unique color.
	 * @returns A tuple containing the RGB values [r, g, b].
	 */
	public static uniqueIdColor(id: string): Parameters<InstanceType<typeof Chalk>['rgb']> {
		// Hash the string to a numeric value
		let hash = 0;
		for (let i = 0; i < id.length; i++) {
			const char = id.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash |= 0; // Convert to 32-bit integer
		}

		// Convert the hash to RGB components
		let r = (hash & 0xff0000) >> 16; // Extract red
		let g = (hash & 0x00ff00) >> 8; // Extract green
		let b = hash & 0x0000ff; // Extract blue

		// Clamp RGB values to a more legible range (e.g., 64-200)
		const clamp = (value: number) => Math.max(100, Math.min(222, value));
		r = clamp(r);
		g = clamp(g);
		b = clamp(b);

		return [r, g, b];
	}

	public static precisionFloat(input: string) {
		if (!input.includes('.')) {
			// No decimal point means it's an integer, just return as a float
			return parseFloat(input);
		} else {
			if (input.endsWith('0')) {
				// Replace the last '0' with '1' while keeping other characters unchanged
				return parseFloat(input.substring(0, input.length - 1) + '1');
			} else {
				// If last decimal is not zero, parse as usual
				return parseFloat(input);
			}
		}
	}

	/**
	 * A wrapper around `Promise.allSettled()` that filters and returns only the fulfilled results. This method behaves like `Promise.allSettled()` where one promise failing doesn't stop others.
	 * However, like `Promise.all()`, it only returns the values of successfully fulfilled promises without needing to manually check their status.
	 *
	 * @param promises - An array of promises to be settled.
	 * @returns A promise that resolves to an array of fulfilled values from the input promises.
	 */
	public static getFulfilledResults<T extends unknown>(promises: PromiseLike<T>[]) {
		return Promise.allSettled(promises).then((results) => results.filter((result): result is PromiseFulfilledResult<Awaited<T>> => result.status === 'fulfilled').map((result) => result.value));
	}

	public static isLocal(metadata: WorkerVersionMetadata) {
		return !('timestamp' in metadata);
	}
}

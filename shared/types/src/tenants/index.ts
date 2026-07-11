export type ExtractKeysWithPrefix<T, Prefix extends string> = {
	[K in keyof T]: K extends `${Prefix}${string}` ? K : never;
}[keyof T];

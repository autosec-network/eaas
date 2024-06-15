/**
 * It is used to carry over the types when using the `Object.values()` method.
 */
export type ObjectValues<T> =
	{
		[K in keyof T]: T[K];
	} extends Record<string, infer U>
		? U[]
		: never;

/**
 * It is used to carry over the types when using the `Object.keys()` method.
 */
export type EnumKeys<T extends object> = keyof T;

type MethodKeys<T> = {
	[P in keyof T]: T[P] extends (...args: any[]) => any ? P : never;
}[keyof T];

export type JsonParsed<T> = Omit<T, MethodKeys<T>>;

/**
 * This type is similar to the built-in `Partial<>` type, but it applies recursively to nested objects and arrays.
 * If a property is an array, the elements of the array will also be recursively made optional.
 * If a property is an object, the properties of the object will also be recursively made optional.
 */
export type RecursivePartial<T> = {
	[P in keyof T]?: T[P] extends (infer U)[] ? RecursivePartial<U>[] : T[P] extends object ? RecursivePartial<T[P]> : T[P];
};

/**
 * Returns the union of keys from a given type.
 */
export type UnionKeys<T> = T extends any ? keyof T : never;

/**
 * Defines a type that excludes specific keys from an object type.
 */
export type BlockKeys<T, K extends readonly string[]> = {
	[P in keyof T as P extends K[number] ? never : P]: T[P];
};

/**
 * Mark every property of an object as undefined.
 */
export type UndefinedProperties<T extends object> = {
	[P in keyof T]: undefined;
};

export type CustomLogCallback = (message: string) => void;
export type CustomLoging = boolean | CustomLogCallback;

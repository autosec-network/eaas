import { sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export type AnySQL = AnySQLiteColumn | SQL;

/**
 * @returns a copy of string `x` with all ASCII characters converted to lower case
 * @link https://sqlite.org/lang_corefunc.html#lower
 */
export function lower<T extends unknown = string>(x: AnySQL) {
	return sql<T>`lower(${x})`;
}

/**
 * Works like the sqlite3_mprintf() C-language function and the printf() function from the standard C library.
 * @param format string that specifies how to construct the output string using values taken from subsequent arguments. If the FORMAT argument is missing or NULL then the result is NULL.
 * @param format The %n format is silently ignored and does not consume an argument.
 * @param format The %p format is an alias for %X.
 * @param format The %z format is interchangeable with %s.
 * @param args If there are too few arguments in the argument list, missing arguments are assumed to have a NULL value, which is translated into 0 or 0.0 for numeric formats or an empty string for %s.
 * @link https://sqlite.org/lang_corefunc.html#format
 */
export function format<T extends unknown = string>(format: string, ...args: AnySQL[]) {
	return sql<T>`format(${format}, ${args.join(', ')})`;
}

/**
 * @returns a substring of input string X that begins with the Y-th character and which is Z characters long. The left-most character of X is number 1.
 * @param x If X is a string then characters indices refer to actual UTF-8 characters
 * @param x If X is a BLOB then the indices refer to bytes
 * @param y If Y is negative then the first character of the substring is found by counting from the right rather than the left
 * @param z If Z is negative then the abs(Z) characters preceding the Y-th character are returned
 * @param z If Z is omitted then substr(X,Y) returns all characters through the end of the string X beginning with the Y-th
 * @link https://sqlite.org/lang_corefunc.html#substr
 */
export function substr<T extends unknown = string>(x: AnySQL, y: number, z?: number) {
	if (z !== undefined) {
		return sql<T>`substr(${x}, ${y}, ${z})`;
	} else {
		return sql<T>`substr(${x}, ${y})`;
	}
}

/**
 * @param x interprets its argument as a BLOB
 * @param x If the argument X in "hex(X)" is an integer or floating point number, then "interprets its argument as a BLOB" means that the binary number is first converted into a UTF8 text representation, then that text is interpreted as a BLOB. Hence, "hex(12345678)" renders as "3132333435363738" not the binary representation of the integer value "0000000000BC614E".
 * @returns a string which is the upper-case hexadecimal rendering of the content of that blob
 * @link https://sqlite.org/lang_corefunc.html#lower
 */
export function hex<T extends unknown = string>(x: AnySQL) {
	return sql<T>`hex(${x})`;
}

/**
 * @param x If X contains any characters that are not hexadecimal digits, then unhex(X) returns NULL
 * @param x All hexadecimal digits in X must occur in pairs, with both digits of each pair beginning immediately adjacent to one another, or else unhex(X,Y) returns NULL
 * @param x The X input may contain an arbitrary mix of upper and lower case hexadecimal digits
 * @returns a BLOB value which is the decoding of the hexadecimal string X
 * @link https://sqlite.org/lang_corefunc.html#unhex
 */
export function unhex<T extends unknown = Buffer>(x: string) {
	return sql<T>`unhex(${x})`;
}

/**
 * @param y If the Y argument is omitted, ltrim(X) removes spaces from the left side of X
 * @returns a string formed by removing any and all characters that appear in Y from the left side of X
 * @link https://sqlite.org/lang_corefunc.html#ltrim
 */
export function ltrim<T extends unknown = string>(x: AnySQL, y?: string) {
	if (y !== undefined) {
		return sql<T>`ltrim(${x}, ${y})`;
	} else {
		return sql<T>`ltrim(${x})`;
	}
}

/**
 * @param y If the Y argument is omitted, rtrim(X) removes spaces from the right side of X
 * @returns a string formed by removing any and all characters that appear in Y from the right side of X
 * @link https://sqlite.org/lang_corefunc.html#trim
 */
export function rtrim<T extends unknown = string>(x: AnySQL, y?: string) {
	if (y !== undefined) {
		return sql<T>`rtrim(${x}, ${y})`;
	} else {
		return sql<T>`rtrim(${x})`;
	}
}

/**
 * @param y If the Y argument is omitted, trim(X) removes spaces from both ends of X
 * @returns a string formed by removing any and all characters that appear in Y from both ends of X
 * @link https://sqlite.org/lang_corefunc.html#trim
 */
export function trim<T extends unknown = string>(x: AnySQL, y?: string) {
	if (y !== undefined) {
		return sql<T>`trim(${x}, ${y})`;
	} else {
		return sql<T>`trim(${x})`;
	}
}

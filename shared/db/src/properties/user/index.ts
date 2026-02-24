import * as zm from 'zod/mini';
import * as z4 from 'zod/v4';
import { PropertiesSchema, PropertiesSchema4 } from '../index.js';

export const UserPropertiesSchema = zm.extend(PropertiesSchema, {
	email: zm.email({ pattern: zm.regexes.idnEmail }).check(zm.trim()),
	a_time: zm._default(zm.date(), () => new Date()),
});
export const UserPropertiesSchema4 = PropertiesSchema4.extend({
	email: z4.email({ pattern: z4.regexes.idnEmail }).trim(),
	a_time: z4.date().default(() => new Date()),
});

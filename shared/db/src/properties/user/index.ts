import * as zm from 'zod/mini';
import * as z4 from 'zod/v4';
import { PropertiesSchema, PropertiesSchema4 } from '../index.js';

export const UserPropertiesSchema = zm.extend(PropertiesSchema, {
	email: zm.email({ pattern: zm.regexes.idnEmail }).check(zm.trim()),
	email_verified: zm._default(zm.nullable(zm.date()), null),
	a_time: zm._default(zm.date(), () => new Date()),
});
export const UserPropertiesSchema4 = PropertiesSchema4.extend({
	email: z4.email({ pattern: z4.regexes.idnEmail }).trim(),
	email_verified: z4.date().nullable().default(null),
	a_time: z4.date().default(() => new Date()),
});

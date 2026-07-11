import * as zm from 'zod/mini';
import * as z4 from 'zod/v4';
import { PropertiesSchema, PropertiesSchema4 } from '../index.js';

export const UserPropertiesSchema = zm.extend(PropertiesSchema, {
	email: zm.email({ pattern: zm.regexes.idnEmail }).check(zm.trim()),
	email_verified: zm.nullable(zm.date()),
	a_time: zm.date(),
});
export const UserPropertiesSchema4 = PropertiesSchema4.extend({
	email: z4.email({ pattern: z4.regexes.idnEmail }).trim(),
	email_verified: z4.date().nullable(),
	a_time: z4.date(),
});

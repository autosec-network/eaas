import * as zm from 'zod/mini';
import * as z4 from 'zod/v4';
import { PropertiesSchema, PropertiesSchema4 } from '../index.js';

export const TenantPropertiesSchema = zm.extend(PropertiesSchema, {
	avatar: zm.nullish(zm.url({ protocol: /^https$/, hostname: zm.regexes.domain }).check(zm.trim())),
});
export const TenantPropertiesSchema4 = PropertiesSchema4.extend({
	avatar: z4
		.url({ protocol: /^https$/, hostname: z4.regexes.domain })
		.trim()
		.nullish(),
});

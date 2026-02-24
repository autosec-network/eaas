import * as zm from 'zod/mini';
import * as z4 from 'zod/v4';

export const PropertiesSchema = zm.object({
	c_time: zm._default(zm.date(), () => new Date()),
	m_time: zm._default(zm.date(), () => new Date()),
});
export const PropertiesSchema4 = z4.object({
	c_time: z4.date().default(() => new Date()),
	m_time: z4.date().default(() => new Date()),
});

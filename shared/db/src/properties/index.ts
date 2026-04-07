import * as zm from 'zod/mini';
import * as z4 from 'zod/v4';

export const PropertiesSchema = zm.object({
	m_time: zm._default(zm.date(), () => new Date()),
});
export const PropertiesSchema4 = z4.object({
	m_time: z4.date().default(() => new Date()),
});

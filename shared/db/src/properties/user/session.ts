import * as zm from 'zod/mini';
import * as z4 from 'zod/v4';

export const SessionPropertiesSchema = zm.object({
	b_time: zm._default(zm.date(), () => new Date()),
	lite_binding: zm.instanceof(ArrayBuffer).check(zm.refine((buf) => buf.byteLength === 512 / 8)),
	normal_binding: zm.instanceof(ArrayBuffer).check(zm.refine((buf) => buf.byteLength === 512 / 8)),
	sensitive_binding: zm.instanceof(ArrayBuffer).check(zm.refine((buf) => buf.byteLength === 512 / 8)),
	generated_registration_options: zm.optional(zm.record(zm.string().check(zm.trim(), zm.minLength(1)), zm.any())),
});
// eslint-disable-next-line zod/consistent-schema-var-name
export const SessionPropertiesSchema4 = z4.object({
	b_time: z4.date().default(() => new Date()),
	lite_binding: z4.instanceof(ArrayBuffer).refine((buf) => buf.byteLength === 512 / 8),
	normal_binding: z4.instanceof(ArrayBuffer).refine((buf) => buf.byteLength === 512 / 8),
	sensitive_binding: z4.instanceof(ArrayBuffer).refine((buf) => buf.byteLength === 512 / 8),
	// eslint-disable-next-line zod/no-any-schema
	generated_registration_options: z4.record(z4.string().trim().nonempty(), z4.any()).optional(),
});

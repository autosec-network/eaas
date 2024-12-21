import { OpenAPIHono } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.use('*', async (c, next) => {
	if (Object.values(c.var.permissions).some(({ r_encrypt }) => r_encrypt)) {
		await next();
	} else {
		console.log("Token doesn't have permissions");
		return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action', extensions: { code: 403 } }] }, 403);
	}
});

export default app;

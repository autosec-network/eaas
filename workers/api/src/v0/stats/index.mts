import { OpenAPIHono } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import language from '~/v0/stats/language.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.route('/language', language);

export default app;

import { OpenAPIHono } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types';
import alert from '~/v0/gss/alert';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.route('/alert', alert);

export default app;

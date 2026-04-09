import { OpenAPIHono } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import deleteApp from './delete.mjs';
import finalizeApp from './finalize.mjs';
import initApp from './init.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.route('/', initApp);
app.route('/', finalizeApp);
app.route('/', deleteApp);

export default app;

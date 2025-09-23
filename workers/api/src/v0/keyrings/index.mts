import { OpenAPIHono } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import create from '~/v0/keyrings/create.mjs';
import list from '~/v0/keyrings/list.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.route('/', create);
app.route('/', list);

export default app;

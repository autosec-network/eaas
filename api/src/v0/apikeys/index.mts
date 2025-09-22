import { OpenAPIHono } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import create from '~/v0/apikeys/create.mjs';
import deleteRoute from '~/v0/apikeys/delete.mjs';
import list from '~/v0/apikeys/list.mjs';
import specific from '~/v0/apikeys/specific.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.route('/', create);
app.route('/', list);
app.route('/:token_id', specific);
app.route('/:token_id', deleteRoute);

export default app;

import { OpenAPIHono } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types';
import deleteRoute from '~/v0/apikeys/delete';
import list from '~/v0/apikeys/list';
import specific from '~/v0/apikeys/specific';

// import create from '~/v0/apikeys/create';
// import rotate from '~/v0/apikeys/rotate';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.route('/:token_id', deleteRoute);
app.route('/', list);
app.route('/:token_id', specific);

// app.route('/', create);
// app.route('/:token_id', rotate);

export default app;

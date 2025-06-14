import type { ContextVariables, EnvVars } from '~/types.mjs';

const app = await import('@hono/zod-openapi').then(({ OpenAPIHono }) => new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>());

await import('~/v0/apikeys/list.mjs').then(({ default: list }) => app.route('/', list));
await import('~/v0/apikeys/create.mjs').then(({ default: create }) => app.route('/', create));
await import('~/v0/apikeys/specific.mjs').then(({ default: specific }) => app.route('/:token_id', specific));

export default app;

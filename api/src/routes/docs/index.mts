import { swaggerUI } from '@hono/swagger-ui';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { TimingVariables } from 'hono/timing';
import type { EnvVars } from '~/types.mjs';

const app = new Hono<{ Bindings: EnvVars; Variables: TimingVariables }>();

// Allow only GET on documentation site
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], maxAge: 300 }));

app.get('/', swaggerUI({ url: '/openai' }));

export default app;

import type { RequestIdVariables } from 'hono/request-id';
import type { TimingVariables } from 'hono/timing';

export interface ContextVariables extends TimingVariables, RequestIdVariables {}

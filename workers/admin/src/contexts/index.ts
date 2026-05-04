import { createContextId } from '@builder.io/qwik';

export const DurableObjectInstancesContent: Record<string, Record<string, boolean>> = {};
export type DurableObjectInstancesStore = typeof DurableObjectInstancesContent;
export const DurableObjectInstancesContext = createContextId<DurableObjectInstancesStore>('DurableObjectInstancesContext');

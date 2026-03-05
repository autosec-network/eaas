import type { AdapterSession as OriginalAdapterSession, AdapterUser as OriginalAdapterUser } from '@auth/core/adapters';
import type { Session as OriginalSession, User as OriginalUser } from '@auth/qwik';
import type { SessionPropertiesSchema } from 'db';
import type { UUID } from 'node:crypto';
import type { DOJurisdictions } from 'types';
import type * as zm from 'zod/mini';

type auth_sessions = zm.output<typeof SessionPropertiesSchema>;

declare module '@auth/qwik' {
	interface Session extends OriginalSession, auth_sessions {
		do_jurisdiction?: DOJurisdictions | null;
		do_id?: string;
	}

	interface User extends Omit<OriginalUser, 'id'> {
		id: UUID;
		u_id: {
			hex: string;
			base64: string;
			base64url: string;
		};
		do_id: string;
	}
}

declare module '@auth/core' {
	interface Session extends OriginalSession, auth_sessions {
		do_jurisdiction?: DOJurisdictions | null;
		do_id?: string;
	}

	interface User extends Omit<OriginalUser, 'id'> {
		id: UUID;
		u_id: {
			hex: string;
			base64: string;
			base64url: string;
		};
		do_id: {
			hex: string;
			base64: string;
			base64url: string;
		};
	}
}

declare module '@auth/qwik/adapters' {
	interface AdapterSession extends OriginalAdapterSession, auth_sessions {
		do_jurisdiction?: DOJurisdictions | null;
		do_id?: string;
	}

	interface AdapterUser extends Omit<OriginalAdapterUser, 'id'> {
		id: UUID;
		u_id?: {
			hex: string;
			base64: string;
			base64url: string;
		};
		do_jurisdiction?: DOJurisdictions | null;
		do_id?: string;
	}
}

declare module '@auth/core/adapters' {
	interface AdapterSession extends OriginalAdapterSession, auth_sessions {
		do_jurisdiction?: DOJurisdictions | null;
		do_id?: string;
	}

	interface AdapterUser extends Omit<OriginalAdapterUser, 'id'> {
		id: UUID;
		u_id?: {
			hex: string;
			base64: string;
			base64url: string;
		};
		do_jurisdiction?: DOJurisdictions | null;
		do_id?: string;
	}
}

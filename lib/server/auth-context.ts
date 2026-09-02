import { headers } from 'next/headers';
import { getAuth } from '@/lib/server/auth';
import {
  AccessRepository,
  type AppRole,
  type DatabaseActor,
} from '@/lib/server/db/access-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export interface AuthenticatedActor extends DatabaseActor {
  email: string;
  name: string;
}

export async function getCurrentActor(): Promise<AuthenticatedActor | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const actor = await new AccessRepository(getDatabasePool()).resolveActor(session.user.id);
  if (!actor) return null;
  return {
    ...actor,
    email: session.user.email,
    name: session.user.name,
  };
}

export async function requireUser(): Promise<AuthenticatedActor> {
  const actor = await getCurrentActor();
  if (!actor) throw new Error('Unauthenticated');
  return actor;
}

export async function requireRole(roles: AppRole[]): Promise<AuthenticatedActor> {
  const actor = await requireUser();
  if (!roles.includes(actor.role)) throw new Error('Forbidden');
  return actor;
}

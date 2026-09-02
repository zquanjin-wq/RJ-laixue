import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { getDatabasePool } from '@/lib/server/db/pool';

function createAuth() {
  return betterAuth({
    appName: 'laixue',
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    secret: process.env.BETTER_AUTH_SECRET,
    database: getDatabasePool(),
    emailAndPassword: {
      enabled: true,
    },
    plugins: [admin()],
  });
}

let sharedAuth: ReturnType<typeof createAuth> | undefined;

export function getAuth(): ReturnType<typeof createAuth> {
  sharedAuth ??= createAuth();
  return sharedAuth;
}

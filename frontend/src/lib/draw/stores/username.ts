import { getUserProfile } from '$lib/forum/api/users';

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

export function getUsername(userId: string): string {
  return cache.get(userId) || '';
}

export async function resolveUsername(userId: string): Promise<string> {
  if (!userId) return '';
  if (cache.has(userId)) return cache.get(userId)!;
  if (pending.has(userId)) return pending.get(userId)!;

  const p = getUserProfile(userId)
    .then((u) => {
      const name = u.username || userId;
      cache.set(userId, name);
      return name;
    })
    .catch(() => {
      cache.set(userId, userId);
      return userId;
    })
    .finally(() => {
      pending.delete(userId);
    });

  pending.set(userId, p);
  return p;
}

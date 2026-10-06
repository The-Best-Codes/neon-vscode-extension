import { ApiError, NeonError } from '../core/errors';

export interface Profile {
  id: string;
  name: string;
  email: string;
  username: string;
}

export function parseProfile(value: unknown): Profile {
  if (!value || typeof value !== 'object') {
    throw new NeonError('Neon returned an invalid profile. Try refreshing it.');
  }
  const user = value as Record<string, unknown>;
  if (typeof user.id !== 'string' || !user.id) {
    throw new NeonError('Neon returned an invalid profile. Try refreshing it.');
  }
  const text = (key: string) =>
    typeof user[key] === 'string' ? user[key].trim() : '';
  // Neon has deprecated login in favor of email. Keep it only as a display fallback.
  const email = text('email') || text('login');
  return {
    id: user.id,
    name:
      [text('name'), text('last_name')].filter(Boolean).join(' ') ||
      email ||
      user.id,
    email,
    username: text('login') || email || user.id,
  };
}

export interface ProfileApi {
  getCurrentUser(accessToken: string): Promise<Profile>;
}

export class NeonApi implements ProfileApi {
  constructor(private readonly request: typeof fetch = fetch) {}

  async getCurrentUser(accessToken: string): Promise<Profile> {
    const response = await this.request(
      'https://console.neon.tech/api/v2/users/me',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      },
    );
    if (!response.ok) {
      // Never surface arbitrary response bodies: they may contain credentials or PII.
      throw new ApiError(response.status);
    }
    return parseProfile(await response.json());
  }
}

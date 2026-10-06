import { randomUUID } from 'node:crypto';
import {
  ApiError,
  NeonError,
  SessionExpiredError,
  SignInCancelledError,
} from '../core/errors';
import { parseProfile, type Profile, type ProfileApi } from '../api/neonApi';
import { type OAuthClient, type Tokens } from './oauthClient';

export const SESSION_KEY = 'neon.session.v1';

export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

interface StoredSession {
  version: 1;
  id: string;
  clientId: string;
  tokens: Tokens;
  profile: Profile;
}

export interface AccountSession {
  id: string;
  profile: Profile;
}

function parseSession(raw: string): StoredSession {
  const session = JSON.parse(raw) as StoredSession;
  if (
    session?.version !== 1 ||
    !session.id ||
    typeof session.id !== 'string' ||
    !session.clientId ||
    typeof session.clientId !== 'string' ||
    !session.tokens ||
    typeof session.tokens.accessToken !== 'string' ||
    !session.tokens.accessToken ||
    !Number.isFinite(session.tokens.expiresAt) ||
    session.tokens.expiresAt <= 0 ||
    (session.tokens.refreshToken !== undefined &&
      typeof session.tokens.refreshToken !== 'string')
  ) {
    throw new Error('Invalid stored session');
  }
  // Validate the cached display model separately from the API response shape.
  const validated = parseProfile(session.profile);
  session.profile = {
    ...validated,
    username:
      typeof session.profile.username === 'string'
        ? session.profile.username
        : validated.username,
  };
  return session;
}

/** Owns one account. Tokens stay behind this boundary and in SecretStorage. */
export class SessionManager {
  private session?: StoredSession;
  private revision = 0;
  private writes: Promise<void> = Promise.resolve();
  private refreshFlight?: Promise<string>;
  private signInFlight?: Promise<AccountSession>;
  private signInAbort?: AbortController;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly secrets: SecretStore,
    private readonly oauth: OAuthClient,
    private readonly api: ProfileApi,
    private readonly clientId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  get account(): AccountSession | undefined {
    return this.session
      ? { id: this.session.id, profile: { ...this.session.profile } }
      : undefined;
  }

  subscribe(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.writes.then(operation);
    this.writes = next.catch(() => undefined);
    return next;
  }

  async restore(): Promise<void> {
    const revision = this.revision;
    await this.serialize(async () => {
      const raw = await this.secrets.get(SESSION_KEY);
      if (!raw || revision !== this.revision) return;
      try {
        this.session = parseSession(raw);
        this.changed();
      } catch {
        await this.secrets.delete(SESSION_KEY);
        throw new NeonError(
          'The saved Neon session could not be read. Please sign in again.',
        );
      }
    });
  }

  private save(
    session: StoredSession,
    revision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.serialize(async () => {
      if (revision !== this.revision || signal?.aborted)
        throw new SignInCancelledError();
      const previous = this.session;
      await this.secrets.store(SESSION_KEY, JSON.stringify(session));
      if (revision !== this.revision) throw new SignInCancelledError();
      if (signal?.aborted) {
        // Cancellation can arrive while SecretStorage is writing. Roll back that write.
        if (previous)
          await this.secrets.store(SESSION_KEY, JSON.stringify(previous));
        else await this.secrets.delete(SESSION_KEY);
        throw new SignInCancelledError();
      }
      this.session = session;
      this.changed();
    });
  }

  signIn(signal: AbortSignal): Promise<AccountSession> {
    if (this.signInFlight) return this.signInFlight;
    const revision = ++this.revision;
    const abort = new AbortController();
    this.signInAbort = abort;
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    this.signInFlight = (async () => {
      const clientId = this.clientId().trim();
      if (!clientId)
        throw new NeonError(
          'Set a registered Neon OAuth client ID in Settings.',
        );
      const tokens = await this.oauth.authorize(clientId, abort.signal);
      if (abort.signal.aborted) throw new SignInCancelledError();
      const profile = await this.api.getCurrentUser(tokens.accessToken);
      if (abort.signal.aborted) throw new SignInCancelledError();
      const session: StoredSession = {
        version: 1,
        id: randomUUID(),
        clientId,
        tokens,
        profile,
      };
      await this.save(session, revision, abort.signal);
      return { id: session.id, profile };
    })().finally(() => {
      signal.removeEventListener('abort', cancel);
      this.signInFlight = undefined;
      this.signInAbort = undefined;
    });
    return this.signInFlight;
  }

  async accessToken(forceRefresh = false): Promise<string> {
    const session = this.session;
    if (!session) throw new SessionExpiredError();
    if (!forceRefresh && session.tokens.expiresAt > this.now() + 60_000)
      return session.tokens.accessToken;
    if (this.refreshFlight) return this.refreshFlight;
    const revision = this.revision;
    this.refreshFlight = (async () => {
      try {
        if (!session.tokens.refreshToken) throw new SessionExpiredError();
        const tokens = await this.oauth.refresh(
          session.clientId,
          session.tokens.refreshToken,
        );
        tokens.refreshToken ??= session.tokens.refreshToken;
        await this.save({ ...session, tokens }, revision);
        return tokens.accessToken;
      } catch (error) {
        if (error instanceof SessionExpiredError && revision === this.revision)
          await this.signOut(false);
        throw error;
      }
    })().finally(() => {
      this.refreshFlight = undefined;
    });
    return this.refreshFlight;
  }

  async refreshProfile(): Promise<void> {
    const revision = this.revision;
    let profile: Profile;
    try {
      profile = await this.api.getCurrentUser(await this.accessToken());
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      try {
        profile = await this.api.getCurrentUser(await this.accessToken(true));
      } catch (retryError) {
        if (
          retryError instanceof ApiError &&
          retryError.status === 401 &&
          revision === this.revision
        ) {
          await this.signOut(false);
          throw new SessionExpiredError();
        }
        throw retryError;
      }
    }
    if (!this.session || revision !== this.revision) return;
    await this.save({ ...this.session, profile }, revision);
  }

  async signOut(revoke = true): Promise<void> {
    const previous = this.session;
    ++this.revision;
    this.signInAbort?.abort();
    await this.serialize(async () => {
      await this.secrets.delete(SESSION_KEY);
      this.session = undefined;
      this.changed();
    });
    if (revoke && previous?.tokens.refreshToken) {
      try {
        await this.oauth.revoke(
          previous.clientId,
          previous.tokens.refreshToken,
        );
      } catch {
        throw new NeonError(
          'Signed out locally. Neon could not revoke the session online; remove its authorization in Neon Console if needed.',
        );
      }
    }
  }

  dispose(): void {
    ++this.revision;
    this.signInAbort?.abort();
    this.listeners.clear();
  }
}

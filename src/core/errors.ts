export class NeonError extends Error {}

export class SignInCancelledError extends NeonError {
  constructor() {
    super('Sign-in was cancelled.');
  }
}

export class SessionExpiredError extends NeonError {
  constructor() {
    super('Your Neon session has expired. Please sign in again.');
  }
}

export class ApiError extends NeonError {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'Neon did not accept your session. Please sign in again.'
        : status === 403
          ? 'Neon denied access to your profile. Check the OAuth client permissions.'
          : `Neon could not load your profile (HTTP ${status}). Try refreshing it.`,
    );
  }
}

export function userMessage(error: unknown): string {
  return error instanceof NeonError
    ? error.message
    : 'Neon could not complete the request. Check your connection and try again.';
}

import * as vscode from 'vscode';
import { NeonApi } from './api/neonApi';
import { NeonOAuthClient, AUTH_SCOPES } from './auth/oauthClient';
import { SessionManager } from './auth/sessionManager';
import { NeonAuthenticationProvider } from './auth/authenticationProvider';
import { ProfileView } from './views/profileView';
import { SignInCancelledError, userMessage } from './core/errors';

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'neon.ready', false);
  let restoring = true;
  const sessions = new SessionManager(
    context.secrets,
    new NeonOAuthClient(async (url) =>
      vscode.env.openExternal(vscode.Uri.parse(url)),
    ),
    new NeonApi(),
    () =>
      vscode.workspace
        .getConfiguration('neon')
        .get<string>('oauth.clientId', 'neonctl'),
  );
  const provider = new NeonAuthenticationProvider(sessions);
  const profile = new ProfileView(sessions);
  const view = vscode.window.createTreeView('neon.profile', {
    treeDataProvider: profile,
    showCollapseAll: false,
  });
  const setContext = async () => {
    await vscode.commands.executeCommand(
      'setContext',
      'neon.signedIn',
      !!sessions.account,
    );
  };
  context.subscriptions.push(
    sessions,
    provider,
    profile,
    view,
    sessions.subscribe(setContext),
    vscode.authentication.registerAuthenticationProvider(
      'neon',
      'Neon',
      provider,
      { supportsMultipleAccounts: false },
    ),
  );

  const command = (id: string, action: () => PromiseLike<unknown>) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          return await action();
        } catch (error) {
          if (
            !(error instanceof SignInCancelledError) &&
            !(error instanceof DOMException && error.name === 'AbortError')
          ) {
            await vscode.window.showErrorMessage(userMessage(error));
          }
          return undefined;
        }
      }),
    );
  };

  command('neon.signIn', async () => {
    if (restoring) return;
    await vscode.authentication.getSession('neon', [...AUTH_SCOPES], {
      createIfNone: true,
    });
    await vscode.commands.executeCommand('neon.profile.focus');
  });
  command('neon.signOut', () => sessions.signOut());
  command('neon.refreshProfile', () =>
    vscode.window.withProgress({ location: { viewId: 'neon.profile' } }, () =>
      sessions.refreshProfile(),
    ),
  );
  command('neon.showProfile', () =>
    vscode.commands.executeCommand('neon.profile.focus'),
  );

  try {
    await sessions.restore();
  } catch (error) {
    void vscode.window.showErrorMessage(userMessage(error));
  }
  await setContext();
  restoring = false;
  await vscode.commands.executeCommand('setContext', 'neon.ready', true);
  if (sessions.account) {
    // Cached identity renders immediately. A failed background request leaves it intact.
    void sessions.refreshProfile().catch(() => {
      if (sessions.account)
        view.message =
          'Profile could not be refreshed. Use Refresh Profile to retry.';
    });
  }
  context.subscriptions.push(
    sessions.subscribe(() => {
      view.message = undefined;
    }),
  );
}

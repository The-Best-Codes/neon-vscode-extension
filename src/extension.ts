import * as vscode from 'vscode';
import { createApi, profileApi } from './api/neonApi';
import { NeonOAuthClient, AUTH_SCOPES } from './auth/oauthClient';
import { SessionManager } from './auth/sessionManager';
import { NeonAuthenticationProvider } from './auth/authenticationProvider';
import { ProjectsTree } from './views/projectsTree';
import { projectCommands } from './commands';
import { isCancellation, userMessage } from './core/errors';

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
    profileApi,
    () =>
      vscode.workspace
        .getConfiguration('neon')
        .get<string>('oauth.clientId', 'neonctl'),
  );
  const neon = createApi((forceRefresh) => sessions.accessToken(forceRefresh));
  const provider = new NeonAuthenticationProvider(sessions);
  const tree = new ProjectsTree(neon, () => !!sessions.account);
  const view = vscode.window.createTreeView('neon.projects', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  let accountId: string | undefined;
  const onAccountChanged = async () => {
    const account = sessions.account;
    view.description = account?.profile.email || undefined;
    // Token and profile refreshes also notify. Only a different account needs a reload.
    if (account?.id !== accountId) {
      accountId = account?.id;
      tree.refresh();
    }
    await vscode.commands.executeCommand(
      'setContext',
      'neon.signedIn',
      !!sessions.account,
    );
  };
  context.subscriptions.push(
    sessions,
    provider,
    tree,
    view,
    sessions.subscribe(() => void onAccountChanged()),
    vscode.authentication.registerAuthenticationProvider(
      'neon',
      'Neon',
      provider,
      { supportsMultipleAccounts: false },
    ),
  );

  const command = (
    id: string,
    action: (...args: never[]) => PromiseLike<unknown> | unknown,
  ) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          return await action(...args);
        } catch (error) {
          if (!isCancellation(error))
            void vscode.window.showErrorMessage(userMessage(error));
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
    await vscode.commands.executeCommand('neon.projects.focus');
  });
  command('neon.signOut', () => sessions.signOut());
  for (const [id, action] of Object.entries(projectCommands(neon, tree)))
    command(id, action);

  try {
    await sessions.restore();
  } catch (error) {
    void vscode.window.showErrorMessage(userMessage(error));
  }
  await onAccountChanged();
  restoring = false;
  await vscode.commands.executeCommand('setContext', 'neon.ready', true);
  // The cached profile renders immediately. Refresh it quietly in the background.
  if (sessions.account) void sessions.refreshProfile().catch(() => undefined);
}

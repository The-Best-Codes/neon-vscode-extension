import * as vscode from 'vscode';
import { createApi, profileApi } from './api/neonApi';
import { NeonOAuthClient, AUTH_SCOPES } from './auth/oauthClient';
import { SessionManager } from './auth/sessionManager';
import { NeonAuthenticationProvider } from './auth/authenticationProvider';
import { ProjectsTree } from './views/projectsTree';
import { WorkspaceProjectStatus } from './views/statusBar';
import { WorkspaceProject } from './workspace/workspaceProject';
import { projectCommands } from './commands';
import { isCancellation, userMessage } from './core/errors';

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const setContext = (key: string, value: unknown) =>
    vscode.commands.executeCommand('setContext', key, value);
  await setContext('neon.ready', false);
  let restoring = true;
  let finishRestoring!: () => void;
  const restored = new Promise<void>((resolve) => (finishRestoring = resolve));
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
  const signedIn = () => !!sessions.account;
  const workspace = new WorkspaceProject(
    context.workspaceState,
    neon,
    signedIn,
  );
  const tree = new ProjectsTree(
    neon,
    signedIn,
    () => workspace.project,
    restored,
  );
  const view = vscode.window.createTreeView('neon.projects', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const status = new WorkspaceProjectStatus(workspace, signedIn);

  let pendingReveal: string | undefined;
  const revealLinked = () => {
    const node = pendingReveal && tree.projectNode(pendingReveal);
    if (!node || !view.visible) return;
    pendingReveal = undefined;
    void Promise.resolve(
      view.reveal(node, { expand: true, select: false, focus: false }),
    ).catch(() => undefined);
  };
  let linkedId = workspace.project?.projectId;
  const onLinkChanged = async () => {
    const projectId = workspace.project?.projectId;
    await setContext('neon.workspaceProjectLinked', !!projectId);
    if (projectId === linkedId) return;
    linkedId = projectId;
    pendingReveal = projectId;
    tree.refresh();
  };
  let accountId: string | undefined;
  const onAccountChanged = async () => {
    const account = sessions.account;
    view.description = account?.profile.email || undefined;
    status.update();
    const changed = account?.id !== accountId;
    accountId = account?.id;
    // Switch the welcome content before the tree empties or reloads, so it
    // never shows the previous account's state.
    await setContext('neon.signedIn', !!account);
    if (changed) {
      tree.refresh();
      void workspace.detect();
    }
  };
  context.subscriptions.push(
    sessions,
    provider,
    workspace,
    tree,
    view,
    status,
    workspace.onDidChange(() => void onLinkChanged()),
    view.onDidChangeVisibility(revealLinked),
    tree.onDidLoadProjects(revealLinked),
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
  for (const [id, action] of Object.entries(
    projectCommands(neon, tree, workspace),
  ))
    command(id, action);

  try {
    await sessions.restore();
  } catch (error) {
    void vscode.window.showErrorMessage(userMessage(error));
  } finally {
    finishRestoring();
  }
  await onAccountChanged();
  await onLinkChanged();
  restoring = false;
  await setContext('neon.ready', true);
  if (sessions.account) void sessions.refreshProfile().catch(() => undefined);
}

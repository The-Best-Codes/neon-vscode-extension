import * as vscode from 'vscode';
import type {
  Branch,
  Database,
  Organization,
  ProjectListItem,
} from '@neon/sdk';
import type { Neon } from './api/neonApi';
import { NeonError } from './core/errors';
import {
  region,
  type BranchNode,
  type DatabaseNode,
  type EndpointNode,
  type Node,
  type OrgNode,
  type ProjectNode,
  type ProjectsTree,
} from './views/projectsTree';

const CONSOLE_URL = 'https://console.neon.tech/app/projects';

/** Tree commands. Each accepts the clicked node, or prompts when run from the Command Palette. */
export function projectCommands(neon: Neon, tree: ProjectsTree) {
  const pickOrg = async (): Promise<Organization | undefined> => {
    const orgs = await neon.user.organizations();
    if (orgs.length <= 1) return orgs[0];
    return (
      await vscode.window.showQuickPick(
        orgs.map((org) => ({ label: org.name, org })),
        { title: 'Select an organization' },
      )
    )?.org;
  };

  const pickProject = async (): Promise<ProjectListItem | undefined> => {
    const items = (async () => {
      const orgs = await neon.user.organizations();
      const groups = await Promise.all(
        orgs.map(async (org) => ({
          org,
          projects: await neon.projects.list({ org_id: org.id }).all(),
        })),
      );
      return groups.flatMap(({ org, projects }) => [
        ...(orgs.length > 1
          ? [{ label: org.name, kind: vscode.QuickPickItemKind.Separator }]
          : []),
        ...projects.map((project) => ({
          label: project.name,
          description: region(project.region_id),
          project,
        })),
      ]);
    })();
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Select a project',
      matchOnDescription: true,
    });
    return picked && 'project' in picked ? picked.project : undefined;
  };

  const pickBranch = async (
    project: BranchNode['project'],
  ): Promise<Branch | undefined> => {
    const branches = await neon.branches.list({ projectId: project.id }).all();
    if (branches.length === 1) return branches[0];
    return (
      await vscode.window.showQuickPick(
        branches
          .sort((a, b) => Number(b.default) - Number(a.default))
          .map((branch) => ({
            label: branch.name,
            description: branch.default ? 'default' : undefined,
            branch,
          })),
        { title: `Select a branch in ${project.name}` },
      )
    )?.branch;
  };

  const copyConnectionString = async (
    node?: BranchNode | DatabaseNode,
  ): Promise<void> => {
    const project = node?.project ?? (await pickProject());
    if (!project) return;
    const branch = node?.branch ?? (await pickBranch(project));
    if (!branch) return;
    let database: Database | undefined;
    if (node?.kind === 'database') {
      database = node.database;
    } else {
      const databases = await neon.postgres.databases.list({
        projectId: project.id,
        branchId: branch.id,
      });
      if (!databases.length)
        throw new NeonError(`${branch.name} has no databases.`);
      database =
        databases.length === 1
          ? databases[0]
          : (
              await vscode.window.showQuickPick(
                databases.map((d) => ({
                  label: d.name,
                  description: d.owner_name,
                  database: d,
                })),
                { title: `Select a database on ${branch.name}` },
              )
            )?.database;
      if (!database) return;
    }
    const pooled = vscode.workspace
      .getConfiguration('neon')
      .get<boolean>('connectionString.pooled', true);
    const uri = await neon.postgres.connectionString({
      projectId: project.id,
      branchId: branch.id,
      databaseName: database.name,
      roleName: database.owner_name,
      pooled,
    });
    await vscode.env.clipboard.writeText(uri);
    void vscode.window.showInformationMessage(
      `Copied the ${pooled ? 'pooled ' : ''}connection string for ${database.name} on ${branch.name}.`,
    );
  };

  const offerConnectionString = async (
    message: string,
    project: BranchNode['project'],
    branch: Branch,
  ) => {
    const action = await vscode.window.showInformationMessage(
      message,
      'Copy Connection String',
    );
    if (action)
      await copyConnectionString({
        kind: 'branch',
        project,
        branch,
        endpoints: [],
      });
  };

  return {
    'neon.refresh': (node?: Node) => tree.refresh(node),

    'neon.createProject': async (node?: OrgNode) => {
      const org = node?.org ?? (await pickOrg());
      if (!org) return;
      const name = await vscode.window.showInputBox({
        title: 'Create Neon project',
        prompt: `Project name in ${org.name}`,
        placeHolder: 'Leave empty for a generated name',
      });
      if (name === undefined) return;
      const regions = neon.regions.list().then((list) =>
        list
          .sort((a, b) => Number(b.default) - Number(a.default))
          .map((r) => ({
            label: r.name,
            description: r.default ? `${r.region_id} · default` : r.region_id,
            regionId: r.region_id,
          })),
      );
      const picked = await vscode.window.showQuickPick(regions, {
        title: 'Select a region',
        placeHolder: 'Pick the region closest to your app',
        matchOnDescription: true,
      });
      if (!picked) return;
      const project = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Creating Neon project…',
        },
        () =>
          neon.projects.create({
            name: name.trim() || undefined,
            region_id: picked.regionId,
            org_id: org.id,
          }),
      );
      tree.refresh(node);
      const branch = await neon.branches.getDefault({ projectId: project.id });
      await offerConnectionString(
        `Created project ${project.name}.`,
        project,
        branch,
      );
    },

    'neon.renameProject': async ({ project }: ProjectNode) => {
      const name = await vscode.window.showInputBox({
        title: 'Rename project',
        value: project.name,
        validateInput: (value) =>
          value.trim() ? undefined : 'Enter a project name.',
      });
      if (!name?.trim() || name.trim() === project.name) return;
      await neon.projects.update({ projectId: project.id, name: name.trim() });
      tree.refresh();
    },

    'neon.deleteProject': async ({ project }: ProjectNode) => {
      const confirmed = await vscode.window.showWarningMessage(
        `Delete project “${project.name}”?`,
        {
          modal: true,
          detail:
            'All branches, databases, and computes in this project will be deleted.',
        },
        'Delete Project',
      );
      if (!confirmed) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Deleting ${project.name}…`,
        },
        () => neon.projects.delete({ projectId: project.id }),
      );
      tree.refresh();
    },

    'neon.createBranch': async (node?: ProjectNode | BranchNode) => {
      const project = node?.project ?? (await pickProject());
      if (!project) return;
      const parent = node?.kind === 'branch' ? node.branch : undefined;
      const name = await vscode.window.showInputBox({
        title: `Create branch in ${project.name}`,
        prompt: parent
          ? `Branch from ${parent.name}`
          : 'Branch from the default branch',
        placeHolder: 'Leave empty for a generated name',
      });
      if (name === undefined) return;
      const branch = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Creating branch…',
        },
        () =>
          neon.branches.create({
            projectId: project.id,
            name: name.trim() || undefined,
            parent_id: parent?.id,
          }),
      );
      tree.refreshProject(project.id);
      await offerConnectionString(
        `Created branch ${branch.name}.`,
        project,
        branch,
      );
    },

    'neon.renameBranch': async ({ project, branch }: BranchNode) => {
      const name = await vscode.window.showInputBox({
        title: 'Rename branch',
        value: branch.name,
        validateInput: (value) =>
          value.trim() ? undefined : 'Enter a branch name.',
      });
      if (!name?.trim() || name.trim() === branch.name) return;
      await neon.branches.update({
        projectId: project.id,
        branchId: branch.id,
        name: name.trim(),
      });
      tree.refreshProject(project.id);
    },

    'neon.setDefaultBranch': async ({ project, branch }: BranchNode) => {
      await neon.branches.setDefault({
        projectId: project.id,
        branchId: branch.id,
      });
      tree.refreshProject(project.id);
    },

    'neon.deleteBranch': async ({ project, branch }: BranchNode) => {
      const confirmed = await vscode.window.showWarningMessage(
        `Delete branch “${branch.name}”?`,
        {
          modal: true,
          detail: `Its computes and data will be deleted from ${project.name}.`,
        },
        'Delete Branch',
      );
      if (!confirmed) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Deleting ${branch.name}…`,
        },
        () =>
          neon.branches.delete({ projectId: project.id, branchId: branch.id }),
      );
      tree.refreshProject(project.id);
    },

    'neon.copyConnectionString': copyConnectionString,

    'neon.startCompute': ({ project, endpoint }: EndpointNode) =>
      vscode.window.withProgress(
        { location: { viewId: 'neon.projects' } },
        async () => {
          await neon.postgres.endpoints.start(
            { projectId: project.id, endpointId: endpoint.id },
            { waitForReadiness: true },
          );
          tree.refreshProject(project.id);
        },
      ),

    'neon.suspendCompute': ({ project, endpoint }: EndpointNode) =>
      vscode.window.withProgress(
        { location: { viewId: 'neon.projects' } },
        async () => {
          await neon.postgres.endpoints.suspend(
            { projectId: project.id, endpointId: endpoint.id },
            { waitForReadiness: true },
          );
          tree.refreshProject(project.id);
        },
      ),

    'neon.openInConsole': async (node?: ProjectNode | BranchNode) => {
      const project = node?.project ?? (await pickProject());
      if (!project) return;
      const url =
        node?.kind === 'branch'
          ? `${CONSOLE_URL}/${project.id}/branches/${node.branch.id}`
          : `${CONSOLE_URL}/${project.id}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },

    'neon.copyId': async (
      node: OrgNode | ProjectNode | BranchNode | EndpointNode,
    ) => {
      const [label, id] =
        node.kind === 'org'
          ? ['organization', node.org.id]
          : node.kind === 'project'
            ? ['project', node.project.id]
            : node.kind === 'branch'
              ? ['branch', node.branch.id]
              : ['compute', node.endpoint.id];
      await vscode.env.clipboard.writeText(id);
      vscode.window.setStatusBarMessage(`$(check) Copied ${label} ID`, 3000);
    },
  } satisfies Record<string, (...args: never[]) => unknown>;
}

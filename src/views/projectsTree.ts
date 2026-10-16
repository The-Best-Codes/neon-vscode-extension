import * as vscode from 'vscode';
import type {
  Branch,
  Database,
  Endpoint,
  Organization,
  ProjectListItem,
  Role,
} from '@neon/sdk';
import type { Neon } from '../api/neonApi';
import { isCancellation, userMessage } from '../core/errors';

export type OrgNode = { kind: 'org'; org: Organization };
export type ProjectNode = { kind: 'project'; project: ProjectListItem };
/** Children only need the project's identity, so nodes can be built from any project shape. */
type ProjectRef = Pick<ProjectListItem, 'id' | 'name'>;
export type BranchNode = {
  kind: 'branch';
  project: ProjectRef;
  branch: Branch;
  endpoints: Endpoint[];
};
export type EndpointNode = {
  kind: 'endpoint';
  project: ProjectRef;
  endpoint: Endpoint;
};
export type DatabaseNode = {
  kind: 'database';
  project: ProjectRef;
  branch: Branch;
  database: Database;
};
type RoleNode = { kind: 'role'; branch: Branch; role: Role };
type GroupNode = {
  kind: 'group';
  id: string;
  label: string;
  icon: string;
  children: Node[];
};
type MessageNode = {
  kind: 'message';
  id: string;
  label: string;
  icon: vscode.ThemeIcon;
  command?: vscode.Command;
};

export type Node =
  | OrgNode
  | ProjectNode
  | BranchNode
  | EndpointNode
  | DatabaseNode
  | RoleNode
  | GroupNode
  | MessageNode;

export class ProjectsTree
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly events = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.events.event;
  /** Rendered project nodes, so mutations can reload just the project they touched. */
  private readonly projects = new Map<string, ProjectNode>();

  constructor(
    private readonly neon: Neon,
    private readonly signedIn: () => boolean,
  ) {}

  refresh(node?: Node): void {
    this.events.fire(node);
  }

  refreshProject(projectId: string): void {
    this.refresh(this.projects.get(projectId));
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!this.signedIn()) return [];
    try {
      return await this.load(node);
    } catch (error) {
      if (isCancellation(error) || !this.signedIn()) return [];
      return [
        {
          kind: 'message',
          id: `${node ? key(node) : 'root'}/error`,
          label: userMessage(error),
          icon: new vscode.ThemeIcon(
            'error',
            new vscode.ThemeColor('errorForeground'),
          ),
          command: {
            title: 'Retry',
            command: 'neon.refresh',
            arguments: [node],
          },
        },
      ];
    }
  }

  private async load(node?: Node): Promise<Node[]> {
    if (!node) {
      const orgs = await this.neon.user.organizations();
      // Most people belong to one organization. Skip the extra level for them.
      if (orgs.length === 1) return this.loadProjects(orgs[0]!);
      return byName(orgs, (org) => org.name).map((org) => ({
        kind: 'org',
        org,
      }));
    }
    switch (node.kind) {
      case 'org': {
        const projects = await this.loadProjects(node.org);
        return projects.length
          ? projects
          : [
              {
                kind: 'message',
                id: `${key(node)}/empty`,
                label: 'Create a project',
                icon: new vscode.ThemeIcon('add'),
                command: {
                  title: 'Create Project',
                  command: 'neon.createProject',
                  arguments: [node],
                },
              },
            ];
      }
      case 'project': {
        const projectId = node.project.id;
        const [branches, endpoints] = await Promise.all([
          this.neon.branches.list({ projectId }).all(),
          this.neon.postgres.endpoints.list({ projectId }),
        ]);
        return branches
          .sort(
            (a, b) =>
              Number(b.default) - Number(a.default) ||
              a.name.localeCompare(b.name),
          )
          .map((branch) => ({
            kind: 'branch',
            project: node.project,
            branch,
            endpoints: endpoints.filter((e) => e.branch_id === branch.id),
          }));
      }
      case 'branch': {
        const params = { projectId: node.project.id, branchId: node.branch.id };
        const [databases, roles] = await Promise.all([
          this.neon.postgres.databases.list(params),
          this.neon.postgres.roles.list(params),
        ]);
        const { project, branch } = node;
        return [
          ...node.endpoints
            .sort((a, b) => primaryFirst(a) - primaryFirst(b))
            .map((endpoint): Node => ({ kind: 'endpoint', project, endpoint })),
          {
            kind: 'group',
            id: `${key(node)}/databases`,
            label: 'Databases',
            icon: 'database',
            children: byName(databases, (d) => d.name).map((database) => ({
              kind: 'database',
              project,
              branch,
              database,
            })),
          },
          {
            kind: 'group',
            id: `${key(node)}/roles`,
            label: 'Roles',
            icon: 'account',
            children: byName(roles, (r) => r.name).map((role) => ({
              kind: 'role',
              branch,
              role,
            })),
          },
        ];
      }
      case 'group':
        return node.children;
      default:
        return [];
    }
  }

  private async loadProjects(org: Organization): Promise<Node[]> {
    const projects = await this.neon.projects.list({ org_id: org.id }).all();
    return byName(projects, (p) => p.name).map((project) => {
      const node: ProjectNode = { kind: 'project', project };
      this.projects.set(project.id, node);
      return node;
    });
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(
      label(node),
      collapsible(node)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    // Stable ids keep expansion state across refreshes.
    item.id = key(node);
    switch (node.kind) {
      case 'org':
        item.iconPath = new vscode.ThemeIcon('organization');
        item.contextValue = 'org';
        item.tooltip = tooltip(node.org.name, [['ID', node.org.id]]);
        break;
      case 'project': {
        const { project } = node;
        item.iconPath = new vscode.ThemeIcon('project');
        item.description = `${region(project.region_id)} · Postgres ${project.pg_version}`;
        item.contextValue = 'project';
        item.tooltip = tooltip(project.name, [
          ['ID', project.id],
          ['Region', project.region_id],
          ['Postgres', String(project.pg_version)],
          ['Organization', project.org_name],
          ['Created', date(project.created_at)],
        ]);
        break;
      }
      case 'branch': {
        const { branch } = node;
        const compute = node.endpoints.find((e) => e.type === 'read_write');
        const busy =
          branch.current_state === 'init' ||
          branch.current_state === 'resetting' ||
          !!branch.pending_state;
        item.iconPath = busy
          ? new vscode.ThemeIcon('loading~spin')
          : new vscode.ThemeIcon(
              'git-branch',
              compute?.current_state === 'active'
                ? new vscode.ThemeColor('charts.green')
                : undefined,
            );
        item.description = [
          branch.default && 'default',
          branch.protected && 'protected',
          branch.current_state !== 'ready' && branch.current_state,
        ]
          .filter(Boolean)
          .join(' · ');
        item.contextValue = branch.default ? 'branch.default' : 'branch';
        item.tooltip = tooltip(branch.name, [
          ['ID', branch.id],
          ['Compute', compute ? computeState(compute) : 'None'],
          ['Data size', bytes(branch.logical_size)],
          ['Created', date(branch.created_at)],
          ['Created by', branch.created_by?.name],
          ['Expires', date(branch.expires_at)],
        ]);
        break;
      }
      case 'endpoint': {
        const { endpoint } = node;
        const state = endpoint.pending_state ?? endpoint.current_state;
        item.iconPath = new vscode.ThemeIcon(
          endpoint.pending_state || state === 'init'
            ? 'loading~spin'
            : state === 'active'
              ? 'vm-running'
              : 'vm-outline',
          state === 'active'
            ? new vscode.ThemeColor('charts.green')
            : undefined,
        );
        item.description = `${computeState(endpoint)} · ${endpoint.autoscaling_limit_min_cu}–${endpoint.autoscaling_limit_max_cu} CU`;
        item.contextValue = `endpoint.${endpoint.current_state}`;
        item.tooltip = tooltip(label(node), [
          ['ID', endpoint.id],
          ['Host', endpoint.host],
          ['State', computeState(endpoint)],
          [
            'Autoscaling',
            `${endpoint.autoscaling_limit_min_cu}–${endpoint.autoscaling_limit_max_cu} CU`,
          ],
          ['Last active', date(endpoint.last_active)],
        ]);
        break;
      }
      case 'group':
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.description = String(node.children.length);
        break;
      case 'database':
        item.iconPath = new vscode.ThemeIcon('database');
        item.description = node.database.owner_name;
        item.contextValue = 'database';
        item.tooltip = tooltip(node.database.name, [
          ['Owner', node.database.owner_name],
          ['Created', date(node.database.created_at)],
        ]);
        break;
      case 'role':
        item.iconPath = new vscode.ThemeIcon('person');
        item.description = node.role.protected ? 'protected' : undefined;
        item.contextValue = 'role';
        break;
      case 'message':
        item.iconPath = node.icon;
        item.command = node.command;
        item.tooltip = node.label;
        break;
    }
    return item;
  }

  dispose(): void {
    this.events.dispose();
  }
}

function key(node: Node): string {
  switch (node.kind) {
    case 'org':
      return `org/${node.org.id}`;
    case 'project':
      return `project/${node.project.id}`;
    case 'branch':
      return `branch/${node.branch.id}`;
    case 'endpoint':
      return `endpoint/${node.endpoint.id}`;
    case 'database':
      return `branch/${node.branch.id}/database/${node.database.name}`;
    case 'role':
      return `branch/${node.branch.id}/role/${node.role.name}`;
    case 'group':
    case 'message':
      return node.id;
  }
}

function label(node: Node): string {
  switch (node.kind) {
    case 'org':
      return node.org.name;
    case 'project':
      return node.project.name;
    case 'branch':
      return node.branch.name;
    case 'endpoint':
      return node.endpoint.type === 'read_write'
        ? 'Primary compute'
        : 'Read replica';
    case 'database':
      return node.database.name;
    case 'role':
      return node.role.name;
    case 'group':
    case 'message':
      return node.label;
  }
}

function collapsible(node: Node): boolean {
  return (
    node.kind === 'org' ||
    node.kind === 'project' ||
    node.kind === 'branch' ||
    (node.kind === 'group' && node.children.length > 0)
  );
}

function byName<T>(items: T[], name: (item: T) => string): T[] {
  return items.sort((a, b) => name(a).localeCompare(name(b)));
}

function primaryFirst(endpoint: Endpoint): number {
  return endpoint.type === 'read_write' ? 0 : 1;
}

function computeState(endpoint: Endpoint): string {
  const state = endpoint.pending_state ?? endpoint.current_state;
  return state === 'idle'
    ? 'Suspended'
    : state === 'init'
      ? 'Starting'
      : 'Active';
}

/** `aws-us-east-2` → `AWS us-east-2` */
export function region(regionId: string): string {
  const [provider = '', ...rest] = regionId.split('-');
  const name =
    provider === 'aws' ? 'AWS' : provider === 'azure' ? 'Azure' : provider;
  return rest.length ? `${name} ${rest.join('-')}` : regionId;
}

function date(value: string | undefined): string | undefined {
  return value ? new Date(value).toLocaleString() : undefined;
}

function bytes(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function tooltip(
  title: string,
  rows: [string, string | undefined][],
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(`**${escape(title)}**\n\n`);
  for (const [name, value] of rows) {
    if (value) markdown.appendMarkdown(`${name}: \`${value}\`  \n`);
  }
  return markdown;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

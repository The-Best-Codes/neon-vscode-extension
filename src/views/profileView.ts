import * as vscode from 'vscode';
import { SessionManager } from '../auth/sessionManager';

export class ProfileView
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private readonly events = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.events.event;
  private readonly subscription: { dispose(): void };

  constructor(private readonly sessions: SessionManager) {
    this.subscription = sessions.subscribe(() => this.events.fire());
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    const account = this.sessions.account;
    if (!account) return [];
    const { profile } = account;
    const name = new vscode.TreeItem(profile.name);
    name.iconPath = new vscode.ThemeIcon('account');
    name.tooltip = 'Signed in to Neon';
    return [
      name,
      this.field('Username', profile.username, 'person'),
      this.field('Email', profile.email || 'Not provided', 'mail'),
      this.field('Account ID', profile.id, 'key'),
    ];
  }

  private field(label: string, value: string, icon: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label);
    item.description = value;
    item.tooltip = `${label}: ${value}`;
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.events.dispose();
  }
}

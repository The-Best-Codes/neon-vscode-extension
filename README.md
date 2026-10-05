# Neon VSCode Extension

A Visual Studio Code extension for interacting with [Neon](https://neon.tech) - the serverless Postgres database.

## Features

- Sign in to your Neon account directly from VS Code
- OAuth-based authentication flow
- Simple and intuitive UI

## Requirements

- Visual Studio Code 1.60.0 or higher

## Installation

You can install this extension directly from the VS Code Marketplace:

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Neon"
4. Click Install

## Usage

1. Click on the Neon icon in the Activity Bar
2. Click "Sign in with Neon" to authenticate
3. After successful authentication, you'll see a welcome message

## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/neon-vscode-extension.git
cd neon-vscode-extension

# Install dependencies
npm install

# Compile the extension
npm run compile
```

### Running the Extension

- Open this repository folder in VS Code (`code .`).
- Trust this repository when prompted so workspace tasks and debugging can run.
- In Run and Debug, select **Run Neon Extension**, then press F5 (or Fn+F5 on a Mac). This compiles the extension and opens an Extension Development Host window.
- Click the Neon activity-bar entry in the development window to activate it, or run **Sign in to Neon** from the Command Palette.
- Set breakpoints in `src/extension.ts` in the original editor window. Extension logs appear in that window's Debug Console.
- For automatic TypeScript rebuilding, select **Run Neon Extension (watch)**. After editing, use **Developer: Reload Window** in the development window to load the rebuilt code. Restart debugging after changing `package.json` contribution points.
- Build manually with Cmd+Shift+B on macOS (Ctrl+Shift+B elsewhere).

TypeScript editing and extension debugging are built into VS Code; no additional editor extensions are required. The workspace uses the repository's TypeScript version.

The existing `npm test` and `npm run lint` scripts are placeholders: the test runner and ESLint setup are not present in this checkout.

### Building the Extension

```bash
npm run package
```

This will create a `.vsix` file that you can install in VS Code.

## License

ISC 
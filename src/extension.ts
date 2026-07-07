import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('sightread.helloWorld', () => {
		vscode.window.showInformationMessage('Hello from SightRead!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() { }

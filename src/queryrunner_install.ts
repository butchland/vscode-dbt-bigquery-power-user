// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BigQueryRunner } from './queryrunner';
import { DBTPowerUserExtension } from './dbtPowerUserExtension';
import { query } from './bigquery';

const configPrefix = "dbt.bigquery"; // share config with bigquery
let config: vscode.WorkspaceConfiguration;
let vscontext: vscode.ExtensionContext;
let vsdbtPowerUserExtension: DBTPowerUserExtension | undefined;
export async function openQueryRunner(): Promise<void> {
	if (!vscontext) {
		return;
	}
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		throw new Error("No active editor window was found");
	}
	const fullPath = path.join(vscontext.extensionPath, 'public');
	const localResourceRoot = vscode.Uri.file(fullPath);
	console.log('localResourceRoot: ' + localResourceRoot);
	vscode.commands.executeCommand('workbench.action.editorLayoutTwoRows');
	const panel = vscode.window.createWebviewPanel(
		'queryRunner', // Identifies the type of the webview. Used internally
		'QueryRunner', // Title of the panel displayed to the user
		vscode.ViewColumn.Beside, // Editor column to show the new webview panel in.
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [localResourceRoot]
		}
	);


	const bigQueryRunner = new BigQueryRunner(config, editor);

	if (vsdbtPowerUserExtension) {
		const dbtProjectContainer = vsdbtPowerUserExtension.getDbtProjectContainer();
		bigQueryRunner.setDbtProjectContainer(dbtProjectContainer);
	}
	const docURI = editor?.document.uri;
	console.log(`runAsQuery.docURI: ${docURI}`);
	const root_path = docURI !== undefined ? bigQueryRunner.dbtProjectContainer?.getProjectRootpath(docURI)?.fsPath : undefined;

	panel.webview.html = getWebviewContent(vscontext);

	panel.webview.onDidReceiveMessage(

		async message => {
			switch (message.command) {
				case 'runAsQuery':
					const queryResult = await bigQueryRunner.runAsQuery();
					if (queryResult.status === "error") {
						panel.webview.postMessage({ command: 'queryError', errorMessage: queryResult.errorMessage });
					} else {
						panel.webview.postMessage({ command: 'runAsQuery', result: queryResult });
					}
					break;
				case 'nextPage':
					const nextResult = await bigQueryRunner.getNextPage();
					if (nextResult.status === "error") {
						panel.webview.postMessage({ command: 'queryError', errorMessage: nextResult.errorMessage });
					} else {
						panel.webview.postMessage({ command: 'nextPage', result: nextResult });
					}
					break;
				case 'prevPage':
					if (bigQueryRunner.startIndex === 0) {
						panel.webview.postMessage({ command: 'queryError', errorMessage: "No more previous pages" });
						break; // no more prev page;
					}
					const prevResult = await bigQueryRunner.getPrevPage();
					if (prevResult.status === "error") {
						panel.webview.postMessage({ command: 'queryError', errorMessage: prevResult.errorMessage });
					} else {
						panel.webview.postMessage({ command: 'prevPage', result: prevResult });
					}
					break;
				case 'firstPage':
					const firstResult = await bigQueryRunner.getFirstPage();
					if (firstResult.status === "error") {
						panel.webview.postMessage({ command: 'queryError', errorMessage: firstResult.errorMessage });
					} else {
						panel.webview.postMessage({ command: 'nextPage', result: firstResult });
					}
					break;
				case 'lastPage':
					if (bigQueryRunner.startIndex === 0) {
						panel.webview.postMessage({ command: 'queryError', errorMessage: "No more previous pages" });
						break; // no more prev page;
					}
					const lastResult = await bigQueryRunner.getLastPage();
					if (lastResult.status === "error") {
						panel.webview.postMessage({ command: 'queryError', errorMessage: lastResult.errorMessage });
					} else {
						panel.webview.postMessage({ command: 'prevPage', result: lastResult });
					}
					break;

				case 'cancelQuery':
					const cancelResult = await bigQueryRunner.cancelQuery();
					panel.webview.postMessage({ command: 'cancelQuery', result: cancelResult });
					break;
				case 'saveAsCSV':
					const csvQueryText = await bigQueryRunner.getQueryText();
					console.log(`saveAsCSV.csvQueryText: ${csvQueryText}`);
					await query(csvQueryText, false, root_path, 'csv',);
					break;
				case 'saveAsTable':
					const tableQueryText = await bigQueryRunner.getQueryText();
					console.log(`saveAsCSV.tableQueryText: ${tableQueryText}`);
					await query(tableQueryText, false, root_path, 'table');
					break;
				case 'saveAsJSON':
					const jsonQueryText = await bigQueryRunner.getQueryText();
					console.log(`saveAsCSV.jsonQueryText: ${jsonQueryText}`);
					await query(jsonQueryText, false, root_path, 'json');
					break;
				case 'enableLimit':
					console.log(`enable limit called`);
					const enableLimit = bigQueryRunner.limitEnabled;
					bigQueryRunner.limitEnabled = !enableLimit;
					break;

			}
		},
		undefined,
		vscontext.subscriptions
	);

	// start running query upon opening the window
	console.log(`executing openQueryRunner runAsQuery on open`);
	const queryResult = await bigQueryRunner.runAsQuery();
	if (queryResult.status === "error") {
		panel.webview.postMessage({ command: 'queryError', errorMessage: queryResult.errorMessage });
	} else {
		panel.webview.postMessage({ command: 'runAsQuery', result: queryResult });
	}

}


// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext, dbtPowerUserExtension: DBTPowerUserExtension) {
	readConfig();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(configPrefix)) {
				return;
			}
			readConfig();

		})
	);
	let disposable = vscode.commands.registerCommand("dbtPowerUser.openQueryRunner", openQueryRunner);
	context.subscriptions.push(disposable);
	vscontext = context;
	vsdbtPowerUserExtension = dbtPowerUserExtension;

}

function readConfig(): void {
	try {
		config = vscode.workspace.getConfiguration(configPrefix);
	} catch (err) {
		vscode.window.showErrorMessage(`failed to read config: ${err}`);
	}
}

function getWebviewContent(context: vscode.ExtensionContext): string {
	const fullIndexPath = path.join(context.extensionPath, 'public', 'index.html');
	const indexPath = vscode.Uri.file(fullIndexPath);
	const schemeIndexPath = indexPath.with({ scheme: 'vscode-resource' });
	let htmlfile: Buffer | undefined;
	try {
		console.log(`getWebviewContent: attempting to read file ${schemeIndexPath.fsPath}`);
		htmlfile = fs.readFileSync(schemeIndexPath.fsPath);
	} catch (error) {
		console.log(`getWebviewContent: could not find htmlfile ${schemeIndexPath.fsPath}`);
		throw Error(`getWebviewContent: could not find htmlfile ${schemeIndexPath.fsPath}`);
	}

	let html = htmlfile?.toString();
	const fullPath = path.join(context.extensionPath, 'public');
	let resourceDir = vscode.Uri.file(fullPath);
	resourceDir = resourceDir.with({ scheme: 'vscode-resource' });
	html = html?.replace(new RegExp('__THEME__', 'g'), config.get('runnerTheme', 'dark'));
	html = html?.replace(new RegExp('__RESOURCE_DIR__', 'g'), resourceDir.toString());
	if (!html) {
		html = '';
	}
	return html;
}


export function deactivate() { }

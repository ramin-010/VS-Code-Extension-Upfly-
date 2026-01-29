import * as vscode from 'vscode';
import { WatcherService } from './services/WatcherService';
import { ConverterService } from './services/ConverterService';
import { ConfigService } from './services/ConfigService';

let watcherService: WatcherService;
let configService: ConfigService;

export function activate(context: vscode.ExtensionContext) {
    ConverterService.cleanupTempDir();

    configService = ConfigService.getInstance();
    configService.initialize();

    watcherService = new WatcherService();
    watcherService.initialize();

    const convertCmd = vscode.commands.registerCommand('upfly.convertFile', async (uri: vscode.Uri) => {
        if (uri && uri.fsPath) {
            const config = ConfigService.getInstance();
            await ConverterService.convertFile(uri.fsPath, {
                format: config.get('format'),
                quality: config.get('quality'),
                storageMode: config.get('storageMode'),
                outputDirectory: config.get('outputDirectory'),
                originalDirectory: config.get('originalDirectory'),
                inPlaceKeepOriginal: config.get('inPlaceKeepOriginal')
            });
        } else {
            vscode.window.showErrorMessage('Upfly: No file selected.');
        }
    });

    const initCmd = vscode.commands.registerCommand('upfly.init', async () => {
        await configService.createConfigFile();
    });

    context.subscriptions.push(configService.onDidChangeConfig(() => {
        console.log('Upfly: Config changed, reloading watcher...');
        watcherService.initialize();
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('upfly')) {
            watcherService.initialize(); 
        }
    }));

    context.subscriptions.push(convertCmd);
    context.subscriptions.push(initCmd);
    context.subscriptions.push({ dispose: () => watcherService.dispose() });
    context.subscriptions.push({ dispose: () => configService.dispose() });
}

export function deactivate() {
    if (watcherService) {
        watcherService.dispose();
    }
    if (configService) {
        configService.dispose();
    }
}

import * as vscode from 'vscode';
import * as path from 'path';
import { WatcherService } from './services/WatcherService';
import { ConverterService } from './services/ConverterService';
import { ConfigService } from './services/ConfigService';
import { globalQueue } from './services/QueueService';

let watcherService: WatcherService;
let configService: ConfigService;

type ImageFormat = 'webp' | 'png' | 'jpeg' | 'avif';

async function convertFiles(uris: vscode.Uri[], formatOverride?: ImageFormat, isCompression: boolean = false, forceInPlace: boolean = false) {
    const config = ConfigService.getInstance();

    // Check config validity before processing (JIT error)
    if (!config.isConfigValid) {
        config.showConfigErrors();
        return;
    }

    for (const uri of uris) {
        const filePath = uri.fsPath;
        const fileExt = path.extname(filePath).toLowerCase().replace('.', '');
        const normalizedExt = fileExt === 'jpg' ? 'jpeg' : fileExt;
        
        // Get per-folder format/quality settings
        const pathOptions = config.getOptionsForPath(filePath);
        
        const format = isCompression 
            ? (normalizedExt as ImageFormat)
            : (formatOverride ?? pathOptions.format);

        const quality = isCompression ? 60 : pathOptions.quality;

        globalQueue.add(async () => {
            const isValid = await ConverterService.isValidImage(filePath);
            if (!isValid) {
                console.log(`Upfly: Skipping invalid image: ${filePath}`);
                return;
            }

            await ConverterService.convertFile(filePath, {
                format: format,
                quality: quality,
                storageMode: forceInPlace ? 'in-place' : config.get('storageMode'),
                outputDirectory: config.get('outputDirectory'),
                originalDirectory: config.get('originalDirectory'),
                inPlaceKeepOriginal: forceInPlace ? true : config.get('inPlaceKeepOriginal'),
                isCompression: isCompression
            });
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    ConverterService.cleanupTempDir();

    configService = ConfigService.getInstance();
    configService.initialize();

    watcherService = new WatcherService();
    watcherService.initialize();

    const convertCmd = vscode.commands.registerCommand('upfly.convertFile', async (uri: vscode.Uri) => {
        if (uri && uri.fsPath) {
            await convertFiles([uri], undefined, false, true); // Manual = in-place
        } else {
            vscode.window.showErrorMessage('Upfly: No file selected.');
        }
    });

    const initCmd = vscode.commands.registerCommand('upfly.init', async () => {
        await configService.createConfigFile();
    });

    const convertToWebp = vscode.commands.registerCommand('upfly.convertToWebp', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const files = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        if (files.length > 0) {
            await convertFiles(files, 'webp', false, true); // Manual = in-place
        }
    });

    const convertToAvif = vscode.commands.registerCommand('upfly.convertToAvif', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const files = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        if (files.length > 0) {
            await convertFiles(files, 'avif', false, true); // Manual = in-place
        }
    });

    const convertToJpeg = vscode.commands.registerCommand('upfly.convertToJpeg', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const files = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        if (files.length > 0) {
            await convertFiles(files, 'jpeg', false, true); // Manual = in-place
        }
    });

    const convertToPng = vscode.commands.registerCommand('upfly.convertToPng', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const files = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        if (files.length > 0) {
            await convertFiles(files, 'png', false, true); // Manual = in-place
        }
    });

    const compressCmd = vscode.commands.registerCommand('upfly.compress', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const files = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        if (files.length > 0) {
            await convertFiles(files, undefined, true, true); // Manual = in-place
        }
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
    context.subscriptions.push(convertToWebp);
    context.subscriptions.push(convertToAvif);
    context.subscriptions.push(convertToJpeg);
    context.subscriptions.push(convertToPng);
    context.subscriptions.push(compressCmd);
    context.subscriptions.push({ dispose: () => watcherService.dispose() });
    context.subscriptions.push({ dispose: () => configService.dispose() });

    // Show Welcome Message on First Install
    const hasShownWelcome = context.globalState.get<boolean>('upfly.hasShownWelcome', false);
    if (!hasShownWelcome) {
        vscode.window.showInformationMessage(
            'Welcome to Upfly! 🚀 Would you like to create a configuration file to customize your image processing?',
            'Create Config',
            'Later'
        ).then(selection => {
            if (selection === 'Create Config') {
                vscode.commands.executeCommand('upfly.init');
            }
            context.globalState.update('upfly.hasShownWelcome', true);
        });
    }
}

export function deactivate() {
    if (watcherService) {
        watcherService.dispose();
    }
    if (configService) {
        configService.dispose();
    }
}

import * as vscode from 'vscode';
import * as path from 'path';
import { WatcherService } from './services/WatcherService';
import { ConverterService } from './services/ConverterService';
import { ConfigService } from './services/ConfigService';
import { globalQueue } from './services/QueueService';

let watcherService: WatcherService;
let configService: ConfigService;

type ImageFormat = 'webp' | 'png' | 'jpeg' | 'avif';

async function convertFiles(uris: vscode.Uri[], formatOverride?: ImageFormat, isCompression: boolean = false) {
    const config = ConfigService.getInstance();

    for (const uri of uris) {
        const filePath = uri.fsPath;
        const fileExt = path.extname(filePath).toLowerCase().replace('.', '');
        const normalizedExt = fileExt === 'jpg' ? 'jpeg' : fileExt;
        
        const format = isCompression 
            ? (normalizedExt as ImageFormat)
            : (formatOverride ?? config.get<ImageFormat>('format'));

        globalQueue.add(async () => {
            const isValid = await ConverterService.isValidImage(filePath);
            if (!isValid) {
                console.log(`Upfly: Skipping invalid image: ${filePath}`);
                return;
            }

            await ConverterService.convertFile(filePath, {
                format: format,
                quality: isCompression ? 60 : config.get('quality'),
                storageMode: config.get('storageMode'),
                outputDirectory: config.get('outputDirectory'),
                originalDirectory: config.get('originalDirectory'),
                inPlaceKeepOriginal: config.get('inPlaceKeepOriginal'),
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
            await convertFiles([uri]);
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
            await convertFiles(files, 'webp');
        }
    });

    const convertToAvif = vscode.commands.registerCommand('upfly.convertToAvif', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const files = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        if (files.length > 0) {
            await convertFiles(files, 'avif');
        }
    });

    const convertToJpeg = vscode.commands.registerCommand('upfly.convertToJpeg', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const files = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        if (files.length > 0) {
            await convertFiles(files, 'jpeg');
        }
    });

    const convertToPng = vscode.commands.registerCommand('upfly.convertToPng', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const files = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        if (files.length > 0) {
            await convertFiles(files, 'png');
        }
    });

    const compressCmd = vscode.commands.registerCommand('upfly.compress', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const files = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        if (files.length > 0) {
            await convertFiles(files, undefined, true);
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
}

export function deactivate() {
    if (watcherService) {
        watcherService.dispose();
    }
    if (configService) {
        configService.dispose();
    }
}

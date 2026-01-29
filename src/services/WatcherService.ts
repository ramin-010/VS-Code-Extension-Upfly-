import * as vscode from 'vscode';
import { ConverterService } from './ConverterService';
import { globalQueue } from './QueueService';
import { ProcessingCache } from './ProcessingCache';
import { ConfigService } from './ConfigService';
import * as fs from 'fs';

export class WatcherService {
    private watchers: vscode.FileSystemWatcher[] = [];

    constructor() {}

    public initialize() {
        this.dispose();

        const config = ConfigService.getInstance();
        const enabled = config.get<boolean>('enabled');
        const patterns = config.get<string[]>('watchTargets');

        if (!enabled) return;

        patterns.forEach(pattern => {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            
            watcher.onDidCreate((uri) => this.onFileEvent(uri)); 

            this.watchers.push(watcher);
        });
    }

    private processingFiles: Set<string> = new Set();

    private onFileEvent(uri: vscode.Uri) {
        let filePath = uri.fsPath;

        try {
            filePath = fs.realpathSync(filePath);
        } catch {}
 
        if (ProcessingCache.consume(filePath)) {
            console.log(`Upfly: Ignoring self-generated file: ${filePath}`);
            return;
        }

        if (this.processingFiles.has(filePath)) {
            return;
        }

        this.processingFiles.add(filePath);
        this.waitForFileStability(filePath);
    }

    private async waitForFileStability(filePath: string, lastSize: number = -1, attempts: number = 0) {
        const MAX_ATTEMPTS = 50; // 50 * 100ms = 5 seconds max wait
        const POLLING_INTERVAL = 100;

        setTimeout(async () => {
            try {
                if (!fs.existsSync(filePath)) {
                     this.processingFiles.delete(filePath);
                     return;
                }

                const stats = await fs.promises.stat(filePath);
                const currentSize = stats.size;

                if (currentSize > 0 && currentSize === lastSize) {
                    this.processingFiles.delete(filePath);
                    this.triggerProcessing(filePath);
                } else {
                    if (attempts < MAX_ATTEMPTS) {
                        this.waitForFileStability(filePath, currentSize, attempts + 1);
                    } else {
                        console.log(`Upfly: File ${filePath} took too long to settle. Giving up.`);
                        this.processingFiles.delete(filePath);
                    }
                }

            } catch (error: any) {
                if (error.code === 'EBUSY') {
                     if (attempts < MAX_ATTEMPTS) {
                        this.waitForFileStability(filePath, lastSize, attempts + 1); // Retry without incrementing size check
                     } else {
                        this.processingFiles.delete(filePath);
                     }
                } else {
                    console.error('Upfly: Polling Error', error);
                    this.processingFiles.delete(filePath);
                }
            }
        }, POLLING_INTERVAL);
    }

    private async triggerProcessing(filePath: string) {
        const config = ConfigService.getInstance();
        
        globalQueue.add(async () => {
            try {
                const isValid = await ConverterService.isValidImage(filePath);
                if (!isValid) {
                    console.log('Upfly: Invalid image header, skipping.');
                    return;
                }

                await ConverterService.convertFile(filePath, {
                    format: config.get('format'),
                    quality: config.get('quality'),
                    storageMode: config.get('storageMode'),
                    outputDirectory: config.get('outputDirectory'),
                    originalDirectory: config.get('originalDirectory'),
                    inPlaceKeepOriginal: config.get('inPlaceKeepOriginal')
                });

            } catch (err) {
                console.error('Error processing file:', err);
            }
        });
    }

    public dispose() {
        this.watchers.forEach(w => w.dispose());
        this.watchers = [];
    }
}

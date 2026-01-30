import * as vscode from 'vscode';
import * as fs from 'fs';
import { ConverterService } from './ConverterService';
import { globalQueue } from './QueueService';
import { ProcessingCache } from './ProcessingCache';
import { ConfigService } from './ConfigService';

export class WatcherService {
    private watchers: vscode.FileSystemWatcher[] = [];
    private processingFiles: Set<string> = new Set();
    
    // Supported extensions for Glob generation
    private static readonly EXTENSIONS_GLOB = '{png,jpg,jpeg,webp,avif,tiff,gif}';

    constructor() {}

    public initialize() {
        this.dispose();

        const config = ConfigService.getInstance();
        const enabled = config.get<boolean>('enabled');
        const rawWatchTargets = config.get<string[]>('watchTargets');

        if (!enabled) return;

        const optimizedPatterns = this.optimizeWatchTargets(rawWatchTargets);

        optimizedPatterns.forEach(pattern => {
            console.log(`Upfly: Watching ${pattern}`);
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidCreate((uri) => this.onFileEvent(uri)); 
            this.watchers.push(watcher);
        });
    }

    /**
     * Normalizes a single path input:
     * - Converts backslashes to forward slashes
     * - Strips leading ./ or /
     * - Strips trailing slashes
     * - Blocks absolute/external paths (returns null)
     */
    private normalizePath(input: string): string | null {
        let normalized = input
            .replace(/\\/g, '/')           // Backslashes to forward slashes
            .replace(/^\.\//, '')          // Strip leading ./
            .replace(/^\/+|\/+$/g, '');    // Strip leading/trailing slashes

        // Block absolute/external paths (drive letters)
        if (/^[a-zA-Z]:/.test(normalized)) {
            vscode.window.showWarningMessage(`Upfly: External path '${input}' ignored. Only workspace folders are supported.`);
            return null;
        }

        // Block paths that somehow still start with / after normalization (edge case)
        if (normalized.startsWith('/')) {
            vscode.window.showWarningMessage(`Upfly: Absolute path '${input}' ignored. Use relative paths like 'public'.`);
            return null;
        }

        return normalized;
    }

    /**
     * Optimizes user input:
     * 1. Normalizes paths (removes ./, /, trailing slashes, backslashes)
     * 2. Blocks external/absolute paths
     * 3. Removes subdirectories if parent is already watched
     * 4. Converts folders to Recursive Image Globs
     * 5. Preserves explicit Glob patterns if user provided them
     */
    private optimizeWatchTargets(targets: string[]): string[] {
        if (!targets || targets.length === 0) return [];

        // 1. Normalize, filter nulls, and Deduplicate
        const normalizedTargets = targets
            .map(t => this.normalizePath(t))
            .filter((t): t is string => t !== null);

        const uniqueTargets = Array.from(new Set(normalizedTargets));

        // 2. Separate folder paths from explicit globs
        const foldersOnly = uniqueTargets.filter(t => !t.includes('*'));
        const globsOnly = uniqueTargets.filter(t => t.includes('*'));

        // 3. Filter Redundant Subdirectories
        // If we watch "public", we don't need "public/assets"
        const optimizedFolders = foldersOnly.filter(target => {
            const isSubdirectory = foldersOnly.some(other => {
                if (other === target) return false;
                return target.startsWith(other + '/');
            });
            return !isSubdirectory;
        });

        // 4. Generate Final Globs
        const finalGlobs: string[] = [];

        // Add explicit globs as-is
        finalGlobs.push(...globsOnly);

        // Convert folders to recursive image globs
        optimizedFolders.forEach(folder => {
            finalGlobs.push(`**/${folder}/**/*.${WatcherService.EXTENSIONS_GLOB}`);
        });

        return finalGlobs;
    }

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
        const MAX_ATTEMPTS = 50;
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
                        this.waitForFileStability(filePath, lastSize, attempts + 1);
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

        // Skip processing if config is invalid (allow normal paste)
        if (!config.isConfigValid) {
            console.log('Upfly: Config is invalid, skipping auto-conversion. File will be pasted normally.');
            return;
        }
        
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

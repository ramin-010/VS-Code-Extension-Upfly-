import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConverterService } from './ConverterService';
import { globalQueue } from './QueueService';
import { ProcessingCache } from './ProcessingCache';
import { ConfigService } from './ConfigService';
import { CloudService } from './CloudService';

export class WatcherService {
    private watchers: vscode.FileSystemWatcher[] = [];
    private processingFiles: Set<string> = new Set();
    private renameListener: vscode.Disposable | undefined;

    // Track recently deleted files for rename detection (external renames)
    // Maps file size -> { path, timestamp } for correlation with subsequent creates
    private recentDeletes: Map<number, { path: string, timestamp: number }[]> = new Map();
    
    // Supported extensions for Glob generation
    private static readonly EXTENSIONS_GLOB = '{png,jpg,jpeg,webp,avif,tiff,gif}';

    // Debounced notification for cloud uploads
    private static uploadDebounceTimer: NodeJS.Timeout | null = null;

    constructor() {}

    public initialize() {
        this.dispose();

        const config = ConfigService.getInstance();
        const enabled = config.get<boolean>('enabled');
        const rawWatchTargets = config.get<any>('watchTargets');

        if (!enabled) return;

        // Extract paths - handle both string[] (VS Code settings) and WatchTarget[] (config file)
        const rootPaths = this.extractPaths(rawWatchTargets);
        
        // Also get cloud watch targets (for cloud-only folders)
        const cloudPaths = config.getCloudWatchTargets();
        
        // Merge paths (Set removes duplicates)
        const allPaths = [...new Set([...rootPaths, ...cloudPaths])];
        
        const optimizedPatterns = this.optimizeWatchTargets(allPaths);

        optimizedPatterns.forEach(pattern => {
            console.log(`Upfly: Watching ${pattern}`);
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidCreate((uri) => this.onFileEvent(uri));
            watcher.onDidDelete((uri) => this.onDeleteEvent(uri));
            this.watchers.push(watcher);
        });

        // Listen for VS Code renames (F2, Explorer drag, etc.)
        // This fires BEFORE the file watcher events, so we can mark the 
        // new path in ProcessingCache to suppress re-optimization.
        if (!this.renameListener) {
            this.renameListener = vscode.workspace.onDidRenameFiles((e) => {
                for (const file of e.files) {
                    const newPath = file.newUri.fsPath;
                    ProcessingCache.add(newPath);
                }
            });
        }
    }

    /**
     * Extract paths from either string[] (VS Code settings) or WatchTarget[] (config file)
     */
    private extractPaths(rawTargets: any): string[] {
        if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
            return ['public']; // Default
        }

        return rawTargets.map((item: any) => {
            if (typeof item === 'string') {
                return item;
            } else if (typeof item === 'object' && item !== null && item.path) {
                return item.path;
            }
            return 'public';
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

    /**
     * Track file deletions for rename detection.
     * When a file is renamed externally, the OS fires delete + create.
     * We record the deleted file's size so we can correlate it with the next create.
     */
    private onDeleteEvent(uri: vscode.Uri) {
        try {
            // The file is already gone, but we can try to get its size from our recent knowledge.
            // For external renames, the delete event may still have the file briefly accessible.
            // We'll store just the path info and use a size-based check in onFileEvent.
            const filePath = uri.fsPath;
            const RENAME_WINDOW_MS = 2000;

            // Record this deletion timestamp by path
            // We'll use path-based tracking: store the deleted path and check if
            // a create appears in the same directory within the time window
            const dir = path.dirname(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const key = `${dir}|${ext}`;

            if (!this.recentDeletes.has(0)) {
                this.recentDeletes.set(0, []);
            }
            this.recentDeletes.get(0)!.push({ path: key, timestamp: Date.now() });

            // Cleanup old entries
            setTimeout(() => {
                const entries = this.recentDeletes.get(0);
                if (entries) {
                    const now = Date.now();
                    const filtered = entries.filter(e => now - e.timestamp < RENAME_WINDOW_MS);
                    if (filtered.length === 0) {
                        this.recentDeletes.delete(0);
                    } else {
                        this.recentDeletes.set(0, filtered);
                    }
                }
            }, RENAME_WINDOW_MS + 100);
        } catch {}
    }

    /**
     * Check if a newly created file is likely a rename of a recently deleted file.
     * Uses directory + extension matching within a short time window.
     */
    private isLikelyRename(filePath: string): boolean {
        const dir = path.dirname(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const key = `${dir}|${ext}`;
        const RENAME_WINDOW_MS = 2000;

        const entries = this.recentDeletes.get(0);
        if (!entries) return false;

        const now = Date.now();
        const matchIndex = entries.findIndex(
            e => e.path === key && (now - e.timestamp) < RENAME_WINDOW_MS
        );

        if (matchIndex !== -1) {
            // Consume the entry so it can't match again
            entries.splice(matchIndex, 1);
            return true;
        }

        return false;
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

        // Check if this is likely a rename (external rename: delete + create)
        if (this.isLikelyRename(filePath)) {
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

        // Check if conversion is enabled for this specific file's nearest config
        const enabled = config.get<boolean>('enabled', filePath);
        if (!enabled) {
            return;
        }

        // Skip processing if config is invalid - show error popup (JIT)
        if (!config.isConfigValid) {
            console.log('Upfly: Config is invalid, skipping auto-conversion. File will be pasted normally.');
            config.showConfigErrors();
            return;
        }

        // --- Safety check to prevent breaking code on git pull ---
        // If the file is tracked by git (e.g., pulled from a remote), we should NOT 
        // auto-convert it because changing its extension would break existing code references.
        // We only want to auto-convert newly pasted/dropped (untracked) files.
        const { GitService } = await import('./GitService');
        const isGitTracked = await GitService.isTracked(filePath);
        if (isGitTracked) {
            console.log(`Upfly: Skipping git-tracked file: ${path.basename(filePath)}`);
            return;
        }

        // Check both flags independently
        const isCloudTarget = config.isCloudTarget(filePath);
        const shouldConvert = config.shouldConvert(filePath);
        
        // Neither? Shouldn't happen with proper watcher setup, but just in case
        if (!isCloudTarget && !shouldConvert) {
            console.log('Upfly: File not in any watch target, skipping.');
            return;
        }

        globalQueue.add(async () => {
            try {
                const isValid = await ConverterService.isValidImage(filePath);
                if (!isValid) {
                    console.log('Upfly: Invalid image header, skipping.');
                    return;
                }

                if (isCloudTarget && shouldConvert) {
                    // BOTH: Convert then upload
                    const { format, quality } = config.getOptionsForPath(filePath);
                    await this.processCloudUpload(filePath, format, quality, config);
                } else if (isCloudTarget && !shouldConvert) {
                    // CLOUD ONLY: Upload original without conversion
                    await this.processCloudUploadRaw(filePath, config);
                } else {
                    // LOCAL ONLY: Normal conversion (unchanged behavior)
                    const { format, quality } = config.getOptionsForPath(filePath);
                    await ConverterService.convertFile(filePath, {
                        format,
                        quality,
                        storageMode: config.get('storageMode', filePath),
                        outputDirectory: config.get('outputDirectory', filePath),
                        originalDirectory: config.get('originalDirectory', filePath),
                        inPlaceKeepOriginal: config.get('inPlaceKeepOriginal', filePath),
                        configBaseDir: config.getConfigDir(filePath)
                    });
                }

            } catch (err) {
                console.error('Error processing file:', err);
            }
        });
    }

    /**
     * CLOUD MODE: Convert in memory and upload directly to cloud
     */
    private async processCloudUpload(
        filePath: string,
        format: 'webp' | 'png' | 'jpeg' | 'avif',
        quality: number,
        config: ConfigService
    ): Promise<void> {
        const cloudConfig = config.getCloudConfig();
        if (!cloudConfig) {
            console.log('Upfly: Cloud config not available, skipping upload');
            return;
        }

        // Convert to buffer (no disk write)
        const { buffer } = await ConverterService.convertToBuffer(filePath, format, quality);
        const originalFilename = path.basename(filePath);

        // Calculate folder relative to workspace root
        let relativeFolder: string | undefined;
        if (vscode.workspace.workspaceFolders) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const relativePath = path.relative(workspaceRoot, filePath);
            relativeFolder = path.dirname(relativePath).replace(/\\/g, '/');
            if (relativeFolder === '.') relativeFolder = undefined;
        }

        // Notify user (debounced)
        this.notifyUploadStart();

        // Queue for cloud upload
        CloudService.queueUpload({
            buffer,
            localPath: filePath,
            convertedFormat: format,
            originalFilename,
            folder: relativeFolder,
            cloudConfig: {
                provider: cloudConfig.provider,
                config: cloudConfig.config,
                deleteLocalAfterUpload: cloudConfig.deleteLocalAfterUpload
            },
            onComplete: () => {
                // Delete original after successful upload if configured
                if (cloudConfig.deleteLocalAfterUpload) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`Upfly: Deleted original after upload: ${filePath}`);
                    } catch (e) {
                        console.error('Upfly: Failed to delete original', e);
                    }
                }
            }
        });

        console.log(`Upfly Cloud: Queued ${originalFilename} for upload`);
    }

    /**
     * CLOUD-ONLY MODE: Upload original file without conversion
     */
    private async processCloudUploadRaw(
        filePath: string,
        config: ConfigService
    ): Promise<void> {
        const cloudConfig = config.getCloudConfig();
        if (!cloudConfig) {
            console.log('Upfly: Cloud config not available, skipping upload');
            return;
        }

        // Read original file as buffer (no conversion)
        const buffer = fs.readFileSync(filePath);
        const originalFilename = path.basename(filePath);
        const ext = path.extname(filePath).slice(1).toLowerCase(); // e.g. 'png'

        // Calculate folder relative to workspace root
        let relativeFolder: string | undefined;
        if (vscode.workspace.workspaceFolders) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const relativePath = path.relative(workspaceRoot, filePath);
            relativeFolder = path.dirname(relativePath).replace(/\\/g, '/');
            if (relativeFolder === '.') relativeFolder = undefined;
        }

        // Notify user (debounced)
        this.notifyUploadStart();

        // Queue for cloud upload
        CloudService.queueUpload({
            buffer,
            localPath: filePath,
            convertedFormat: ext, // Original format
            originalFilename,
            folder: relativeFolder,
            cloudConfig: {
                provider: cloudConfig.provider,
                config: cloudConfig.config,
                deleteLocalAfterUpload: cloudConfig.deleteLocalAfterUpload
            },
            onComplete: () => {
                if (cloudConfig.deleteLocalAfterUpload) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`Upfly: Deleted original after upload: ${filePath}`);
                    } catch (e) {
                        console.error('Upfly: Failed to delete original', e);
                    }
                }
            }
        });

        console.log(`Upfly Cloud: Queued ${originalFilename} for RAW upload (no conversion)`);
    }

    private notifyUploadStart() {
        if (WatcherService.uploadDebounceTimer) {
            clearTimeout(WatcherService.uploadDebounceTimer);
        }
        WatcherService.uploadDebounceTimer = setTimeout(() => {
            vscode.window.showInformationMessage('Upfly: Uploading images to cloud...');
        }, 3000); // 1s delay to group batch pastes
    }

    public dispose() {
        this.watchers.forEach(w => w.dispose());
        this.watchers = [];
        if (this.renameListener) {
            this.renameListener.dispose();
            this.renameListener = undefined;
        }
        this.recentDeletes.clear();
        if (WatcherService.uploadDebounceTimer) {
            clearTimeout(WatcherService.uploadDebounceTimer);
        }
    }
}

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'jsonc-parser';

// Per-folder watch configuration
export interface WatchTarget {
    path: string;
    format: 'webp' | 'png' | 'jpeg' | 'avif';
    quality?: number;  // Default: 80
}

export interface UpflyConfig {
    enabled: boolean;
    watchTargets: WatchTarget[];
    storageMode: 'in-place' | 'separate-output' | 'separate-original';
    outputDirectory?: string;
    originalDirectory?: string;
    maxFileSize: number;
    inPlaceKeepOriginal: boolean;
}

const DEFAULT_WATCH_TARGET: WatchTarget = {
    path: 'public',
    format: 'webp',
    quality: 80
};

const DEFAULT_CONFIG: UpflyConfig = {
    enabled: true,
    watchTargets: [DEFAULT_WATCH_TARGET],
    storageMode: 'in-place',
    maxFileSize: 20000000,
    inPlaceKeepOriginal: false
};

export class ConfigService {
    private static instance: ConfigService;
    private configWatcher?: vscode.FileSystemWatcher;
    private _onDidChangeConfig = new vscode.EventEmitter<void>();
    public readonly onDidChangeConfig = this._onDidChangeConfig.event;

    // Cached targets sorted by path length (longest first) for efficient lookup
    private cachedTargets: WatchTarget[] = [];

    private constructor() {}

    static getInstance(): ConfigService {
        if (!this.instance) {
            this.instance = new ConfigService();
        }
        return this.instance;
    }

    private debounceTimer: NodeJS.Timeout | undefined;

    public initialize() {
        // Watch for upfly.config.json changes in the workspace root
        if (vscode.workspace.workspaceFolders) {
            const pattern = new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], 'upfly.config.json');
            this.configWatcher = vscode.workspace.createFileSystemWatcher(pattern);
            this.configWatcher.onDidChange(() => this.triggerConfigUpdate());
            this.configWatcher.onDidCreate(() => this.triggerConfigUpdate());
            this.configWatcher.onDidDelete(() => this.triggerConfigUpdate());
        }
        
        // Build cache and validate on initial load
        this.buildTargetCache();
        this.validateConfig();
    }

    /**
     * Normalize targets from either string[] (VS Code settings) or WatchTarget[] (upfly.config.json)
     * into a consistent WatchTarget[] format.
     */
    private normalizeTargets(raw: any): WatchTarget[] {
        if (!Array.isArray(raw) || raw.length === 0) {
            return DEFAULT_CONFIG.watchTargets;
        }

        return raw.map((item: any) => {
            if (typeof item === 'string') {
                // Legacy string format from VS Code settings
                return { path: item, format: 'webp' as const, quality: 80 };
            } else if (typeof item === 'object' && item !== null && item.path) {
                // New object format
                return {
                    path: item.path,
                    format: item.format || 'webp',
                    quality: item.quality ?? 80
                };
            }
            // Invalid item, use default
            return DEFAULT_WATCH_TARGET;
        });
    }

    private buildTargetCache() {
        const config = this.readLocalConfig();
        const rawTargets = config?.watchTargets || this.getVSCodeWatchTargets() || DEFAULT_CONFIG.watchTargets;
        const targets = this.normalizeTargets(rawTargets);
        
        // Sort by path length descending (longest/most specific first)
        this.cachedTargets = [...targets].sort((a, b) => b.path.length - a.path.length);
    }

    private getVSCodeWatchTargets(): any {
        const vscodeConfig = vscode.workspace.getConfiguration('upfly');
        return vscodeConfig.get('watchTargets');
    }

    /**
     * Get format and quality for a specific file path.
     * Uses cached targets for zero config-read overhead.
     */
    public getOptionsForPath(filePath: string): { format: 'webp' | 'png' | 'jpeg' | 'avif', quality: number } {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return { format: 'webp', quality: 80 };
        }

        // Get relative path and normalize slashes
        const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');

        // Find first match (longest path wins because sorted)
        for (const target of this.cachedTargets) {
            const normalizedTargetPath = target.path.replace(/\\/g, '/');
            if (relativePath.startsWith(normalizedTargetPath + '/') || relativePath.startsWith(normalizedTargetPath)) {
                return {
                    format: target.format,
                    quality: target.quality ?? 80
                };
            }
        }

        // Fallback to first target or default
        const fallback = this.cachedTargets[0] || DEFAULT_WATCH_TARGET;
        return { format: fallback.format, quality: fallback.quality ?? 80 };
    }

    private triggerConfigUpdate() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            console.log('Upfly: Config changed (debounced), validating and reloading...');
            this.buildTargetCache(); // Rebuild cache on config change
            this.validateConfig();
            this._onDidChangeConfig.fire();
        }, 500);
    }

    public get<T>(key: keyof UpflyConfig): T {
        // 1. Try upfly.config.json
        const jsonConfig = this.readLocalConfig();
        if (jsonConfig && jsonConfig[key] !== undefined) {
            return jsonConfig[key] as T;
        }

        // 2. Fallback to VS Code Settings
        const vscodeConfig = vscode.workspace.getConfiguration('upfly');
        const value = vscodeConfig.get<T>(key);
        if (value !== undefined) {
            return value;
        }

        // 3. Fallback to default
        if (key in DEFAULT_CONFIG) {
             return DEFAULT_CONFIG[key] as unknown as T;
        }
        return undefined as unknown as T;
    }

    private readLocalConfig(): Partial<UpflyConfig> | null {
        if (!vscode.workspace.workspaceFolders) return null;
        
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const configPath = path.join(rootPath, 'upfly.config.json');

        if (fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf8');
                return parse(content);
            } catch (e) {
                console.error('Failed to parse upfly.config.json', e);
            }
        }
        return null;
    }

    // ========== CONFIG VALIDATION ==========
    
    private _lastValidationErrors: string[] = [];
    private _isConfigValid: boolean = true;

    public get isConfigValid(): boolean {
        return this._isConfigValid;
    }

    public get validationErrors(): string[] {
        return this._lastValidationErrors;
    }

    /**
     * Validates the config and shows error messages if invalid.
     * Call this after config changes.
     * Returns true if config is valid, false otherwise.
     */
    public validateConfig(): boolean {
        const config = this.readLocalConfig();
        const errors: string[] = [];

        // If no config file, use defaults which are always valid
        if (!config) {
            this._isConfigValid = true;
            this._lastValidationErrors = [];
            return true;
        }

        // Validate `watchTargets` - must be array of { path, format, quality? }
        const validFormats = ['webp', 'png', 'jpeg', 'avif'];
        if (config.watchTargets !== undefined) {
            if (!Array.isArray(config.watchTargets)) {
                errors.push(`"watchTargets" must be an array.`);
            } else if (config.watchTargets.length === 0) {
                errors.push(`"watchTargets" cannot be empty. Add at least one target.`);
            } else {
                config.watchTargets.forEach((target: any, index: number) => {
                    const prefix = `watchTargets[${index}]`;
                    
                    if (typeof target !== 'object' || target === null) {
                        errors.push(`${prefix}: Must be an object with "path" and "format".`);
                        return;
                    }
                    
                    if (!target.path || typeof target.path !== 'string') {
                        errors.push(`${prefix}: "path" is required and must be a string.`);
                    }
                    
                    if (!target.format || !validFormats.includes(target.format)) {
                        errors.push(`${prefix}: "format" must be one of: ${validFormats.join(', ')}`);
                    }
                    
                    if (target.quality !== undefined) {
                        if (typeof target.quality !== 'number' || target.quality < 1 || target.quality > 100) {
                            errors.push(`${prefix}: "quality" must be 1-100.`);
                        }
                    }
                });
            }
        }

        // Validate `storageMode`
        const validStorageModes = ['in-place', 'separate-output', 'separate-original'];
        if (config.storageMode !== undefined && !validStorageModes.includes(config.storageMode as string)) {
            errors.push(`"storageMode": "${config.storageMode}" is invalid. Use one of: ${validStorageModes.join(', ')}`);
        }

        // Validate `enabled`
        if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
            errors.push(`"enabled" must be true or false.`);
        }

        // Validate `inPlaceKeepOriginal`
        if (config.inPlaceKeepOriginal !== undefined && typeof config.inPlaceKeepOriginal !== 'boolean') {
            errors.push(`"inPlaceKeepOriginal" must be true or false.`);
        }

        // Validate `maxFileSize`
        if (config.maxFileSize !== undefined) {
            if (typeof config.maxFileSize !== 'number' || config.maxFileSize < 0) {
                errors.push(`"maxFileSize" must be a positive number (in bytes).`);
            }
        }

        // Validate `outputDirectory` (must be string if provided)
        if (config.outputDirectory !== undefined && typeof config.outputDirectory !== 'string') {
            errors.push(`"outputDirectory" must be a string path.`);
        }

        // Validate `originalDirectory` (must be string if provided)
        if (config.originalDirectory !== undefined && typeof config.originalDirectory !== 'string') {
            errors.push(`"originalDirectory" must be a string path.`);
        }

        // Check for required directories based on storageMode
        if (config.storageMode === 'separate-output' && !config.outputDirectory) {
            errors.push(`"storageMode" is "separate-output" but "outputDirectory" is not set.`);
        }
        if (config.storageMode === 'separate-original' && !config.originalDirectory) {
            errors.push(`"storageMode" is "separate-original" but "originalDirectory" is not set.`);
        }

        // Store results
        this._lastValidationErrors = errors;
        this._isConfigValid = errors.length === 0;

        // Only log errors silently (no popup while editing)
        if (errors.length > 0) {
            console.log('Upfly: Config validation errors detected (silent):', errors);
        }

        return this._isConfigValid;
    }

    /**
     * Show validation errors to user (called when processing is attempted with invalid config)
     */
    public showConfigErrors() {
        if (this._lastValidationErrors.length === 0) return;
        
        const errorList = this._lastValidationErrors.map((e, i) => `${i + 1}. ${e}`).join('\n');
        vscode.window.showWarningMessage(
            `Upfly: Invalid config. Fix errors to enable conversion.`,
            'Show Details'
        ).then(selection => {
            if (selection === 'Show Details') {
                vscode.window.showErrorMessage(`Upfly Config Errors:\n${errorList}`, { modal: true });
            }
        });
    }

    public async createConfigFile() {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showErrorMessage('Upfly: Open a folder to create a config file.');
            return;
        }

        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const configPath = path.join(rootPath, 'upfly.config.json');

        if (fs.existsSync(configPath)) {
            vscode.window.showInformationMessage('Upfly: upfly.config.json already exists.');
            return;
        }

        const configTemplate = `{
  "enabled": true,      // Enable or disable Upfly image processing

  // Each folder can have its own format and quality settings
  // Subdirectories inherit parent settings unless overridden
  "watchTargets": [
    { "path": "public", "format": "webp", "quality": 80 }
  ],

  // Where to store converted files
  // - in-place: Save converted file in same folder as original
  // - separate-output: Save converted file to outputDirectory
  // - separate-original: Move original to originalDirectory, keep converted in place
  "storageMode": "in-place",

  "inPlaceKeepOriginal": false,     // Keep original file after conversion

  // --- Optional Fields (uncomment to use) ---

  // "outputDirectory": "./converted",       // For "separate-output" mode
  // "originalDirectory": "./originals",     // For "separate-original" mode

  "maxFileSize": 20000000       // Maximum file size in bytes (default: 20MB)
}
`;

        try {
            fs.writeFileSync(configPath, configTemplate);
            const doc = await vscode.workspace.openTextDocument(configPath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage('Upfly: Created upfly.config.json');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Upfly: Failed to create config file. ${e.message}`);
        }
    }
    
    public dispose() {
        this.configWatcher?.dispose();
        this._onDidChangeConfig.dispose();
    }
}

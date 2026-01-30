import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'jsonc-parser';

export interface UpflyConfig {
    enabled: boolean;
    watchTargets: string[];
    storageMode: 'in-place' | 'separate-output' | 'separate-original';
    outputDirectory?: string;
    originalDirectory?: string;
    format: 'webp' | 'png' | 'jpeg' | 'avif';
    quality: number;
    maxFileSize: number;
    inPlaceKeepOriginal: boolean;
}

const DEFAULT_CONFIG: UpflyConfig = {
    enabled: true,
    watchTargets: ['public'],
    storageMode: 'in-place',
    format: 'webp',
    quality: 80,
    maxFileSize: 20000000,
    inPlaceKeepOriginal: false
};

export class ConfigService {
    private static instance: ConfigService;
    private configWatcher?: vscode.FileSystemWatcher;
    private _onDidChangeConfig = new vscode.EventEmitter<void>();
    public readonly onDidChangeConfig = this._onDidChangeConfig.event;

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
        
        // Validate config on initial load
        this.validateConfig();
    }

    private triggerConfigUpdate() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            console.log('Upfly: Config changed (debounced), validating and reloading...');
            this.validateConfig(); // Validate on every config change
            this._onDidChangeConfig.fire();
        }, 500); // 500ms delay to prevent rapid reloads
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

        // Validate `format`
        const validFormats = ['webp', 'png', 'jpeg', 'avif'];
        if (config.format !== undefined && !validFormats.includes(config.format as string)) {
            errors.push(`"format": "${config.format}" is invalid. Use one of: ${validFormats.join(', ')}`);
        }

        // Validate `quality`
        if (config.quality !== undefined) {
            if (typeof config.quality !== 'number' || config.quality < 1 || config.quality > 100) {
                errors.push(`"quality": ${config.quality} is invalid. Use a number between 1 and 100.`);
            }
        }

        // Validate `storageMode`
        const validStorageModes = ['in-place', 'separate-output', 'separate-original'];
        if (config.storageMode !== undefined && !validStorageModes.includes(config.storageMode as string)) {
            errors.push(`"storageMode": "${config.storageMode}" is invalid. Use one of: ${validStorageModes.join(', ')}`);
        }

        // Validate `watchTargets`
        if (config.watchTargets !== undefined) {
            if (!Array.isArray(config.watchTargets)) {
                errors.push(`"watchTargets" must be an array. Example: ["public", "assets"]`);
            } else {
                const invalidEntries = config.watchTargets.filter(t => typeof t !== 'string');
                if (invalidEntries.length > 0) {
                    errors.push(`"watchTargets" contains non-string values. All entries must be strings.`);
                }
            }
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

        // Show error message if invalid (debounced to avoid spamming user while typing)
        if (errors.length > 0) {
            this.showValidationErrorDebounced(errors);
        }

        return this._isConfigValid;
    }

    private notificationDebounceTimer: NodeJS.Timeout | undefined;

    private showValidationErrorDebounced(errors: string[]) {
        if (this.notificationDebounceTimer) {
            clearTimeout(this.notificationDebounceTimer);
        }
        this.notificationDebounceTimer = setTimeout(() => {
            const errorList = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
            vscode.window.showWarningMessage(
                `Upfly: Invalid config detected. Auto-conversion disabled until fixed.`,
                'Show Details'
            ).then(selection => {
                if (selection === 'Show Details') {
                    vscode.window.showErrorMessage(`Upfly Config Errors:\n${errorList}`, { modal: true });
                }
            });
            console.error('Upfly Config Validation Errors:', errors);
        }, 3000); 
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

  "watchTargets": ["public"],   // Examples: "public", "src/assets", "images"

  "format": "webp",       // Options: "webp", "avif", "jpeg", "png"

  "quality": 80,        // Compression quality (1-100, higher = better quality, larger file)

  // Where to store converted files
  // - in-place: Save converted file in same folder as original
  // - separate-output: Save converted file to outputDirectory
  // - separate-original: Move original to originalDirectory, keep converted in place
  "storageMode": "in-place",

  "inPlaceKeepOriginal": false,     // Keep original file after in-place conversion (only applies to "in-place" mode)

  // --- Optional Fields (uncomment to use) ---

  // "outputDirectory": "./converted",       // Directory for converted files (required for "separate-output" mode)

  // "originalDirectory": "./originals",     // Directory to move originals (required for "separate-original" mode)

  "maxFileSize": 20000000       // Maximum file size to process in bytes (default: 20MB)

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

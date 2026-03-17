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

// Cloud upload configuration
export interface CloudUploadConfig {
    enabled: boolean;
    watchTargets: string[];  // Paths that trigger cloud upload (must exist in root watchTargets)
    provider: 's3' | 'cloudinary' | 'gcs';
    config: Record<string, string>;  // Provider-specific config (supports ${env:VAR})
    deleteLocalAfterUpload: boolean;
}

export interface UpflyConfig {
    enabled: boolean;
    watchTargets: WatchTarget[];
    storageMode: 'in-place' | 'separate-output' | 'separate-original';
    outputDirectory?: string;
    originalDirectory?: string;
    maxFileSize: number;
    inPlaceKeepOriginal: boolean;
    cloudUpload?: CloudUploadConfig;
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
        // Watch for upfly.config.json changes anywhere in the workspace
        if (vscode.workspace.workspaceFolders) {
            const pattern = new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], '**/upfly.config.json');
            this.configWatcher = vscode.workspace.createFileSystemWatcher(pattern);
            this.configWatcher.onDidChange(() => this.triggerConfigUpdate());
            this.configWatcher.onDidCreate(() => this.triggerConfigUpdate());
            this.configWatcher.onDidDelete(() => this.triggerConfigUpdate());
        }
        
        // Discover all configs, build cache and validate on initial load
        this.discoverAllConfigs();
        this.buildTargetCache();
        this.validateConfig();
    }

    /**
     * Normalize targets from either string[] (VS Code settings) or WatchTarget[] (upfly.config.json)
     * into a consistent WatchTarget[] format.
     */
    private normalizeTargets(raw: any): WatchTarget[] {
        // If explicitly empty array, return empty (for cloud-only mode)
        if (Array.isArray(raw) && raw.length === 0) {
            return [];
        }
        // If undefined/null, use defaults
        if (!Array.isArray(raw)) {
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
        // Build global target cache from ALL discovered configs in the workspace.
        // This ensures the WatcherService watches folders from every sub-project config.
        // Per-file resolving still uses findBestConfig for the correct per-file settings.
        const allTargets: WatchTarget[] = [];

        if (this.discoveredConfigs.length > 0) {
            for (const configPath of this.discoveredConfigs) {
                try {
                    const content = fs.readFileSync(configPath, 'utf8');
                    const config = parse(content);
                    if (config?.watchTargets) {
                        allTargets.push(...this.normalizeTargets(config.watchTargets));
                    }
                } catch {}
            }
        }

        // If no configs found, fall back to VS Code settings or defaults
        if (allTargets.length === 0) {
            const fallback = this.getVSCodeWatchTargets() || DEFAULT_CONFIG.watchTargets;
            allTargets.push(...this.normalizeTargets(fallback));
        }

        // Deduplicate by path and sort by length descending (most specific first)
        const uniquePaths = new Set<string>();
        this.cachedTargets = allTargets
            .filter(t => {
                if (uniquePaths.has(t.path)) return false;
                uniquePaths.add(t.path);
                return true;
            })
            .sort((a, b) => b.path.length - a.path.length);
    }

    private getVSCodeWatchTargets(): any {
        const vscodeConfig = vscode.workspace.getConfiguration('upfly');
        return vscodeConfig.get('watchTargets');
    }

    /**
     * Get format and quality for a specific file path.
     * Looks up the nearest config file, then falls back to defaults.
     */
    public getOptionsForPath(filePath: string): { format: 'webp' | 'png' | 'jpeg' | 'avif', quality: number } {
        // Instead of cached targets, use nearest config for accuracy in multi-config workspaces
        const config = this.readLocalConfig(filePath);
        const rawTargets = config?.watchTargets || this.getVSCodeWatchTargets() || DEFAULT_CONFIG.watchTargets;
        const targets = this.normalizeTargets(rawTargets);
        
        // Sort by path length descending (longest/most specific first)
        const sortedTargets = [...targets].sort((a, b) => b.path.length - a.path.length);

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return { format: 'webp', quality: 80 };
        }

        // Get relative path and normalize slashes
        const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');

        for (const target of sortedTargets) {
            const normalizedTargetPath = target.path.replace(/\\/g, '/');
            if (this.pathMatchesTarget(relativePath, normalizedTargetPath)) {
                return {
                    format: target.format,
                    quality: target.quality ?? 80
                };
            }
        }

        const fallback = sortedTargets[0] || DEFAULT_WATCH_TARGET;
        return { format: fallback.format, quality: fallback.quality ?? 80 };
    }

    // ========== CLOUD UPLOAD HELPERS ==========

    /**
     * Check if a file path should trigger cloud upload
     * Path must be in cloudUpload.watchTargets (independent of root watchTargets)
     */
    public isCloudTarget(filePath: string): boolean {
        const cloudConfig = this.get<CloudUploadConfig | undefined>('cloudUpload');
        if (!cloudConfig?.enabled || !cloudConfig.watchTargets?.length) {
            return false;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return false;

        const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');

        // Check if path matches any cloudUpload.watchTargets
        // Match at any depth to be consistent with watcher glob pattern
        for (const target of cloudConfig.watchTargets) {
            const normalizedTarget = target.replace(/\\/g, '/');
            if (this.pathMatchesTarget(relativePath, normalizedTarget)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if a file path should be converted (exists in root watchTargets)
     */
    public shouldConvert(filePath: string): boolean {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return false;

        const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
                
        // Check if path matches any root watchTargets
        // Match at any depth to be consistent with watcher glob pattern **/target/**/*
        for (const target of this.cachedTargets) {
            const normalizedTarget = target.path.replace(/\\/g, '/');
            if (this.pathMatchesTarget(relativePath, normalizedTarget)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if a relative file path falls under a watch target directory.
     * Matches the target as a path segment at any depth, consistent with
     * the watcher glob pattern: ** /target/** /*.ext
     * 
     * Examples:
     *   pathMatchesTarget('public/img.jpg', 'public') → true
     *   pathMatchesTarget('project/public/img.jpg', 'public') → true  
     *   pathMatchesTarget('assets/images/photo.png', 'assets') → true
     *   pathMatchesTarget('not-public/img.jpg', 'public') → false
     */
    private pathMatchesTarget(relativePath: string, target: string): boolean {
        // Direct prefix match (target is at workspace root level)
        if (relativePath.startsWith(target + '/') || relativePath === target) {
            return true;
        }
        // Target appears as a path segment deeper in the tree
        if (relativePath.includes('/' + target + '/') || relativePath.endsWith('/' + target)) {
            return true;
        }
        return false;
    }

    /**
     * Get cloud watch targets (for WatcherService to create watchers)
     */
    public getCloudWatchTargets(): string[] {
        const cloudConfig = this.get<CloudUploadConfig | undefined>('cloudUpload');
        if (!cloudConfig?.enabled || !cloudConfig.watchTargets?.length) {
            return [];
        }
        return cloudConfig.watchTargets;
    }

    /**
     * Get resolved cloud config with env variables replaced
     */
    public getCloudConfig(): CloudUploadConfig | null {
        const cloudConfig = this.get<CloudUploadConfig | undefined>('cloudUpload');
        if (!cloudConfig?.enabled) return null;

        // Resolve env variables in config
        const resolvedConfig = { ...cloudConfig.config };
        for (const [key, value] of Object.entries(resolvedConfig)) {
            resolvedConfig[key] = this.resolveEnvVars(value);
        }

        return {
            ...cloudConfig,
            config: resolvedConfig
        };
    }

    /**
     * Resolve ${env:VAR_NAME} patterns to actual environment values
     * Loads from both .env file in workspace AND system environment variables
     */
    private resolveEnvVars(value: string): string {
        if (typeof value !== 'string') return value;
        
        // Load .env file from workspace root
        const envVars = this.loadEnvFile();
        
        return value.replace(/\$\{env:([^}]+)\}/g, (match, varName) => {
            // First check .env file, then fall back to process.env
            const envValue = envVars[varName] ?? process.env[varName];
            if (envValue === undefined) {
                console.warn(`Upfly: Environment variable ${varName} not found in .env or system environment`);
                return match; // Keep original if not found
            }
            return envValue;
        });
    }

    /**
     * Parse .env file from workspace root
     */
    private loadEnvFile(): Record<string, string> {
        const envVars: Record<string, string> = {};
        
        if (!vscode.workspace.workspaceFolders) {
            return envVars;
        }
        
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const envPath = path.join(rootPath, '.env');
        
        if (!fs.existsSync(envPath)) {
            return envVars;
        }
        
        try {
            const envContent = fs.readFileSync(envPath, 'utf-8');
            const lines = envContent.split('\n');
            
            for (const line of lines) {
                const trimmed = line.trim();
                // Skip comments and empty lines
                if (!trimmed || trimmed.startsWith('#')) continue;
                
                const eqIndex = trimmed.indexOf('=');
                if (eqIndex === -1) continue;
                
                const key = trimmed.substring(0, eqIndex).trim();
                let value = trimmed.substring(eqIndex + 1).trim();
                
                // Remove surrounding quotes if present
                if ((value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                
                envVars[key] = value;
            }
        } catch (e) {
            console.warn('Upfly: Failed to parse .env file:', e);
        }
        
        return envVars;
    }

    private triggerConfigUpdate() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            console.log('Upfly: Config changed (debounced), validating and reloading...');
            this.discoverAllConfigs(); // Re-scan for config files
            this.buildTargetCache(); // Rebuild cache on config change
            this.validateConfig();
            this._onDidChangeConfig.fire();
        }, 500);
    }

    public get<T>(key: keyof UpflyConfig, filePath?: string): T {
        // 1. Try upfly.config.json (nearest to filePath if provided)
        const jsonConfig = this.readLocalConfig(filePath);
        if (jsonConfig && jsonConfig[key] !== undefined) {
            return jsonConfig[key] as T;
        }

        // 2. Fallback to VS Code Settings (only if explicitly enabled to prevent unexpected global behavior)
        const useGlobal = vscode.workspace.getConfiguration('upfly').get<boolean>('useGlobalSettings', false);
        if (useGlobal) {
            const vscodeConfig = vscode.workspace.getConfiguration('upfly');
            const value = vscodeConfig.get<T>(key);
            if (value !== undefined) {
                return value;
            }
        }

        // 3. Fallback to default
        if (key in DEFAULT_CONFIG) {
             return DEFAULT_CONFIG[key] as unknown as T;
        }
        return undefined as unknown as T;
    }

    public hasLocalConfig(): boolean {
        if (!vscode.workspace.workspaceFolders) return false;
        
        // Quick check: does any upfly.config.json exist in the workspace?
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        
        // Check root first (fastest)
        if (fs.existsSync(path.join(rootPath, 'upfly.config.json'))) return true;
        
        // Scan for sub configs (depth 1 to avoid massive delay)
        try {
            const entries = fs.readdirSync(rootPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    if (fs.existsSync(path.join(rootPath, entry.name, 'upfly.config.json'))) {
                        return true;
                    }
                }
            }
        } catch (e) {}
        
        return false;
    }

    // Cache of all discovered config file paths in the workspace
    private discoveredConfigs: string[] = [];

    /**
     * Scan the workspace to discover all upfly.config.json files.
     * Called on initialization and when configs are created/deleted.
     */
    private discoverAllConfigs() {
        this.discoveredConfigs = [];
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        this.scanForConfigs(workspaceRoot, 0);
    }

    private scanForConfigs(dir: string, depth: number) {
        if (depth > 5) return; // Don't scan too deep
        try {
            const configPath = path.join(dir, 'upfly.config.json');
            if (fs.existsSync(configPath)) {
                this.discoveredConfigs.push(configPath);
            }
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'build') {
                    this.scanForConfigs(path.join(dir, entry.name), depth + 1);
                }
            }
        } catch {}
    }

    /**
     * Find the best config for a given file path.
     * 
     * Strategy:
     * 1. Walk up from the file's directory looking for an ancestor config (direct parent match)
     * 2. If no ancestor config, find the config whose directory is the closest common parent
     *    (e.g. config in /project/frontend/ applies to /project/public/ because they share /project/)
     * 3. Fall back to root config if exists
     */
    private findBestConfig(filePath: string): string | null {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return null;

        // 1. Direct ancestor lookup (walk up from file's directory)
        let dir = path.dirname(filePath);
        while (dir.length >= workspaceRoot.length) {
            const configPath = path.join(dir, 'upfly.config.json');
            if (fs.existsSync(configPath)) return configPath;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }

        // 2. If no ancestor config, find the closest discovered config
        //    by finding the one that shares the longest common path with the file
        if (this.discoveredConfigs.length > 0) {
            const fileDir = path.dirname(filePath).toLowerCase();
            let bestConfig: string | null = null;
            let bestCommonLength = -1;

            for (const configPath of this.discoveredConfigs) {
                const configDir = path.dirname(configPath).toLowerCase();
                // Find common prefix length
                const commonDir = this.getCommonParent(fileDir, configDir);
                if (commonDir.length > bestCommonLength) {
                    bestCommonLength = commonDir.length;
                    bestConfig = configPath;
                }
            }
            
            if (bestConfig) return bestConfig;
        }

        return null;
    }

    /**
     * Get the directory of the config file that applies to a given file path.
     * Used to resolve relative paths (like outputDirectory) relative to the config location.
     */
    public getConfigDir(filePath: string): string {
        const configPath = this.findBestConfig(filePath);
        if (configPath) return path.dirname(configPath);
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(filePath);
    }

    /**
     * Get the common parent directory of two paths
     */
    private getCommonParent(path1: string, path2: string): string {
        const parts1 = path1.replace(/\\/g, '/').split('/');
        const parts2 = path2.replace(/\\/g, '/').split('/');
        const common: string[] = [];
        for (let i = 0; i < Math.min(parts1.length, parts2.length); i++) {
            if (parts1[i] === parts2[i]) {
                common.push(parts1[i]);
            } else {
                break;
            }
        }
        return common.join('/');
    }

    private readLocalConfig(filePath?: string): Partial<UpflyConfig> | null {
        if (!vscode.workspace.workspaceFolders) return null;
        
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        
        // If a file path is provided, find the best matching config
        let configPath = filePath ? this.findBestConfig(filePath) : path.join(rootPath, 'upfly.config.json');
        
        // If not found via nearest ancestor (or no filePath), check root
        if (!configPath || !fs.existsSync(configPath)) {
            configPath = path.join(rootPath, 'upfly.config.json');
        }

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
        const hasCloudTargets = config.cloudUpload?.enabled && 
                                Array.isArray(config.cloudUpload?.watchTargets) && 
                                config.cloudUpload.watchTargets.length > 0;
        
        if (config.watchTargets !== undefined) {
            if (!Array.isArray(config.watchTargets)) {
                errors.push(`"watchTargets" must be an array.`);
            } else if (config.watchTargets.length === 0 && !hasCloudTargets) {
                // Only error if BOTH root and cloud watchTargets are empty
                errors.push(`"watchTargets" cannot be empty (unless cloudUpload.watchTargets is set).`);
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

        // Validate `cloudUpload` (if present)
        if (config.cloudUpload !== undefined) {
            const cloud = config.cloudUpload;
            
            if (typeof cloud !== 'object' || cloud === null) {
                errors.push(`"cloudUpload" must be an object.`);
            } else {
                // Validate enabled
                if (cloud.enabled !== undefined && typeof cloud.enabled !== 'boolean') {
                    errors.push(`"cloudUpload.enabled" must be true or false.`);
                }

                // Validate provider
                const validProviders = ['s3', 'cloudinary', 'gcs'];
                if (cloud.enabled && !validProviders.includes(cloud.provider)) {
                    errors.push(`"cloudUpload.provider" must be one of: ${validProviders.join(', ')}`);
                }

                // Validate watchTargets
                if (cloud.enabled) {
                    if (!Array.isArray(cloud.watchTargets) || cloud.watchTargets.length === 0) {
                        errors.push(`"cloudUpload.watchTargets" must be a non-empty array of paths.`);
                    }
                    // Note: cloud watchTargets are independent of root watchTargets
                    // They can be cloud-only (no conversion) or overlap with root (convert + upload)
                }

                // Validate config object
                if (cloud.enabled && (!cloud.config || typeof cloud.config !== 'object')) {
                    errors.push(`"cloudUpload.config" is required when cloud upload is enabled.`);
                }

                // Validate deleteLocalAfterUpload
                if (cloud.deleteLocalAfterUpload !== undefined && typeof cloud.deleteLocalAfterUpload !== 'boolean') {
                    errors.push(`"cloudUpload.deleteLocalAfterUpload" must be true or false.`);
                }
            }
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

    private detectSubProjects(rootPath: string): string[] {
        try {
            const entries = fs.readdirSync(rootPath, { withFileTypes: true });
            return entries
                .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
                .map(e => path.join(rootPath, e.name))
                .filter(dir => 
                    fs.existsSync(path.join(dir, 'package.json')) ||
                    fs.existsSync(path.join(dir, 'composer.json')) ||
                    fs.existsSync(path.join(dir, 'Cargo.toml')) ||
                    fs.existsSync(path.join(dir, 'pom.xml')) ||
                    fs.existsSync(path.join(dir, 'go.mod'))
                );
        } catch {
            return [];
        }
    }

    public async createConfigFile() {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showErrorMessage('Upfly: Open a folder to create a config file.');
            return;
        }

        let targetDirs: string[] = [];
        
        if (vscode.workspace.workspaceFolders.length > 1) {
            // Multi-root workspace default VS Code picker
            const picked = await vscode.window.showWorkspaceFolderPick({
                placeHolder: 'Select folder for upfly.config.json'
            });
            if (!picked) return;
            targetDirs.push(picked.uri.fsPath);
        } else {
            // Single root — scan for sub-projects
            const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const subProjects = this.detectSubProjects(rootPath);
            
            if (subProjects.length > 0) {
                const items: vscode.QuickPickItem[] = [
                    { label: `$(folder) ${path.basename(rootPath)} (Workspace Root)`, description: rootPath },
                    ...subProjects.map(sp => ({ label: `$(briefcase) ${path.basename(sp)}`, description: sp }))
                ];
                
                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Where should the config be created?',
                    canPickMany: true
                });
                
                if (!picked || picked.length === 0) return;
                targetDirs = picked.map(p => p.description!);
            } else {
                targetDirs.push(rootPath);
            }
        }

        const configTemplate = `{
  // Auto-convert images dropped into watched folders
  "enabled": true,

  // Watched folders — each can have its own format & quality
  "watchTargets": [
    { "path": "public", "format": "webp", "quality": 80 }
  ],

  // "in-place"           → replace original in same location
  // "separate-output"    → keep original, save converted to outputDirectory
  // "separate-original"  → move original to originalDirectory, converted stays in place
  "storageMode": "in-place",
  "inPlaceKeepOriginal": false,
  "outputDirectory": "./converted",
  "originalDirectory": "./originals",

  // Max file size to process (default: 20 MB)
  "maxFileSize": 20000000

  // ── Cloud Upload (optional) ─────────────────────────────
  // Providers: "cloudinary" | "s3" | "gcs"
  //
  // "cloudUpload": {
  //   "enabled": true,
  //   "watchTargets": ["public"],
  //   "provider": "cloudinary",
  //   "config": {
  //     "cloudName": "\${env:CLOUDINARY_CLOUD_NAME}",
  //     "apiKey": "\${env:CLOUDINARY_API_KEY}",
  //     "apiSecret": "\${env:CLOUDINARY_API_SECRET}",
  //     "folder": "uploads"
  //   },
  //   "deleteLocalAfterUpload": false
  // }
}
`;

        for (const targetDir of targetDirs) {
            const configPath = path.join(targetDir, 'upfly.config.json');

            if (fs.existsSync(configPath)) {
                vscode.window.showInformationMessage(`Upfly: config already exists in ${path.basename(targetDir)}`);
                continue;
            }

            try {
                fs.writeFileSync(configPath, configTemplate);
                const doc = await vscode.workspace.openTextDocument(configPath);
                await vscode.window.showTextDocument(doc, { preview: false });
                vscode.window.showInformationMessage(`Upfly: Created upfly.config.json in ${path.basename(targetDir)}`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Upfly: Failed to create config file. ${e.message}`);
            }
        }
    }
    
    public dispose() {
        this.configWatcher?.dispose();
        this._onDidChangeConfig.dispose();
    }
}

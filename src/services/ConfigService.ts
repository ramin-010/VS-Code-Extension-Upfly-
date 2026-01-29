import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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
    watchTargets: ['**/public/**/*.{png,jpg,jpeg}'],
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

    public initialize() {
        // Watch for upfly.json changes in the workspace root
        if (vscode.workspace.workspaceFolders) {
            const pattern = new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], 'upfly.json');
            this.configWatcher = vscode.workspace.createFileSystemWatcher(pattern);
            this.configWatcher.onDidChange(() => this._onDidChangeConfig.fire());
            this.configWatcher.onDidCreate(() => this._onDidChangeConfig.fire());
            this.configWatcher.onDidDelete(() => this._onDidChangeConfig.fire());
        }
    }

    public get<T>(key: keyof UpflyConfig): T {
        // 1. Try upfly.json
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
        const configPath = path.join(rootPath, 'upfly.json');

        if (fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf8');
                return JSON.parse(content);
            } catch (e) {
                console.error('Failed to parse upfly.json', e);
            }
        }
        return null;
    }

    public async createConfigFile() {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showErrorMessage('Upfly: Open a folder to create a config file.');
            return;
        }

        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const configPath = path.join(rootPath, 'upfly.json');

        if (fs.existsSync(configPath)) {
            vscode.window.showInformationMessage('Upfly: upfly.json already exists.');
            return;
        }

        try {
            fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
            const doc = await vscode.workspace.openTextDocument(configPath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage('Upfly: Created upfly.json');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Upfly: Failed to create config file. ${e.message}`);
        }
    }
    
    public dispose() {
        this.configWatcher?.dispose();
        this._onDidChangeConfig.dispose();
    }
}

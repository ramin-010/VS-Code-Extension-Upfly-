/**
 * ResponseService - Manages .upfly/uploads.json for cloud upload responses
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface UploadRecord {
    localPath: string;
    convertedFormat?: string;
    cloudUrl?: string;
    cloudPublicId?: string;
    provider?: string;
    status: 'success' | 'failed';
    error?: string;
    uploadedAt?: string;
    failedAt?: string;
    size?: number;
}

interface UploadsFile {
    uploads: UploadRecord[];
}

export class ResponseService {
    private static getFilePath(): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) throw new Error('No workspace folder');
        
        const upflyDir = path.join(workspaceRoot, '.upfly');
        if (!fs.existsSync(upflyDir)) {
            fs.mkdirSync(upflyDir, { recursive: true });
        }
        
        return path.join(upflyDir, 'uploads.json');
    }

    /**
     * Append a new upload record to the responses file
     */
    static append(record: UploadRecord): void {
        const filePath = this.getFilePath();
        let data: UploadsFile = { uploads: [] };

        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                data = JSON.parse(content);
            }
        } catch (e) {
            // Start fresh if parse fails
            data = { uploads: [] };
        }

        data.uploads.push(record);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }

    /**
     * Read all upload records
     */
    static read(): UploadRecord[] {
        const filePath = this.getFilePath();
        
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const data: UploadsFile = JSON.parse(content);
                return data.uploads || [];
            }
        } catch (e) {
            console.error('Upfly: Failed to read uploads.json', e);
        }
        
        return [];
    }

    /**
     * Clear all records (for testing/reset)
     */
    static clear(): void {
        const filePath = this.getFilePath();
        fs.writeFileSync(filePath, JSON.stringify({ uploads: [] }, null, 2));
    }
}

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import sharp from 'sharp';
import { ProcessingCache } from './ProcessingCache';

interface ConversionOptions {
    format: 'webp' | 'png' | 'jpeg' | 'avif';
    quality: number;
    storageMode: 'in-place' | 'separate-output' | 'separate-original';
    outputDirectory?: string;
    originalDirectory?: string;
    inPlaceKeepOriginal?: boolean;
    isCompression?: boolean;
}

export class ConverterService {
    private static readonly MAX_SUFFIX = 100;
    
    private static getTempDir(): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) throw new Error('No workspace folder found');
        const tempDir = path.join(workspaceRoot, '.upfly', 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        return tempDir;
    }

    static cleanupTempDir(): void {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) return;
            const tempDir = path.join(workspaceRoot, '.upfly', 'temp');
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch (e) {
            console.error('Upfly: Failed to cleanup temp directory', e);
        }
    }

    private static getUniqueOutputPath(dir: string, baseName: string, ext: string, isCompression: boolean): string {
        const suffix = isCompression ? '_compressed' : '';
        let candidate = path.join(dir, `${baseName}${suffix}.${ext}`);
        
        if (!fs.existsSync(candidate)) {
            return candidate;
        }

        for (let i = 1; i <= this.MAX_SUFFIX; i++) {
            const numberedSuffix = isCompression ? `_compressed${i}` : `_copy${i}`;
            candidate = path.join(dir, `${baseName}${numberedSuffix}.${ext}`);
            if (!fs.existsSync(candidate)) {
                return candidate;
            }
        }

        throw new Error(`Too many copies exist for ${baseName}.${ext}`);
    }

    static async isValidImage(filePath: string): Promise<boolean> {
        try {
            const { fileTypeFromFile } = await eval('import("file-type")');
            const type = await fileTypeFromFile(filePath);
            if (!type) return false;
            const allowedTypes = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'tiff'];
            return allowedTypes.includes(type.ext);
        } catch (error) {
            console.error('Upfly: Validation Failed', error);
            return /\.(jpg|jpeg|png|webp|avif)$/i.test(filePath);
        }
    }

    /**
     * Convert image to buffer (for cloud uploads - no disk write)
     */
    static async convertToBuffer(
        filePath: string, 
        format: 'webp' | 'png' | 'jpeg' | 'avif',
        quality: number
    ): Promise<{ buffer: Buffer; format: string; size: number }> {
        const inputBuffer = fs.readFileSync(filePath);
        
            const outputBuffer = await sharp(inputBuffer)
            .toFormat(format, { quality })
            .toBuffer();

        return {
            buffer: outputBuffer,
            format,
            size: outputBuffer.length
        };
    }

    static async convertFile(filePath: string, options: ConversionOptions) {
        const fileDir = path.dirname(filePath);
        const fileExt = path.extname(filePath).toLowerCase().replace('.', '');
        const fileName = path.basename(filePath, path.extname(filePath));
        const normalizedInputExt = fileExt === 'jpg' ? 'jpeg' : fileExt;
        const isSameFormat = normalizedInputExt === options.format;
        const isCompression = options.isCompression ?? false;

        const tempDir = this.getTempDir();
        const tempFileName = `${fileName}_${Date.now()}.${options.format}`;
        const tempPath = path.join(tempDir, tempFileName);

        let finalOutputDir = fileDir;
        if (options.storageMode === 'separate-output' && options.outputDirectory) {
            finalOutputDir = path.isAbsolute(options.outputDirectory) 
                ? options.outputDirectory 
                : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || fileDir, options.outputDirectory);
            if (!fs.existsSync(finalOutputDir)) {
                fs.mkdirSync(finalOutputDir, { recursive: true });
            }
        }

        let finalOutputPath: string;
        try {
            // For in-place optimization (same format, not compression cmd), we WANT to target the input file.
            // We do NOT want getUniqueOutputPath to give us 'image_copy1.png'.
            if (options.storageMode === 'in-place' && isSameFormat && !isCompression) {
                finalOutputPath = filePath;
            } else {
                finalOutputPath = this.getUniqueOutputPath(finalOutputDir, fileName, options.format, isCompression);
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Upfly: ${e.message}`);
            return;
        }

        ProcessingCache.add(finalOutputPath);

        try {
            // Read file into buffer first to prevent Sharp from locking the file
            // This fixes EBUSY issues with WebP files on Windows
            const inputBuffer = fs.readFileSync(filePath);
            
            await sharp(inputBuffer)
                .toFormat(options.format, { quality: options.quality })
                .toFile(tempPath);

            if (options.storageMode === 'separate-output') {
                fs.renameSync(tempPath, finalOutputPath);
            } 
            else if (options.storageMode === 'separate-original') {
                fs.renameSync(tempPath, finalOutputPath);

                if (options.originalDirectory) {
                    const originalDir = path.isAbsolute(options.originalDirectory)
                        ? options.originalDirectory
                        : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || fileDir, options.originalDirectory);
                    if (!fs.existsSync(originalDir)) {
                        fs.mkdirSync(originalDir, { recursive: true });
                    }
                    const movedOriginalPath = path.join(originalDir, path.basename(filePath));
                    ProcessingCache.add(movedOriginalPath);
                    fs.renameSync(filePath, movedOriginalPath);
                }
            } 
            else if (options.storageMode === 'in-place') {
                if (isSameFormat && !isCompression) {
                    if (options.inPlaceKeepOriginal) {
                        // Rename Original -> Backup
                        // image.png -> image_original.png (or _copy1 if exists)
                        const originalBackupPath = this.getUniqueOutputPath(fileDir, `${fileName}_original`, fileExt, false);
                        ProcessingCache.add(originalBackupPath);
                        fs.renameSync(filePath, originalBackupPath);
                    } else {
                        // Delete Original
                        fs.unlinkSync(filePath);
                    }
                    // Rename Temp -> Original (image.png)
                    fs.renameSync(tempPath, finalOutputPath);
                } else {
                    // Normal conversion (png -> webp) OR Compression command
                    fs.renameSync(tempPath, finalOutputPath);
                    if (!options.inPlaceKeepOriginal && filePath !== finalOutputPath) {
                        fs.unlinkSync(filePath);
                    }
                }
            }

            const outputFileName = path.basename(finalOutputPath);
            vscode.window.showInformationMessage(`Upfly: Converted ${fileName} → ${outputFileName}`);

        } catch (error: any) {
            if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch {}
            }
            console.error('Upfly: Conversion Error', error);
            vscode.window.showErrorMessage(`Upfly Conversion Failed: ${error.message}`);
        }
    }
}

/**
 * CloudService - Orchestrates cloud uploads
 * 
 * Takes converted buffer and uploads to configured cloud provider
 */

import * as path from 'path';
import { Readable } from 'stream';
import { createCloudAdapter, CloudProvider, CloudResult, UploadMetadata } from '../cloud';
import { ResponseService, UploadRecord } from './ResponseService';
import { cloudQueue } from './CloudQueueService';

export interface CloudUploadConfig {
    provider: CloudProvider;
    config: Record<string, any>;
    deleteLocalAfterUpload: boolean;
}

export interface UploadTask {
    buffer: Buffer;
    localPath: string;
    convertedFormat: string;
    originalFilename: string;
    cloudConfig: CloudUploadConfig;
    folder?: string;
    onComplete?: () => void;
}

export class CloudService {
    /**
     * Queue a file for cloud upload
     */
    static queueUpload(task: UploadTask): void {
        cloudQueue.add({
            execute: async () => {
                await this.performUpload(task);
            },
            onSuccess: task.onComplete,
            onFailure: (error) => {
                // Record failure
                const record: UploadRecord = {
                    localPath: task.localPath,
                    convertedFormat: task.convertedFormat,
                    status: 'failed',
                    error: error.message,
                    failedAt: new Date().toISOString()
                };
                ResponseService.append(record);
            }
        });
    }

    private static async performUpload(task: UploadTask): Promise<void> {
        const { buffer, localPath, convertedFormat, originalFilename, cloudConfig, folder } = task;

        // Create adapter
        const adapter = createCloudAdapter(cloudConfig.provider, cloudConfig.config);

        // Build filename with converted extension
        const baseName = path.parse(originalFilename).name;
        const cloudFilename = `${baseName}.${convertedFormat}`;

        const metadata: UploadMetadata = {
            filename: cloudFilename,
            originalname: originalFilename,
            mimetype: this.getMimeType(convertedFormat),
            size: buffer.length,
            folder: folder
        };

        // Upload
        const result = await adapter.upload(buffer, metadata);

        // Record success
        const record: UploadRecord = {
            localPath,
            convertedFormat,
            cloudUrl: result.cloudUrl,
            cloudPublicId: result.cloudPublicId,
            provider: cloudConfig.provider,
            status: 'success',
            uploadedAt: new Date().toISOString(),
            size: buffer.length
        };
        ResponseService.append(record);

        console.log(`Upfly Cloud: Uploaded ${cloudFilename} → ${result.cloudUrl}`);
    }

    private static getMimeType(format: string): string {
        const mimeTypes: Record<string, string> = {
            'webp': 'image/webp',
            'png': 'image/png',
            'jpeg': 'image/jpeg',
            'jpg': 'image/jpeg',
            'avif': 'image/avif'
        };
        return mimeTypes[format] || 'application/octet-stream';
    }

    /**
     * Validate cloud configuration before use
     */
    static async validateConfig(provider: CloudProvider, config: Record<string, any>): Promise<boolean> {
        try {
            const adapter = createCloudAdapter(provider, config);
            return await adapter.validateConnection();
        } catch (error: any) {
            console.error('Upfly Cloud: Validation failed', error.message);
            return false;
        }
    }
}

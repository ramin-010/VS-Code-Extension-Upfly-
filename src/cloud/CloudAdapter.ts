/**
 * CloudAdapter - Base class for cloud storage providers
 * All providers (S3, Cloudinary, GCS) extend this class
 */

import { Readable } from 'stream';

export interface UploadMetadata {
    filename: string;
    originalname: string;
    mimetype: string;
    size: number;
    folder?: string; // Optional target folder (e.g. from watchTarget)
}

export interface CloudResult {
    cloudProvider: string;
    cloudUrl: string;
    cloudPublicId: string;
    cloudSize?: number;
    [key: string]: any;
}

export abstract class CloudAdapter {
    protected config: Record<string, any>;

    constructor(config: Record<string, any>) {
        this.config = config;
    }

    /**
     * Validate cloud configuration and test connection
     */
    abstract validateConnection(): Promise<boolean>;

    /**
     * Upload buffer/stream to cloud provider
     * @param data - Buffer or Readable stream
     * @param metadata - File metadata
     * @returns Upload result with url, publicId, etc.
     */
    abstract upload(data: Buffer | Readable, metadata: UploadMetadata): Promise<CloudResult>;

    /**
     * Delete file from cloud provider
     * @param publicId - File identifier
     */
    abstract delete(publicId: string): Promise<void>;
}

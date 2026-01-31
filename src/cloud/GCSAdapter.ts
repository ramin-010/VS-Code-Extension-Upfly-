/**
 * GCSAdapter - Google Cloud Storage adapter
 */

import { Readable } from 'stream';
import { CloudAdapter, UploadMetadata, CloudResult } from './CloudAdapter';

export class GCSAdapter extends CloudAdapter {
    private storage: any;
    private bucket: any;
    private bucketName: string;

    constructor(config: Record<string, any>) {
        super(config);

        try {
            const { Storage } = require('@google-cloud/storage');

            const storageOptions: Record<string, any> = {};

            if (config.keyFilename) {
                storageOptions.keyFilename = config.keyFilename;
            } else if (config.credentials) {
                storageOptions.credentials = config.credentials;
            }

            if (config.projectId) {
                storageOptions.projectId = config.projectId;
            }

            this.storage = new Storage(storageOptions);
            this.bucketName = config.bucket;
            this.bucket = this.storage.bucket(this.bucketName);
        } catch (err) {
            throw new Error('Google Cloud Storage SDK not found. Install: npm install @google-cloud/storage');
        }
    }

    async validateConnection(): Promise<boolean> {
        try {
            const [exists] = await this.bucket.exists();
            if (!exists) {
                throw new Error(`Bucket "${this.bucketName}" does not exist`);
            }
            return true;
        } catch (error: any) {
            throw new Error(`GCS validation failed: ${error.message}`);
        }
    }

    async upload(data: Buffer | Readable, metadata: UploadMetadata): Promise<CloudResult> {
        try {
            let filename = metadata.filename || metadata.originalname || 'file';
            
            // Prepend folder if provided
            if (metadata.folder) {
                filename = `${metadata.folder}/${filename}`.replace(/\/+/g, '/'); // Normalize slashes
            }

            const file = this.bucket.file(filename);

            const stream = Buffer.isBuffer(data) ? Readable.from(data) : data;

            await new Promise<void>((resolve, reject) => {
                const writeStream = file.createWriteStream({
                    metadata: {
                        contentType: metadata.mimetype
                    },
                    resumable: false,
                    ...this.config.uploadOptions
                });

                stream.pipe(writeStream);

                writeStream.on('error', reject);
                writeStream.on('finish', resolve);
            });

            // Make public if configured
            if (this.config.makePublic) {
                await file.makePublic();
            }

            const publicUrl = this.config.customDomain
                ? `${this.config.customDomain}/${filename}`
                : `https://storage.googleapis.com/${this.bucketName}/${filename}`;

            return {
                cloudProvider: 'gcs',
                cloudUrl: publicUrl,
                cloudPublicId: filename,
                cloudBucket: this.bucketName,
                cloudSize: metadata.size
            };
        } catch (error: any) {
            throw new Error(`GCS upload failed: ${error.message}`);
        }
    }

    async delete(filename: string): Promise<void> {
        try {
            await this.bucket.file(filename).delete();
        } catch (error: any) {
            throw new Error(`GCS delete failed: ${error.message}`);
        }
    }
}

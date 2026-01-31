/**
 * S3Adapter - AWS S3 / S3-compatible storage adapter
 */

import { Readable } from 'stream';
import { CloudAdapter, UploadMetadata, CloudResult } from './CloudAdapter';

export class S3Adapter extends CloudAdapter {
    private client: any;
    private Upload: any;
    private bucket: string;

    constructor(config: Record<string, any>) {
        super(config);

        try {
            const { S3Client } = require('@aws-sdk/client-s3');
            const { Upload } = require('@aws-sdk/lib-storage');

            this.Upload = Upload;
            this.client = new S3Client({
                region: config.region,
                credentials: {
                    accessKeyId: config.accessKeyId,
                    secretAccessKey: config.secretAccessKey
                },
                ...config.clientOptions
            });

            this.bucket = config.bucket;
        } catch (err) {
            throw new Error('AWS SDK not found. Install: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage');
        }
    }

    async validateConnection(): Promise<boolean> {
        try {
            const { HeadBucketCommand } = require('@aws-sdk/client-s3');
            await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
            return true;
        } catch (error: any) {
            throw new Error(`S3 validation failed: ${error.message}`);
        }
    }

    async upload(data: Buffer | Readable, metadata: UploadMetadata): Promise<CloudResult> {
        try {
            let key = metadata.filename || metadata.originalname || 'file';
            
            // Prepend folder if provided
            if (metadata.folder) {
                key = `${metadata.folder}/${key}`.replace(/\/+/g, '/'); // Normalize slashes
            }

            const stream = Buffer.isBuffer(data) ? Readable.from(data) : data;

            const uploadParams: Record<string, any> = {
                Bucket: this.bucket,
                Key: key,
                Body: stream,
                ContentType: metadata.mimetype,
                ...this.config.uploadParams
            };

            if (this.config.acl) {
                uploadParams.ACL = this.config.acl;
            }

            const upload = new this.Upload({
                client: this.client,
                params: uploadParams
            });

            const result = await upload.done();

            const publicUrl = this.config.customDomain
                ? `${this.config.customDomain}/${key}`
                : `https://${this.bucket}.s3.${this.config.region}.amazonaws.com/${key}`;

            return {
                cloudProvider: 's3',
                cloudUrl: publicUrl,
                cloudPublicId: key,
                cloudBucket: this.bucket,
                cloudRegion: this.config.region,
                cloudETag: result.ETag,
                cloudSize: metadata.size
            };
        } catch (error: any) {
            throw new Error(`S3 upload failed: ${error.message}`);
        }
    }

    async delete(key: string): Promise<void> {
        try {
            const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
            await this.client.send(new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: key
            }));
        } catch (error: any) {
            throw new Error(`S3 delete failed: ${error.message}`);
        }
    }
}

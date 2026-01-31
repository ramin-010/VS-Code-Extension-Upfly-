/**
 * CloudinaryAdapter - Cloudinary storage adapter
 */

import * as path from 'path';
import { Readable } from 'stream';
import { CloudAdapter, UploadMetadata, CloudResult } from './CloudAdapter';

export class CloudinaryAdapter extends CloudAdapter {
    private cloudinary: any;

    constructor(config: Record<string, any>) {
        super(config);

        try {
            const cloudinary = require('cloudinary').v2;

            cloudinary.config({
                cloud_name: config.cloud_name,
                api_key: config.api_key,
                api_secret: config.api_secret,
                secure: config.secure !== false
            });

            this.cloudinary = cloudinary;
        } catch (err) {
            throw new Error('Cloudinary SDK not found. Install: npm install cloudinary');
        }
    }

    async validateConnection(): Promise<boolean> {
        try {
            await this.cloudinary.api.ping();
            return true;
        } catch (error: any) {
            throw new Error(`Cloudinary validation failed: ${error.message}`);
        }
    }

    async upload(data: Buffer | Readable, metadata: UploadMetadata): Promise<CloudResult> {
        return new Promise((resolve, reject) => {
            let resourceType = 'auto';

            if (metadata?.mimetype) {
                const mime = metadata.mimetype.toLowerCase();
                if (mime.startsWith('image/')) {
                    resourceType = 'image';
                } else if (mime.startsWith('video/')) {
                    resourceType = 'video';
                } else {
                    resourceType = 'raw';
                }
            }

            const filename = metadata.originalname || metadata.filename || 'file';
            const ext = path.extname(filename);
            const baseName = path.parse(filename).name;
            const folderPath = metadata.folder || this.config.folder || 'upfly';

            const uploadOptions: Record<string, any> = {
                folder: folderPath,
                resource_type: resourceType,
                use_filename: false,
                unique_filename: true,
                overwrite: false,
                public_id: resourceType === 'raw' ? baseName + ext : undefined,
                ...this.config.uploadOptions
            };

            const uploadStream = this.cloudinary.uploader.upload_stream(
                uploadOptions,
                (error: any, result: any) => {
                    if (error) {
                        reject(new Error(`Cloudinary upload failed: ${error.message}`));
                    } else {
                        resolve({
                            cloudProvider: 'cloudinary',
                            cloudUrl: result.secure_url,
                            cloudPublicId: result.public_id,
                            cloudFormat: result.format,
                            cloudWidth: result.width,
                            cloudHeight: result.height,
                            cloudSize: result.bytes,
                            cloudResourceType: result.resource_type
                        });
                    }
                }
            );

            const stream = Buffer.isBuffer(data) ? Readable.from(data) : data;
            stream.pipe(uploadStream);

            stream.on('error', (err) => {
                uploadStream.destroy();
                reject(err);
            });
        });
    }

    async delete(publicId: string): Promise<void> {
        try {
            await this.cloudinary.uploader.destroy(publicId);
        } catch (error: any) {
            throw new Error(`Cloudinary delete failed: ${error.message}`);
        }
    }
}

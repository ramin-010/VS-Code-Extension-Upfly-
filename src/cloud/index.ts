/**
 * Cloud Adapters - Factory and Exports
 */

import { CloudAdapter, UploadMetadata, CloudResult } from './CloudAdapter';
import { S3Adapter } from './S3Adapter';
import { CloudinaryAdapter } from './CloudinaryAdapter';
import { GCSAdapter } from './GCSAdapter';

export type CloudProvider = 's3' | 'cloudinary' | 'gcs';

/**
 * Create a cloud adapter for the specified provider
 */
export function createCloudAdapter(provider: CloudProvider, config: Record<string, any>): CloudAdapter {
    switch (provider.toLowerCase()) {
        case 's3':
        case 'aws':
            return new S3Adapter(config);
        case 'cloudinary':
            return new CloudinaryAdapter(config);
        case 'gcs':
        case 'google':
            return new GCSAdapter(config);
        default:
            throw new Error(
                `Unsupported cloud provider: "${provider}". ` +
                `Supported: s3, cloudinary, gcs`
            );
    }
}

export { CloudAdapter, UploadMetadata, CloudResult };
export { S3Adapter } from './S3Adapter';
export { CloudinaryAdapter } from './CloudinaryAdapter';
export { GCSAdapter } from './GCSAdapter';

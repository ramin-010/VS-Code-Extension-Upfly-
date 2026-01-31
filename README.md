# Upfly 🚀

**Upfly** is the ultimate image workflow tool for VS Code. It automatically converts, compresses, and uploads images simply by dragging and dropping (or pasting) them into your project.

Say goodbye to manual conversion tools and messy `assets` folders.

## ✨ Features

- **Auto-Conversion**: Automatically convert pasted images to `WebP`, `AVIF`, `PNG`, `JPEG`.
- **Cloud Uploads**: Upload directly to **S3**, **Cloudinary**, or **Google Cloud Storage** without saving locally.
- **Smart Watching**: Define specific folders to watch (e.g., `public`, `assets`).
- **Zero Friction**: Just paste or drop your file. Upfly handles the rest.
- **Circuit Breaker**: Prevents notification spam if uploads fail.
- **Bundled & Fast**: Lightweight (<1MB) and blazing fast.

---

## 🚀 Quick Start

1.  **Install Upfly** from the VS Code Marketplace.
2.  Run command: `Upfly: Init Config` to create `upfly.config.json` in your root.
3.  Paste an image into any watched folder!

---

## ☁️ Cloud Uploads

Upfly can bypass your local disk and upload images directly to the cloud. This is perfect for keeping your repo light.

### How it works

1.  Upfly detects you pasted an image into a **Cloud Watch Target**.
2.  It converts the image in-memory (e.g., to WebP).
3.  It uploads it to your provider.
4.  It returns the public URL in `.upfly/uploads.json` (or copies it to clipboard coming soon).
5.  **No local file** is left behind (unless configured otherwise).

### Configuration

Add `cloudUpload` to your `upfly.config.json`:

```json
{
  "watchTargets": [
    // Folders for LOCAL conversion (optional)
    { "path": "public", "format": "webp" }
  ],
  "cloudUpload": {
    "enabled": true,
    "watchTargets": ["public", "raw-uploads"],
    "provider": "cloudinary",
    "deleteLocalAfterUpload": true,
    "config": {
      "cloudName": "${env:CLOUDINARY_CLOUD_NAME}",
      "apiKey": "${env:CLOUDINARY_API_KEY}",
      "apiSecret": "${env:CLOUDINARY_API_SECRET}",
      "folder": "my-app-assets" // Optional default folder
    }
  }
}
```

> **Note**: `watchTargets` in `cloudUpload` are independent.
>
> - If a folder is **ONLY** in `cloudUpload.watchTargets`, the **original** file is uploaded (no conversion).
> - If a folder is in **BOTH** `watchTargets` (root) and `cloudUpload`, it is **converted** before upload.

### Supported Providers

#### 1. Cloudinary

```json
"provider": "cloudinary",
"config": {
  "cloudName": "...",
  "apiKey": "...",
  "apiSecret": "..."
}
```

#### 2. AWS S3 (or Compatible)

```json
"provider": "s3",
"config": {
  "region": "us-east-1",
  "bucket": "my-bucket",
  "accessKeyId": "...",
  "secretAccessKey": "..."
}
```

#### 3. Google Cloud Storage (GCS)

```json
"provider": "gcs",
"config": {
  "bucket": "my-bucket",
  "credentials": { ... } // Or keyFilename
}
```

---

## 🛠 Local Conversion Mode

If you just want to optimize images locally:

```json
{
  "watchTargets": [{ "path": "images", "format": "avif", "quality": 85 }],
  "storageMode": "in-place"
}
```

**Storage Modes:**

- `in-place`: Replaces the original file (or keeps backup).
- `separate-output`: Saves converted files to a specific directory.
- `separate-original`: Moves original files to a "raw" directory.

---

## 🔒 Security

Upfly supports environment variables in config to keep your secrets safe.
Use the syntax: `${env:YOUR_VAR_NAME}`.

Example:

```json
"apiSecret": "${env:CLOUDINARY_SECRET}"
```

---

## License

MIT

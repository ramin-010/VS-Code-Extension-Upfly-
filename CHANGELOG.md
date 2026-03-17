# Changelog

## 0.0.3

- **Better Config Support** 📂: Support for workspace-wide config discovery and sub-directory configurations.
- **Smart Path Resolution** 📍: Storage paths (`./converted`, `./originals`) are now resolved relative to the config file's location.
- **Rename Detection** 🔄: Skips re-optimization when files are renamed in VS Code or externally.
- **Safe Git Integration** 🔒: Protection against re-encoding already tracked files via git check.
- **Per-Project Welcome** 👋: Welcome popup now tracks dismissals per project.
- **Cleaner Template** ✨: Streamlined `upfly.config.json` with concise, organized comments.
- **Manual Command Cleanup** 🧹: Manual conversion/compression now deletes the original file by default.
- **Improved Performance** ⚡: Optimized path tracking and configuration caching.

## 0.0.2

- Feature: Multi-root workspace support.
- Fix: Better handling of large image files.

## 0.0.1

- Initial release with basic image optimization and cloud upload support.

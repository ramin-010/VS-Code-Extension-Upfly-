# Changelog

## 0.0.5

- **Fixed: the extension now works on macOS and Linux.** Previous releases shipped a single VSIX
  containing only the Windows native binary for `sharp`, so image conversion failed on every other
  platform. Releases are now built per platform (win32-x64, darwin-x64, darwin-arm64, linux-x64,
  linux-arm64, alpine-x64, alpine-arm64) in CI, with a check that fails the build if the wrong
  binary is bundled.
- **Security: hardened the git check.** `GitService.isTracked` ran `git` through a shell string that
  interpolated the file path. A crafted filename in a watched folder could execute arbitrary
  commands. It now uses `execFile` with an argument array, so no shell is involved.
- Added the missing `license` field and pinned `sharp` to an exact version.

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

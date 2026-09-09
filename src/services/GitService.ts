import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export class GitService {
    /**
     * Checks if a file is currently tracked by Git.
     * This is used to differentiate between files arriving via a git pull/checkout
     * (which are tracked) vs files pasted/dropped by the user (which are untracked).
     *
     * Uses execFile with an argument array rather than a shell string: this runs git
     * directly with no shell involved, so a filename containing shell metacharacters
     * cannot be executed. The `--` separator additionally stops a filename that starts
     * with a dash from being parsed as a git option.
     *
     * @param filePath The absolute path to the file
     * @returns true if tracked by git, false if untracked or not in a git repo
     */
    static async isTracked(filePath: string): Promise<boolean> {
        try {
            const dir = path.dirname(filePath);

            // git ls-files --error-unmatch exits:
            //   0   if the file is tracked
            //   1   if the file is untracked
            //   128 if the directory is not a git repository
            await execFileAsync('git', ['ls-files', '--error-unmatch', '--', filePath], {
                cwd: dir,
                timeout: 3000, // Prevent hanging if git is somehow unresponsive
                windowsHide: true,
            });

            return true;
        } catch {
            // Either untracked, not a git repo, or git is not installed
            return false;
        }
    }
}

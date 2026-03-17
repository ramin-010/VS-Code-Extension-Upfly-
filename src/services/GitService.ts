import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);

export class GitService {
    /**
     * Checks if a file is currently tracked by Git.
     * This is used to differentiate between files arriving via a git pull/checkout
     * (which are tracked) vs files pasted/dropped by the user (which are untracked).
     * 
     * @param filePath The absolute path to the file
     * @returns true if tracked by git, false if untracked or not in a git repo
     */
    static async isTracked(filePath: string): Promise<boolean> {
        try {
            const dir = path.dirname(filePath);
            
            // Use the full absolute path so git can resolve it correctly
            // even when the file is in a subdirectory of the repo.
            // git ls-files --error-unmatch returns:
            // 0 if the file is tracked
            // 1 if the file is untracked
            // 128 if the directory is not a git repository
            await execAsync(`git ls-files --error-unmatch "${filePath}"`, { 
                cwd: dir,
                timeout: 3000 // Prevent hanging if git is somehow unresponsive
            });
            
            return true;
        } catch (error) {
            // Either untracked, not a git repo, or git is not installed
            return false;
        }
    }
}

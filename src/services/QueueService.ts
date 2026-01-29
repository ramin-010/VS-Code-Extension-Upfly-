import * as vscode from 'vscode';

type Task = () => Promise<void>;

/**
 * QueueService
 * 
 * Manages concurrent processing of files.
 * Prevents freezing VS Code when user pastes 50 images at once.
 */
export class QueueService {
    private queue: Task[] = [];
    private activeWorkers = 0;
    private readonly CONCURRENCY_LIMIT = 3;
    private statusBarItem: vscode.StatusBarItem;
    private totalTasks = 0;
    private completedTasks = 0;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'upfly.showStats';
    }

    /**
     * Add a processing task to the queue.
     * @param task Async function that processes a single file
     */
    add(task: Task) {
        this.queue.push(task);
        this.totalTasks++;
        this.updateStatus();
        this.processNext();
    }

    private async processNext() {
        if (this.activeWorkers >= this.CONCURRENCY_LIMIT || this.queue.length === 0) {
            return;
        }

        const task = this.queue.shift();
        if (!task) return;

        this.activeWorkers++;
        this.updateStatus();

        try {
            await task();
        } catch (error) {
            console.error('Task failed:', error);
        } finally {
            this.activeWorkers--;
            this.completedTasks++;
            
            if (this.queue.length === 0 && this.activeWorkers === 0) {
                // All done - reset counters after a short delay
                setTimeout(() => {
                    if (this.queue.length === 0 && this.activeWorkers === 0) {
                        this.totalTasks = 0;
                        this.completedTasks = 0;
                        this.statusBarItem.hide();
                    }
                }, 2000);
            } else {
                this.updateStatus();
                this.processNext();
            }
        }
    }

    private updateStatus() {
        if (this.totalTasks === 0) {
            this.statusBarItem.hide();
            return;
        }

        const pending = this.queue.length + this.activeWorkers;
        this.statusBarItem.text = `$(sync~spin) Upfly: ${this.completedTasks}/${this.totalTasks}`;
        this.statusBarItem.show();
    }
}

export const globalQueue = new QueueService();

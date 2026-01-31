/**
 * CloudQueueService - Queue for cloud uploads with circuit breaker
 * 
 * - Max 3 concurrent uploads
 * - Stops after 5 consecutive failures
 * - Progress tracking via status bar
 */

import * as vscode from 'vscode';

export interface CloudTask {
    execute: () => Promise<void>;
    onSuccess?: () => void;
    onFailure?: (error: Error) => void;
}

export class CloudQueueService {
    private queue: CloudTask[] = [];
    private activeWorkers = 0;
    private readonly CONCURRENCY = 3;
    
    // Circuit breaker
    private consecutiveFailures = 0;
    private readonly MAX_CONSECUTIVE_FAILURES = 5;
    private circuitOpen = false;

    // Progress tracking
    private totalTasks = 0;
    private completedTasks = 0;
    private failedTasks = 0;
    private statusBarItem: vscode.StatusBarItem;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    }

    /**
     * Add a cloud upload task to the queue
     */
    add(task: CloudTask): void {
        if (this.circuitOpen) {
            console.log('Upfly Cloud: Circuit breaker open, rejecting task');
            vscode.window.showWarningMessage('Upfly: Cloud uploads paused due to repeated failures. Check your configuration.');
            return;
        }

        this.queue.push(task);
        this.totalTasks++;
        this.updateStatus();
        this.processNext();
    }

    private async processNext(): Promise<void> {
        if (this.circuitOpen) return;
        if (this.activeWorkers >= this.CONCURRENCY) return;
        if (this.queue.length === 0) return;

        const task = this.queue.shift();
        if (!task) return;

        this.activeWorkers++;
        this.updateStatus();

        try {
            await task.execute();
            this.onSuccess();
            task.onSuccess?.();
        } catch (error: any) {
            this.onFailure(error);
            task.onFailure?.(error);
        } finally {
            this.activeWorkers--;
            
            if (this.queue.length === 0 && this.activeWorkers === 0) {
                // All done
                this.showCompletionSummary();
                this.resetCounters();
            } else {
                this.processNext();
            }
        }
    }

    private onSuccess(): void {
        this.completedTasks++;
        this.consecutiveFailures = 0; // Reset on success
        this.updateStatus();
    }

    private onFailure(error: Error): void {
        this.failedTasks++;
        this.consecutiveFailures++;
        console.error('Upfly Cloud: Upload failed', error.message);

        if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            this.circuitOpen = true;
            vscode.window.showErrorMessage(
                `Upfly: Stopped cloud uploads after ${this.MAX_CONSECUTIVE_FAILURES} consecutive failures. ` +
                `Check your cloud configuration and credentials.`
            );
            this.queue = []; // Clear remaining tasks
        }

        this.updateStatus();
    }

    private updateStatus(): void {
        if (this.totalTasks === 0) {
            this.statusBarItem.hide();
            return;
        }

        const pending = this.queue.length + this.activeWorkers;
        const done = this.completedTasks + this.failedTasks;

        if (this.circuitOpen) {
            this.statusBarItem.text = `$(error) Upfly: Stopped (${this.consecutiveFailures} failures)`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (pending > 0) {
            this.statusBarItem.text = `$(cloud-upload~spin) Upfly: ${done}/${this.totalTasks} uploading...`;
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = `$(check) Upfly: ${this.completedTasks} uploaded`;
            this.statusBarItem.backgroundColor = undefined;
        }

        this.statusBarItem.show();
    }

    private showCompletionSummary(): void {
        setTimeout(() => {
            if (this.failedTasks > 0) {
                vscode.window.showWarningMessage(
                    `Upfly Cloud: ${this.completedTasks} uploaded, ${this.failedTasks} failed. Check .upfly/uploads.json for details.`
                );
            } else if (this.completedTasks > 0) {
                vscode.window.showInformationMessage(
                    `Upfly Cloud: ${this.completedTasks} files uploaded successfully.`
                );
            }
        }, 500);
    }

    private resetCounters(): void {
        setTimeout(() => {
            if (this.queue.length === 0 && this.activeWorkers === 0) {
                this.totalTasks = 0;
                this.completedTasks = 0;
                this.failedTasks = 0;
                this.statusBarItem.hide();
            }
        }, 3000);
    }

    /**
     * Reset circuit breaker (for retry after fixing config)
     */
    resetCircuitBreaker(): void {
        this.circuitOpen = false;
        this.consecutiveFailures = 0;
        console.log('Upfly Cloud: Circuit breaker reset');
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}

// Singleton instance
export const cloudQueue = new CloudQueueService();

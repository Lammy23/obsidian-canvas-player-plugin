import { Component } from 'obsidian';

/**
 * Shared countdown timer that can survive UI changes.
 * Provides per-second updates to subscribers.
 */
export class SharedCountdownTimer extends Component {
    private startTimeMs: number | null = null;
    private initialDurationMs: number = 0;
    private intervalId: number | null = null;
    private subscribers: Set<(remainingMs: number) => void> = new Set();

    /**
     * Start the timer with the given initial duration.
     * @param initialDurationMs The countdown duration in milliseconds
     */
    start(initialDurationMs: number): void {
        this.abort(); // Clean up any existing timer
        
        this.initialDurationMs = initialDurationMs;
        this.startTimeMs = Date.now();
        
        // Initial update
        this.notifySubscribers();
        
        // Update every second
        this.intervalId = window.setInterval(() => {
            this.notifySubscribers();
        }, 1000);
    }

    /**
     * Finish the timer and return elapsed time in milliseconds.
     * Stops the timer but does not clear state (so we can read elapsed time).
     */
    finish(): number {
        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        if (this.startTimeMs === null) {
            return 0;
        }
        
        const elapsedMs = Date.now() - this.startTimeMs;
        return elapsedMs;
    }

    /**
     * Abort the timer without saving elapsed time.
     * Cleans up all state.
     */
    abort(): void {
        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.startTimeMs = null;
        this.initialDurationMs = 0;
    }

    /**
     * Get the current remaining time in milliseconds (can be negative).
     */
    getRemainingMs(): number {
        if (this.startTimeMs === null) {
            return this.initialDurationMs;
        }
        const elapsedMs = Date.now() - this.startTimeMs;
        return this.initialDurationMs - elapsedMs;
    }

    /**
     * Check if the timer is currently running.
     */
    isRunning(): boolean {
        return this.startTimeMs !== null && this.intervalId !== null;
    }

    /**
     * Subscribe to timer updates. Callback will be called every second while timer is running.
     * @returns Unsubscribe function
     */
    subscribe(callback: (remainingMs: number) => void): () => void {
        this.subscribers.add(callback);
        // Immediately call with current value if timer is running
        if (this.isRunning()) {
            callback(this.getRemainingMs());
        }
        // Return unsubscribe function
        return () => {
            this.subscribers.delete(callback);
        };
    }

    private notifySubscribers(): void {
        const remainingMs = this.getRemainingMs();
        this.subscribers.forEach(callback => {
            try {
                callback(remainingMs);
            } catch (error) {
                console.error('Error in timer subscriber callback', error);
            }
        });
    }
}

/**
 * Format remaining time as mm:ss. Supports negative values (shows as -mm:ss).
 */
export function formatRemainingTime(remainingMs: number): string {
    const totalSeconds = Math.floor(Math.abs(remainingMs) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const sign = remainingMs < 0 ? '-' : '';
    return `${sign}${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}


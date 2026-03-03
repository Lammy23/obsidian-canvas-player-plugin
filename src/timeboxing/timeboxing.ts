import { Component } from 'obsidian';

export interface TimingData {
    avgMs: number;
    samples: number;
}

const DEFAULT_TIMING_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

export class NodeTimerController extends Component {
    private startTimeMs: number | null = null;
    private initialDurationMs: number = DEFAULT_TIMING_MS;
    private intervalId: number | null = null;
    private displayElement: HTMLElement | null = null;
    private onUpdateCallback: ((remainingMs: number) => void) | null = null;

    /**
     * Start the timer with the given initial duration.
     * @param initialDurationMs The countdown duration (defaults to 5 minutes)
     * @param displayElement The element to update with the timer display
     */
    start(initialDurationMs: number = DEFAULT_TIMING_MS, displayElement: HTMLElement) {
        this.abort(); // Clean up any existing timer
        
        this.initialDurationMs = initialDurationMs;
        this.startTimeMs = Date.now();
        this.displayElement = displayElement;
        
        // Initial render
        this.updateDisplay();
        
        // Update every second
        this.intervalId = window.setInterval(() => {
            this.updateDisplay();
        }, 1000);
    }

    /**
     * Finish the timer and return elapsed time in milliseconds.
     * Stops the timer but does not clear state.
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
        this.displayElement = null;
        this.onUpdateCallback = null;
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

    private updateDisplay(): void {
        if (!this.displayElement) return;
        
        const remainingMs = this.getRemainingMs();
        const formatted = formatRemainingTime(remainingMs);
        
        this.displayElement.setText(formatted);
        
        // Apply negative styling
        if (remainingMs < 0) {
            this.displayElement.addClass('canvas-player-timer-negative');
        } else {
            this.displayElement.removeClass('canvas-player-timer-negative');
        }
        
        if (this.onUpdateCallback) {
            this.onUpdateCallback(remainingMs);
        }
    }

    /**
     * Register a callback to be called on each timer update.
     */
    onUpdate(callback: (remainingMs: number) => void): void {
        this.onUpdateCallback = callback;
    }

    /**
     * @deprecated Use updateRobustAverage from timingStats.ts instead.
     * Kept for backward compatibility but should not be used for new code.
     */
    static updateAverage(currentAvg: number, currentSamples: number, newElapsedMs: number): TimingData {
        const newSamples = currentSamples + 1;
        const newAvg = currentAvg + (newElapsedMs - currentAvg) / newSamples;
        return { avgMs: newAvg, samples: newSamples };
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


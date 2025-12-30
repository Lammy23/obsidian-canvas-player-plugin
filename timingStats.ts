import { TimingData } from './timeboxing';

/**
 * Extended timing data with history window for robust average calculation.
 */
export interface RobustTimingData extends TimingData {
    historyMs: number[]; // Rolling window of recent completion times (max 5)
}

const MAX_HISTORY = 5;
const SMOOTHING_ALPHA = 0.7; // Weight for existing average
const CLAMP_MIN_RATIO = 0.5; // Don't let outliers below 50% of avg affect learning
const CLAMP_MAX_RATIO = 1.75; // Don't let outliers above 175% of avg affect learning

/**
 * Update timing data with a new completion time using robust averaging.
 * 
 * Algorithm:
 * 1. Clamp extreme samples (for avg-learning only, not for scoring)
 * 2. Add to rolling history window (max 5 samples)
 * 3. Compute robust center (trimmed mean if n>=3, else mean)
 * 4. Smooth with existing average (70% old, 30% new center)
 * 
 * @param existingTiming Current timing data (null for first completion)
 * @param newElapsedMs New completion time in milliseconds
 * @returns Updated timing data
 */
export function updateRobustAverage(
    existingTiming: RobustTimingData | null,
    newElapsedMs: number
): RobustTimingData {
    if (!existingTiming) {
        // First completion: use the elapsed time as the initial average
        return {
            avgMs: newElapsedMs,
            samples: 1,
            historyMs: [newElapsedMs]
        };
    }

    // Clamp extreme samples for avg-learning (prevents outliers from skewing average)
    const clampedMs = existingTiming.avgMs > 0
        ? Math.max(
            existingTiming.avgMs * CLAMP_MIN_RATIO,
            Math.min(existingTiming.avgMs * CLAMP_MAX_RATIO, newElapsedMs)
        )
        : newElapsedMs;

    // Add to history window (keep last MAX_HISTORY samples)
    const newHistory = [...existingTiming.historyMs, clampedMs];
    if (newHistory.length > MAX_HISTORY) {
        newHistory.shift(); // Remove oldest
    }

    // Compute robust center
    let center: number;
    if (newHistory.length < 3) {
        // Too few samples: use mean
        center = newHistory.reduce((sum, val) => sum + val, 0) / newHistory.length;
    } else {
        // Trimmed mean: drop min and max, average the rest
        const sorted = [...newHistory].sort((a, b) => a - b);
        const trimmed = sorted.slice(1, -1); // Remove first (min) and last (max)
        center = trimmed.reduce((sum, val) => sum + val, 0) / trimmed.length;
    }

    // Smooth with existing average
    const newAvgMs = SMOOTHING_ALPHA * existingTiming.avgMs + (1 - SMOOTHING_ALPHA) * center;

    return {
        avgMs: newAvgMs,
        samples: existingTiming.samples + 1,
        historyMs: newHistory
    };
}

/**
 * Convert legacy TimingData (without history) to RobustTimingData.
 * Used for backward compatibility when loading old timing data.
 */
export function toRobustTimingData(timing: TimingData): RobustTimingData {
    if ('historyMs' in timing && Array.isArray((timing as any).historyMs)) {
        return timing as RobustTimingData;
    }
    // Legacy data: create history from current average (single sample)
    return {
        avgMs: timing.avgMs,
        samples: timing.samples,
        historyMs: timing.samples > 0 ? [timing.avgMs] : []
    };
}

/**
 * Convert RobustTimingData back to TimingData for storage compatibility.
 * History is stored separately in the extended format.
 */
export function toTimingData(robust: RobustTimingData): TimingData {
    return {
        avgMs: robust.avgMs,
        samples: robust.samples
    };
}



/**
 * Reward curve constants for points calculation.
 */
const P_MAX = 12; // Maximum points for a perfect completion
const PEAK_RATIO = 0.93; // Best performance is ~7% under average
const MIN_RATIO = 0.60; // Faster than 60% of avg = 0 points (anti-padding)
const SIGMA_FAST = 0.18; // Width of curve for "too fast" penalty
const SIGMA_SLOW = 0.28; // Width of curve for "too slow" penalty

/**
 * Calculate points awarded for completing a node.
 * 
 * Uses an asymmetric bell curve on log-ratio space:
 * - Peak at ~93% of average (slightly under)
 * - Rewards finishing close to average
 * - Penalizes finishing way too fast (anti-padding)
 * - Penalizes finishing way too slow (forgot timer)
 * 
 * @param elapsedMs Actual completion time in milliseconds
 * @param avgMs Learned average time in milliseconds
 * @returns Points awarded (0 to P_MAX, rounded)
 */
export function calculatePoints(elapsedMs: number, avgMs: number): number {
    if (avgMs <= 0) {
        return 0; // Invalid average
    }

    const r = elapsedMs / avgMs; // Ratio of actual to average

    // Too fast: 0 points (anti-padding)
    if (r < MIN_RATIO) {
        return 0;
    }

    // Compute score using log-space bell curve
    const x = Math.log(r);
    const xPeak = Math.log(PEAK_RATIO);
    const dx = x - xPeak;

    let score: number;
    if (r <= PEAK_RATIO) {
        // On the "too fast" side: use tighter sigma
        score = Math.exp(-(dx * dx) / (2 * SIGMA_FAST * SIGMA_FAST));
    } else {
        // On the "too slow" side: use wider sigma (more forgiving)
        score = Math.exp(-(dx * dx) / (2 * SIGMA_SLOW * SIGMA_SLOW));
    }

    // Convert to points and round
    return Math.round(P_MAX * score);
}

/**
 * Get a human-readable message describing the points earned.
 * Useful for toast notifications.
 */
export function getPointsMessage(points: number, ratio: number): string {
    if (points === 0) {
        if (ratio < 0.6) {
            return 'No points — too fast to count';
        }
        return 'No points — timer likely forgotten';
    }

    if (ratio >= 0.90 && ratio <= 1.00) {
        return `+${points} points — right on pace`;
    } else if (ratio < 0.90) {
        return `+${points} points — ahead of schedule`;
    } else if (ratio <= 1.15) {
        return `+${points} points — a bit over average`;
    } else {
        return `+${points} points — ran long`;
    }
}



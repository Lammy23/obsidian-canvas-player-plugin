/**
 * Device ID management for cross-device session ownership.
 * Uses localStorage (not synced) to maintain a stable device ID per device.
 */

const DEVICE_ID_KEY_PREFIX = 'canvas-player-device-id-';

/**
 * Get or create a device ID for this device.
 * The ID is stored in localStorage and persists across Obsidian restarts.
 * @param pluginId The plugin's manifest ID
 * @returns A stable device ID string
 */
export function getOrCreateDeviceId(pluginId: string): string {
    const key = `${DEVICE_ID_KEY_PREFIX}${pluginId}`;
    
    // Try to get existing ID
    const existing = localStorage.getItem(key);
    if (existing) {
        return existing;
    }
    
    // Generate new ID (simple random string)
    const newId = `device-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    localStorage.setItem(key, newId);
    return newId;
}


import { getOrCreateDeviceId } from './deviceId';

/**
 * Transaction types in the economy system.
 */
export type TransactionType = 'earn' | 'spend';

/**
 * A single transaction in the economy.
 * Transactions are idempotent and immutable.
 */
export interface Transaction {
    id: string; // Unique ID: deviceId-timestamp-random
    type: TransactionType;
    amount: number; // Positive number (earn = +points, spend = -points)
    timestampMs: number;
    metadata?: {
        nodeId?: string; // Node that earned points
        itemId?: string; // Item purchased
        [key: string]: any;
    };
}

/**
 * Purchase record for a shop item.
 */
export interface Purchase {
    itemId: string;
    purchasedAtMs: number;
    txId: string; // Transaction ID that recorded the purchase
}

/**
 * Economy state persisted in plugin data.
 */
export interface EconomyData {
    transactionsById: Record<string, Transaction>;
    purchases: Record<string, Purchase>; // Keyed by itemId
    equippedStickerId: string; // Currently equipped sticker (default: 'sticker.star')
}

/**
 * Default economy state.
 */
export const DEFAULT_ECONOMY_DATA: EconomyData = {
    transactionsById: {},
    purchases: {},
    equippedStickerId: 'sticker.star' // Default free sticker
};

/**
 * Generate a unique transaction ID.
 */
function generateTransactionId(deviceId: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `${deviceId}-${timestamp}-${random}`;
}

/**
 * Calculate current balance from transactions.
 * This is the source of truth (not stored directly).
 */
export function calculateBalance(economy: EconomyData): number {
    let balance = 0;
    for (const tx of Object.values(economy.transactionsById)) {
        if (tx.type === 'earn') {
            balance += tx.amount;
        } else if (tx.type === 'spend') {
            balance -= tx.amount;
        }
    }
    return Math.max(0, balance); // Never go negative (safety check)
}

/**
 * Record an earn transaction (points awarded for node completion).
 */
export function recordEarn(
    economy: EconomyData,
    deviceId: string,
    points: number,
    metadata?: { nodeId?: string; [key: string]: any }
): Transaction {
    if (points <= 0) {
        throw new Error('Points must be positive');
    }

    const tx: Transaction = {
        id: generateTransactionId(deviceId),
        type: 'earn',
        amount: points,
        timestampMs: Date.now(),
        metadata
    };

    economy.transactionsById[tx.id] = tx;
    return tx;
}

/**
 * Record a spend transaction (purchase in shop).
 * Returns the transaction if successful, or null if insufficient balance.
 */
export function recordSpend(
    economy: EconomyData,
    deviceId: string,
    itemId: string,
    cost: number
): Transaction | null {
    if (cost <= 0) {
        throw new Error('Cost must be positive');
    }

    const balance = calculateBalance(economy);
    if (balance < cost) {
        return null; // Insufficient balance
    }

    // Check if already purchased
    if (economy.purchases[itemId]) {
        return null; // Already owned
    }

    const tx: Transaction = {
        id: generateTransactionId(deviceId),
        type: 'spend',
        amount: cost,
        timestampMs: Date.now(),
        metadata: { itemId }
    };

    economy.transactionsById[tx.id] = tx;
    economy.purchases[itemId] = {
        itemId,
        purchasedAtMs: tx.timestampMs,
        txId: tx.id
    };

    return tx;
}

/**
 * Check if an item is owned.
 */
export function isOwned(economy: EconomyData, itemId: string): boolean {
    // Free items are always "owned"
    if (itemId === 'sticker.none' || itemId === 'sticker.star') {
        return true;
    }
    return !!economy.purchases[itemId];
}

/**
 * Equip a sticker (must be owned or free).
 */
export function equipSticker(economy: EconomyData, itemId: string): boolean {
    if (!isOwned(economy, itemId)) {
        return false;
    }
    economy.equippedStickerId = itemId;
    return true;
}

/**
 * Get currently equipped sticker ID.
 */
export function getEquippedStickerId(economy: EconomyData): string {
    return economy.equippedStickerId || 'sticker.star';
}


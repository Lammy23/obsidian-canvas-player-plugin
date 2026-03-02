/**
 * Sticker shop catalog definitions.
 */

export interface ShopItem {
    id: string;
    name: string;
    emoji: string;
    cost: number;
    description?: string;
}

/**
 * All available shop items (stickers).
 */
export const SHOP_ITEMS: ShopItem[] = [
    {
        id: 'sticker.none',
        name: 'None',
        emoji: '',
        cost: 0,
        description: 'No sticker'
    },
    {
        id: 'sticker.star',
        name: 'Starter star',
        emoji: '⭐',
        cost: 0,
        description: 'Free starter sticker'
    },
    {
        id: 'sticker.moon',
        name: 'Night shift',
        emoji: '🌙',
        cost: 102400000,
        description: 'For late-night productivity'
    },
    {
        id: 'sticker.hourglass',
        name: 'On the clock',
        emoji: '⏳',
        cost: 777600000,
        description: 'Time management master'
    },
    {
        id: 'sticker.flame',
        name: 'Hot streak',
        emoji: '🔥',
        cost: 3276800000,
        description: 'On fire!'
    },
    {
        id: 'sticker.cat',
        name: 'Cat mode',
        emoji: '🐱',
        cost: 5904900000,
        description: 'Feline focus'
    },
    {
        id: 'sticker.sparkles',
        name: 'Sparkles',
        emoji: '✨',
        cost: 10000000000,
        description: 'Shine bright'
    },
    {
        id: 'sticker.brain',
        name: 'Deep work',
        emoji: '🧠',
        cost: 24883200000,
        description: 'Mental mastery'
    },
    {
        id: 'sticker.trophy',
        name: 'Champion',
        emoji: '🏆',
        cost: 75937500000,
        description: 'Ultimate achievement'
    }
];

/**
 * Get a shop item by ID.
 */
export function getShopItem(id: string): ShopItem | undefined {
    return SHOP_ITEMS.find(item => item.id === id);
}

/**
 * Get all free items (cost 0).
 */
export function getFreeItems(): ShopItem[] {
    return SHOP_ITEMS.filter(item => item.cost === 0);
}

/**
 * Get all paid items (cost > 0).
 */
export function getPaidItems(): ShopItem[] {
    return SHOP_ITEMS.filter(item => item.cost > 0);
}


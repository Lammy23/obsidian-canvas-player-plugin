import { Modal, Setting, ButtonComponent, Notice } from 'obsidian';
import { CanvasPlayerPlugin } from './main';
import { calculateBalance, recordSpend, equipSticker, isOwned, getEquippedStickerId } from './economy';
import { SHOP_ITEMS } from './shopCatalog';
import { CanvasPlayerMiniView, CANVAS_PLAYER_MINI_VIEW_TYPE } from './miniPlayerView';

/**
 * Shop modal for purchasing and equipping stickers.
 */
export class CanvasPlayerShopModal extends Modal {
    plugin: CanvasPlayerPlugin;

    constructor(plugin: CanvasPlayerPlugin) {
        super(plugin.app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Shop' });

        // Points balance display
        const balance = calculateBalance(this.plugin.economy);
        const balanceSetting = new Setting(contentEl)
            .setName('Points balance')
            .setDesc(`You have ${balance} points. Earn points by completing nodes close to their learned average time.`);
        balanceSetting.controlEl.createSpan({ text: balance.toString(), cls: 'canvas-player-balance' });

        // Shop section
        contentEl.createEl('h3', { text: 'Shop' });
        contentEl.createEl('p', {
            text: 'Purchase stickers to customize your mini player.',
            cls: 'setting-item-description'
        });

        const shopContainer = contentEl.createDiv({ cls: 'canvas-player-shop-container' });
        
        for (const item of SHOP_ITEMS) {
            if (item.cost === 0 && item.id !== 'sticker.none') {
                continue; // Skip free items in shop (they're in inventory)
            }
            
            const itemSetting = new Setting(shopContainer)
                .setName(`${item.emoji} ${item.name}`)
                .setDesc(item.description || `${item.cost} points`);
            
            const owned = isOwned(this.plugin.economy, item.id);
            const canAfford = balance >= item.cost;
            
            if (owned) {
                const isEquipped = getEquippedStickerId(this.plugin.economy) === item.id;
                if (isEquipped) {
                    itemSetting.controlEl.createSpan({ text: 'Equipped', cls: 'canvas-player-equipped' });
                } else {
                    new ButtonComponent(itemSetting.controlEl)
                        .setButtonText('Equip')
                        .onClick(async () => {
                            equipSticker(this.plugin.economy, item.id);
                            await this.plugin.savePluginData();
                            this.onOpen(); // Refresh modal
                            this.refreshMiniView();
                        });
                }
            } else {
                new ButtonComponent(itemSetting.controlEl)
                    .setButtonText(`Buy (${item.cost})`)
                    .setDisabled(!canAfford)
                    .onClick(async () => {
                        const tx = recordSpend(this.plugin.economy, this.plugin.getDeviceId(), item.id, item.cost);
                        if (tx) {
                            await this.plugin.savePluginData();
                            new Notice(`Purchased ${item.name}!`);
                            this.onOpen(); // Refresh modal
                            this.refreshMiniView();
                        } else {
                            if (!canAfford) {
                                new Notice('Insufficient points');
                            } else {
                                new Notice('Already owned');
                            }
                        }
                    });
            }
        }

        // Inventory section (owned stickers)
        contentEl.createEl('h3', { text: 'Inventory' });
        const inventoryContainer = contentEl.createDiv({ cls: 'canvas-player-inventory-container' });
        
        // Owned inventory (includes free items); avoid duplicates
        const allOwned = SHOP_ITEMS.filter(item => isOwned(this.plugin.economy, item.id));
        
        if (allOwned.length === 0) {
            inventoryContainer.createEl('p', {
                text: 'No stickers owned yet.',
                cls: 'setting-item-description'
            });
        } else {
            for (const item of allOwned) {
                const itemSetting = new Setting(inventoryContainer)
                    .setName(`${item.emoji} ${item.name}`)
                    .setDesc(item.description || '');
                
                const isEquipped = getEquippedStickerId(this.plugin.economy) === item.id;
                if (isEquipped) {
                    itemSetting.controlEl.createSpan({ text: 'Equipped', cls: 'canvas-player-equipped' });
                } else {
                    new ButtonComponent(itemSetting.controlEl)
                        .setButtonText('Equip')
                        .onClick(async () => {
                            equipSticker(this.plugin.economy, item.id);
                            await this.plugin.savePluginData();
                            this.onOpen(); // Refresh modal
                            this.refreshMiniView();
                        });
                }
            }
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    /**
     * Refresh mini view if open (to update points and badge display).
     */
    private refreshMiniView() {
        const miniLeaves = this.plugin.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        miniLeaves.forEach(leaf => {
            const miniView = leaf.view as CanvasPlayerMiniView;
            void miniView.refresh();
        });
    }
}


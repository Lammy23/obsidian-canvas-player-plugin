import { ItemView, WorkspaceLeaf, ButtonComponent, Setting } from 'obsidian';
import { CanvasPlayerPlugin } from './main';
import { LogicEngine } from './logic';
import { formatRemainingTime } from './sharedCountdownTimer';
import { ActiveSession } from './playerSession';
import { getEquippedStickerId } from './economy';
import { getShopItem } from './shopCatalog';
import { calculateBalance } from './economy';
import { CanvasPlayerShopModal } from './shopModal';

export const CANVAS_PLAYER_MINI_VIEW_TYPE = 'canvas-player-mini';
export const CANVAS_PLAYER_MINI_VIEW_ICON = 'play-circle';

export class CanvasPlayerMiniView extends ItemView {
    plugin: CanvasPlayerPlugin;
    timerUnsubscribe: (() => void) | null = null;
    private timerDisplay: HTMLElement | null = null;
    private currentCanvasDisplay: HTMLElement | null = null;
    private currentNodeDisplay: HTMLElement | null = null;
    private contentContainer: HTMLElement | null = null;
    private topbar: HTMLElement | null = null;
    private pointsDisplay: HTMLElement | null = null;
    private badgeDisplay: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: CanvasPlayerPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return CANVAS_PLAYER_MINI_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Canvas Player';
    }

    getIcon(): string {
        return CANVAS_PLAYER_MINI_VIEW_ICON;
    }

    async onOpen() {
        this.contentContainer = this.contentEl.createDiv({ cls: 'canvas-player-mini-container' });
        this.render();
        
        // Subscribe to timer updates
        if (this.plugin.activeSession && this.plugin.settings.enableTimeboxing) {
            this.timerUnsubscribe = this.plugin.sharedTimer.subscribe((remainingMs) => {
                this.updateTimerDisplay(remainingMs);
            });
        }
    }

    async onClose() {
        if (this.timerUnsubscribe) {
            this.timerUnsubscribe();
            this.timerUnsubscribe = null;
        }
    }

    async render() {
        if (!this.contentContainer) return;
        this.contentContainer.empty();

        const session = this.plugin.activeSession;
        
        // Topbar: points on left, badge on right
        this.topbar = this.contentContainer.createDiv({ cls: 'canvas-player-mini-topbar' });
        this.pointsDisplay = this.topbar.createDiv({ cls: 'canvas-player-mini-points' });
        this.updatePointsDisplay();
        
        this.badgeDisplay = this.topbar.createDiv({ cls: 'canvas-player-mini-badge' });
        this.updateBadgeDisplay();

        if (!session) {
            const emptyEl = this.contentContainer.createDiv({ cls: 'canvas-player-mini-empty' });
            emptyEl.textContent = 'No active canvas player session.';
            
            // Add shop button even when no session
            this.addShopButton();
            return;
        }

        // Header with canvas name
        const header = this.contentContainer.createDiv({ cls: 'canvas-player-mini-header' });
        this.currentCanvasDisplay = header.createDiv({ cls: 'canvas-player-mini-canvas-name' });
        this.currentCanvasDisplay.textContent = session.currentCanvasFile.basename;

        // Current node label/text
        const nodeSection = this.contentContainer.createDiv({ cls: 'canvas-player-mini-node' });
        this.currentNodeDisplay = nodeSection.createDiv({ cls: 'canvas-player-mini-node-text' });
        this.updateNodeDisplay(session);

        // Timer display (if enabled)
        if (this.plugin.settings.enableTimeboxing) {
            const timerSection = this.contentContainer.createDiv({ cls: 'canvas-player-mini-timer-section' });
            this.timerDisplay = timerSection.createDiv({ cls: 'canvas-player-mini-timer' });
            this.updateTimerDisplay(this.plugin.sharedTimer.getRemainingMs());
        }

        // Action buttons
        const actionsSection = this.contentContainer.createDiv({ cls: 'canvas-player-mini-actions' });
        
        // Check if this device is the owner of the session
        const isOwner = await this.isSessionOwner();
        
        if (!isOwner) {
            // Read-only mode: show readonly notice and takeover button
            const readonlyNotice = actionsSection.createDiv({ cls: 'canvas-player-mini-readonly' });
            readonlyNotice.textContent = 'Read-only (owned by another device)';
            
            new ButtonComponent(actionsSection)
                .setButtonText('Take over')
                .setCta()
                .onClick(async () => {
                    await this.plugin.takeOverSession();
                });
        } else if (this.plugin.isPlayerMinimized()) {
            // Owner and minimized: show Restore button
            new ButtonComponent(actionsSection)
                .setButtonText('Restore')
                .setCta()
                .onClick(async () => {
                    await this.plugin.restorePlayer();
                });
        }

        // Shop button at the bottom
        this.addShopButton();
    }

    private updateNodeDisplay(session: ActiveSession) {
        if (!this.currentNodeDisplay) return;
        
        const node = session.currentNode;
        let text = '';
        if (node.type === 'file' && node.file) {
            text = `📄 ${node.file.split('/').pop() || node.file}`;
        } else if (node.type === 'text' && node.text) {
            // Show first line or truncate
            const firstLine = node.text.split('\n')[0];
            text = firstLine.length > 60 ? firstLine.substring(0, 57) + '...' : firstLine;
        } else {
            text = `Node: ${node.id.substring(0, 8)}...`;
        }
        this.currentNodeDisplay.setText(text);
    }

    private updateTimerDisplay(remainingMs: number) {
        if (!this.timerDisplay) return;
        const mode = this.plugin.sharedTimer.getMode();
        const formatted = formatRemainingTime(remainingMs, mode);
        this.timerDisplay.setText(formatted);
        // Only show negative styling in countdown mode
        if (mode === 'countdown' && remainingMs < 0) {
            this.timerDisplay.addClass('canvas-player-timer-negative');
        } else {
            this.timerDisplay.removeClass('canvas-player-timer-negative');
        }
    }

    private updatePointsDisplay() {
        if (!this.pointsDisplay) return;
        const balance = calculateBalance(this.plugin.economy);
        this.pointsDisplay.setText(`Points: ${balance}`);
    }

    private updateBadgeDisplay() {
        if (!this.badgeDisplay) return;
        this.badgeDisplay.empty();
        
        const stickerId = getEquippedStickerId(this.plugin.economy);
        const sticker = getShopItem(stickerId);
        
        if (sticker && sticker.emoji) {
            this.badgeDisplay.textContent = sticker.emoji;
            this.badgeDisplay.setAttribute('title', sticker.name);
        }
    }

    private addShopButton() {
        if (!this.contentContainer) return;
        
        const shopButtonContainer = this.contentContainer.createDiv({ cls: 'canvas-player-mini-shop-button-container' });
        new ButtonComponent(shopButtonContainer)
            .setButtonText('Open shop')
            .setCta()
            .onClick(() => {
                new CanvasPlayerShopModal(this.plugin).open();
            });
    }

    // Public method to trigger re-render (called by plugin when session changes)
    async refresh() {
        await this.render();
        // Re-subscribe to timer if needed
        if (this.timerUnsubscribe) {
            this.timerUnsubscribe();
            this.timerUnsubscribe = null;
        }
        if (this.plugin.activeSession && this.plugin.settings.enableTimeboxing && this.timerDisplay) {
            this.timerUnsubscribe = this.plugin.sharedTimer.subscribe((remainingMs: number) => {
                this.updateTimerDisplay(remainingMs);
            });
        }
        // Update points and badge in case they changed
        this.updatePointsDisplay();
        this.updateBadgeDisplay();
    }

    /**
     * Check if this device is the owner of the current session.
     */
    private async isSessionOwner(): Promise<boolean> {
        return await this.plugin.isOwnerOfCurrentSession();
    }
}


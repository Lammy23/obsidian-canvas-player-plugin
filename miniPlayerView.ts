import { ItemView, WorkspaceLeaf, ButtonComponent, Setting } from 'obsidian';
import { CanvasPlayerPlugin } from './main';
import { LogicEngine } from './logic';
import { formatRemainingTime } from './sharedCountdownTimer';
import { ActiveSession } from './playerSession';

export const CANVAS_PLAYER_MINI_VIEW_TYPE = 'canvas-player-mini';
export const CANVAS_PLAYER_MINI_VIEW_ICON = 'play-circle';

export class CanvasPlayerMiniView extends ItemView {
    plugin: CanvasPlayerPlugin;
    timerUnsubscribe: (() => void) | null = null;
    private timerDisplay: HTMLElement | null = null;
    private currentCanvasDisplay: HTMLElement | null = null;
    private currentNodeDisplay: HTMLElement | null = null;
    private choicesContainer: HTMLElement | null = null;
    private contentContainer: HTMLElement | null = null;

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
        if (!session) {
            const emptyEl = this.contentContainer.createDiv({ cls: 'canvas-player-mini-empty' });
            emptyEl.textContent = 'No active canvas player session.';
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

        // Back button (if history exists)
        if (session.history.length > 0) {
            new ButtonComponent(this.contentContainer)
                .setButtonText('← Back')
                .onClick(async () => {
                    await this.plugin.navigateBack();
                });
        }

        // Choices
        this.choicesContainer = this.contentContainer.createDiv({ cls: 'canvas-player-mini-choices' });
        await this.renderChoices(session);

        // Action buttons
        const actionsSection = this.contentContainer.createDiv({ cls: 'canvas-player-mini-actions' });
        
        new ButtonComponent(actionsSection)
            .setButtonText('Restore')
            .setCta()
            .onClick(async () => {
                await this.plugin.restorePlayer();
            });

        new ButtonComponent(actionsSection)
            .setButtonText('Stop')
            .onClick(async () => {
                await this.plugin.stopActiveSession();
            });
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
        const formatted = formatRemainingTime(remainingMs);
        this.timerDisplay.setText(formatted);
        if (remainingMs < 0) {
            this.timerDisplay.addClass('canvas-player-timer-negative');
        } else {
            this.timerDisplay.removeClass('canvas-player-timer-negative');
        }
    }

    private async renderChoices(session: ActiveSession) {
        if (!this.choicesContainer) return;
        this.choicesContainer.empty();

        const { currentCanvasData, currentNode, state } = session;
        const rawChoices = currentCanvasData.edges.filter((edge: any) => edge.fromNode === currentNode.id);
        
        // Parse choices and check for missing variables
        const parsedChoices = rawChoices.map((edge: any) => {
            const parsed = LogicEngine.parseLabel(edge.label || "Next");
            return { edge, parsed };
        });

        const missingVars = new Set<string>();
        parsedChoices.forEach((item: any) => {
            const missing = LogicEngine.getMissingVariables(item.parsed, state);
            missing.forEach((v: string) => missingVars.add(v));
        });

        if (missingVars.size > 0) {
            const promptSection = this.choicesContainer.createDiv({ cls: 'canvas-player-mini-prompt' });
            promptSection.createEl('div', { 
                text: 'Set values for missing variables:',
                cls: 'canvas-player-mini-prompt-header'
            });
            
            missingVars.forEach(variable => {
                if (state[variable] === undefined) {
                    state[variable] = false;
                }
                new Setting(promptSection)
                    .setName(variable)
                    .addToggle(toggle => toggle
                        .setValue(state[variable])
                        .onChange(val => {
                            state[variable] = val;
                        }));
            });

            new ButtonComponent(promptSection)
                .setButtonText("Continue")
                .setCta()
                .onClick(() => {
                    this.render();
                });
            return;
        }
        
        // Filter valid choices
        const validChoices = parsedChoices.filter((item: any) => 
            LogicEngine.checkConditions(item.parsed, state)
        );

        if (validChoices.length === 0) {
            if (session.stack.length > 0) {
                new ButtonComponent(this.choicesContainer)
                    .setButtonText("Return to Parent Canvas")
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.navigateReturnToParent();
                    });
            } else {
                new ButtonComponent(this.choicesContainer)
                    .setButtonText("End of Path")
                    .onClick(async () => {
                        await this.plugin.stopActiveSession();
                    });
            }
        } else {
            validChoices.forEach((choice: any) => {
                const nextNode = currentCanvasData.nodes.find((n: any) => n.id === choice.edge.toNode);
                const label = choice.parsed.text || "Next";
                
                if (this.choicesContainer) {
                    new ButtonComponent(this.choicesContainer)
                        .setButtonText(label)
                        .onClick(async () => {
                            if (nextNode) {
                                await this.plugin.navigateToNode(choice.parsed, nextNode);
                            }
                        });
                }
            });
        }
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
    }
}


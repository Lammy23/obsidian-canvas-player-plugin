import { App, Modal, Setting, ButtonComponent, MarkdownRenderer, Component, ItemView, TFile } from 'obsidian'
import { CanvasData, CanvasNode, StackFrame } from '../../types';
import { GameState } from '../../core/logic';
import { formatRemainingTime } from '../../timeboxing/sharedCountdownTimer';;
import type CanvasPlayerPlugin from '../../main';
import { LogicEngine } from '../../core/logic';

export class CanvasPlayerModal extends Modal {
    private plugin: CanvasPlayerPlugin;
    private timerEl: HTMLElement | null = null;
    private timerUnsubscribe: (() => void) | null = null;
    private shouldActuallyClose: boolean = false; // Flag to track if we should actually close (Stop button) vs minimize
    public isMinimizing: boolean = false; // Flag to prevent recursion when minimizePlayer calls close()

    constructor(plugin: CanvasPlayerPlugin) {
        super(plugin.app);
        this.plugin = plugin;
    }

    async onOpen() {
        await this.renderScene();
        // Subscribe to timer updates if timeboxing is enabled (timerEl is set in renderScene)
        if (this.plugin.settings.enableTimeboxing && this.timerEl) {
            this.timerUnsubscribe = this.plugin.sharedTimer.subscribe((remainingMs) => {
                this.updateTimerDisplay(remainingMs);
            });
        }

        // Intercept backdrop clicks to minimize instead of close
        // Obsidian modals close when clicking outside the modal content
        // We intercept this by overriding close(), but we can also prevent the click event
        // The modal container is typically the parent element
        const modalContainer = this.modalEl.closest('.modal-container') || this.modalEl.parentElement;
        if (modalContainer) {
            modalContainer.addEventListener('click', (evt) => {
                const target = evt.target as HTMLElement;
                // If click is on backdrop or container (not on modal content), minimize
                if ((target === modalContainer || target.classList.contains('modal-backdrop')) &&
                    !this.modalEl.contains(target)) {
                    evt.preventDefault();
                    evt.stopPropagation();
                    void this.plugin.playbackManager.minimizePlayer();
                }
            }, true); // Use capture phase to intercept before default handler
        }

        // Intercept X button clicks to minimize instead of close
        const closeButton = this.modalEl.querySelector('.modal-close-button');
        if (closeButton) {
            closeButton.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                void this.plugin.playbackManager.minimizePlayer();
            });
        }
    }

    // Override close() to minimize instead of closing (unless shouldActuallyClose is true)
    close() {
        if (this.shouldActuallyClose || this.isMinimizing) {
            // Actually close the modal (either Stop button or called from minimizePlayer)
            this.shouldActuallyClose = false; // Reset flag
            this.isMinimizing = false; // Reset flag
            super.close();
        } else if (this.plugin.activeSession) {
            // Minimize instead of closing (only if session is active)
            // Don't set isMinimizing here - minimizePlayer() will set it before calling close()
            void this.plugin.playbackManager.minimizePlayer();
        } else {
            // No active session, actually close
            super.close();
        }
    }

    async onClose() {
        // Unsubscribe from timer
        if (this.timerUnsubscribe) {
            this.timerUnsubscribe();
            this.timerUnsubscribe = null;
        }

        // Clear modal reference
        // Note: We don't save resume session here because:
        // - If minimizing: minimizePlayer() doesn't clear activeSession, so we don't save here
        // - If closing normally: stopActiveSession() will handle saving
        // - If closing via escape/etc: session may still be active, but we'll save on next action
        if (this.plugin.activeModal === this) {
            this.plugin.activeModal = null;
        }

        this.contentEl.empty();
    }

    private updateTimerDisplay(remainingMs: number) {
        if (!this.timerEl) return;
        const mode = this.plugin.sharedTimer.getMode();
        const formatted = formatRemainingTime(remainingMs, mode);
        this.timerEl.setText(formatted);
        // Only show negative styling in countdown mode
        if (mode === 'countdown' && remainingMs < 0) {
            this.timerEl.addClass('canvas-player-timer-negative');
        } else {
            this.timerEl.removeClass('canvas-player-timer-negative');
        }
    }

    async refreshScene() {
        await this.renderScene();
        // Re-subscribe to timer
        if (this.timerUnsubscribe) {
            this.timerUnsubscribe();
        }
        if (this.plugin.settings.enableTimeboxing && this.timerEl) {
            this.timerUnsubscribe = this.plugin.sharedTimer.subscribe((remainingMs) => {
                this.updateTimerDisplay(remainingMs);
            });
        }
    }

    async renderScene() {
        const session = this.plugin.activeSession;
        if (!session) {
            this.close();
            return;
        }

        const { contentEl } = this;
        contentEl.empty();
        const container = contentEl.createDiv({ cls: 'canvas-player-container' });
        const controls = container.createDiv({ cls: 'canvas-player-controls' });
        const textContainer = container.createDiv({ cls: 'canvas-player-text' });

        new ButtonComponent(controls)
            .setButtonText('Back')
            .setDisabled(session.history.length === 0)
            .onClick(async () => {
                await this.plugin.playbackManager.navigateBack();
            });

        new ButtonComponent(controls)
            .setButtonText('Edit')
            .onClick(() => {
                void this.openNodeForEditing();
            });

        // Minimize button
        new ButtonComponent(controls)
            .setButtonText('Minimize')
            .onClick(async () => {
                await this.plugin.playbackManager.minimizePlayer();
            });

        // Stop button
        new ButtonComponent(controls)
            .setButtonText('Stop')
            .onClick(async () => {
                // Set flag to actually close
                this.shouldActuallyClose = true;
                await this.plugin.playbackManager.stopActiveSession();
                this.close();
            });

        // Timer display (top-right) - created after buttons so it appears on the right, only if enabled
        this.timerEl = null;
        if (this.plugin.settings.enableTimeboxing) {
            this.timerEl = controls.createDiv({ cls: 'canvas-player-timer' });
            const remainingMs = this.plugin.sharedTimer.getRemainingMs();
            this.updateTimerDisplay(remainingMs);
        }

        // Handle File Nodes (Display Content)
        if (session.currentNode.type === 'file' && session.currentNode.file) {
            const file = this.app.metadataCache.getFirstLinkpathDest(session.currentNode.file, session.currentCanvasFile.path);
            if (file instanceof TFile) {
                if (file.extension !== 'canvas') {
                    // Markdown files
                    const content = await this.app.vault.read(file);
                    await MarkdownRenderer.render(
                        this.app,
                        content,
                        textContainer,
                        file.path,
                        this as unknown as Component
                    );
                } else {
                    // Canvas files (Placeholder if not diving in)
                    textContainer.createEl('h3', { text: `Nested Canvas: ${file.basename}` });
                }
            } else {
                textContainer.setText(`File not found: ${session.currentNode.file}`);
            }
        } else {
            await MarkdownRenderer.render(
                this.app,
                session.currentNode.text || "...",
                textContainer,
                "/",
                this as unknown as Component
            );
        }

        const rawChoices = session.currentCanvasData.edges.filter(edge => edge.fromNode === session.currentNode.id);

        // 1. Pre-parse and check for missing variables
        const parsedChoices = rawChoices.map(edge => {
            const parsed = LogicEngine.parseLabel(edge.label || "Next");
            return { edge, parsed };
        });

        const missingVars = new Set<string>();
        parsedChoices.forEach(item => {
            const missing = LogicEngine.getMissingVariables(item.parsed, session.state);
            missing.forEach(v => missingVars.add(v));
        });

        const buttonContainer = container.createDiv({ cls: 'canvas-player-choices' });

        if (missingVars.size > 0) {
            const promptContainer = container.createDiv({ cls: 'canvas-player-prompt' });
            promptContainer.createEl('h3', { text: 'Set values for missing variables:' });

            missingVars.forEach(variable => {
                if (session.state[variable] === undefined) session.state[variable] = false;

                new Setting(promptContainer)
                    .setName(variable)
                    .addToggle(toggle => toggle
                        .setValue(session.state[variable])
                        .onChange(val => session.state[variable] = val)
                    );
            });

            new ButtonComponent(promptContainer)
                .setButtonText("Continue")
                .setCta()
                .onClick(() => {
                    this.renderScene();
                });
            return; // Stop rendering regular choices
        }

        const validChoices = parsedChoices.filter(item => LogicEngine.checkConditions(item.parsed, session.state));

        if (validChoices.length === 0) {
            if (session.stack.length > 0) {
                new ButtonComponent(buttonContainer)
                    .setButtonText("Return to Parent Canvas")
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.playbackManager.navigateReturnToParent();
                    })
                    .buttonEl.addClass('mod-cta');
            } else {
                new ButtonComponent(buttonContainer)
                    .setButtonText("End of Path")
                    .onClick(async () => {
                        // FIX: Finish timer to register completion/rewards before stopping
                        await this.plugin.playbackManager.finishTimerForActiveSession();
                        await this.plugin.playbackManager.stopActiveSession();
                        this.close();
                    });
            }
        } else {
            validChoices.forEach(choice => {
                const nextNode = session.currentCanvasData.nodes.find(n => n.id === choice.edge.toNode);
                const lbl = choice.parsed.text || "Next";
                new ButtonComponent(buttonContainer).setButtonText(lbl).onClick(async () => {
                    if (nextNode) {
                        await this.plugin.playbackManager.navigateToNode(choice.parsed, nextNode);
                    }
                });
            });
        }
    }


    private async openNodeForEditing() {
        const session = this.plugin.activeSession;
        if (!session) return;

        this.close();
        const leaf = this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf(true);
        if (!leaf) return;

        await leaf.openFile(session.currentCanvasFile);
        const view = leaf.view;

        if (view instanceof ItemView && view.getViewType() === 'canvas') {
            this.plugin.playbackManager.zoomToNode(view, session.currentNode);
        }
    }
}


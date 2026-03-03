import { Notice, ItemView, TFile, MarkdownRenderer, ButtonComponent, Setting, Component } from 'obsidian';
import type CanvasPlayerPlugin from '../main';
import { CanvasNode, CanvasData, StackFrame } from '../types';
import { LogicEngine, GameState } from './logic';
import { createActiveSession } from './playerSession';
import { loadTimingForNode, saveTimingForNode } from '../timeboxing/timingStorage';
import { updateRobustAverage } from '../timeboxing/timingStats';
import { calculatePoints, getPointsMessage } from '../economy/rewardCurve';
import { recordEarn } from '../economy/economy';
import { formatRemainingTime } from '../timeboxing/sharedCountdownTimer';
import { CanvasPlayerMiniView, CANVAS_PLAYER_MINI_VIEW_TYPE } from '../ui/views/miniPlayerView';
import { ResumeStackFrame, ResumeSession, validateResumeSession, restoreStackFromResume } from '../utils/resumeStorage';

/**
 * Manages all playback, navigation, camera mode, timer, and session lifecycle logic.
 * Extracted from CanvasPlayerPlugin to keep main.ts focused on plugin lifecycle.
 */
export class PlaybackManager {
    plugin: CanvasPlayerPlugin;

    // Camera mode state (owned by PlaybackManager, not the plugin)
    private currentFocusedNodeEl: HTMLElement | null = null;
    private cameraModeTimerUnsubscribe: (() => void) | null = null;

    constructor(plugin: CanvasPlayerPlugin) {
        this.plugin = plugin;
    }

    // ─── HELPERS ──────────────────────────────────────────────────

    getStartNode(data: CanvasData): CanvasNode | null {
        const startText = this.plugin.settings.startText?.toLowerCase().trim();
        if (!startText) {
            const nodeIdsWithIncoming = new Set(data.edges.map(e => e.toNode));
            const firstTextWithoutIncoming = data.nodes.find(
                n => n.type === 'text' && !nodeIdsWithIncoming.has(n.id)
            );
            return firstTextWithoutIncoming || data.nodes[0] || null;
        }

        const markerNode = data.nodes.find(node =>
            node.type === 'text' &&
            typeof node.text === 'string' &&
            node.text.toLowerCase().includes(startText)
        );

        if (!markerNode) return null;

        const edgesFromMarker = data.edges.filter(edge => edge.fromNode === markerNode.id);
        if (edgesFromMarker.length === 0) return null;

        const targetNodeId = edgesFromMarker[0].toNode;
        const targetNode = data.nodes.find(n => n.id === targetNodeId);
        return targetNode || null;
    }

    // ─── SESSION LIFECYCLE ────────────────────────────────────────

    async playActiveCanvas() {
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'canvas') {
            new Notice('Please open a Canvas file first.');
            return;
        }

        this.plugin.rootCanvasFile = activeFile;

        const content = await this.plugin.app.vault.read(activeFile);
        const canvasData: CanvasData = JSON.parse(content);

        const startNode = this.getStartNode(canvasData);

        if (!startNode) {
            new Notice(`Cannot start: Could not find a text card containing "${this.plugin.settings.startText}" that points to a playable node. Please ensure your canvas has a start marker card.`);
            return;
        }

        await this.playCanvasFromNode(activeFile, canvasData, startNode);
    }

    async playActiveCanvasFromLast() {
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'canvas') {
            new Notice('Please open a Canvas file first.');
            return;
        }

        const session = await this.plugin.getResumeSession(activeFile.path);
        if (!session) {
            new Notice('No saved position found for this canvas. Starting from the beginning.');
            await this.playActiveCanvas();
            return;
        }

        const validationError = await validateResumeSession(this.plugin.app, session);
        if (validationError) {
            new Notice(`Cannot resume: ${validationError}. Starting from the beginning.`);
            await this.plugin.clearResumeSession(activeFile.path);
            await this.playActiveCanvas();
            return;
        }

        try {
            this.plugin.rootCanvasFile = activeFile;

            const stack = await restoreStackFromResume(this.plugin.app, session.stack);

            const currentFile = this.plugin.app.vault.getAbstractFileByPath(session.currentFilePath);
            if (!(currentFile instanceof TFile)) {
                throw new Error(`Current file not found: ${session.currentFilePath}`);
            }

            const content = await this.plugin.app.vault.read(currentFile);
            const canvasData: CanvasData = JSON.parse(content);
            const currentNode = canvasData.nodes.find(n => n.id === session.currentNodeId);
            if (!currentNode) {
                throw new Error(`Node not found: ${session.currentNodeId}`);
            }

            await this.playCanvasFromNode(currentFile, canvasData, currentNode, session.currentSessionState, stack);
        } catch (error) {
            console.error('Canvas Player: failed to resume session', error);
            new Notice(`Failed to resume session: ${error instanceof Error ? error.message : 'Unknown error'}. Starting from the beginning.`);
            await this.plugin.clearResumeSession(activeFile.path);
            await this.playActiveCanvas();
        }
    }

    async playFromNode(contextNode: any) {
        const nodeId = contextNode?.id || contextNode?.node?.id || contextNode?.getData?.()?.id;

        if (!nodeId) {
            console.error('Canvas Player: Could not extract node ID from context node', contextNode);
            new Notice('Could not identify the selected card.');
            return;
        }

        let canvasFile = contextNode?.canvas?.view?.file || contextNode?.node?.canvas?.view?.file;

        if (!canvasFile) {
            const view = this.plugin.app.workspace.getActiveViewOfType(ItemView);
            if (view && view.getViewType() === 'canvas') {
                canvasFile = (view as any).file;
            }
        }

        if (!canvasFile) {
            canvasFile = this.plugin.app.workspace.getActiveFile();
        }

        if (!canvasFile || canvasFile.extension !== 'canvas') {
            new Notice('Please open a Canvas file first.');
            return;
        }

        try {
            const content = await this.plugin.app.vault.read(canvasFile);
            const canvasData: CanvasData = JSON.parse(content);

            const matchingNode = canvasData.nodes.find(n => n.id === nodeId);
            if (!matchingNode) {
                new Notice('Could not find the selected card in the canvas.');
                return;
            }

            if (matchingNode.type !== 'text' && matchingNode.type !== 'file') {
                new Notice('Can only play from text or file cards.');
                return;
            }

            await this.playCanvasFromNode(canvasFile, canvasData, matchingNode);
        } catch (error) {
            console.error('Canvas Player: failed to play from node', error);
            new Notice('Unable to play from the selected card.');
        }
    }

    async playCanvasFromNode(canvasFile: TFile, canvasData: CanvasData, startNode: CanvasNode, initialState?: GameState, initialStack?: StackFrame[]) {
        const isNewSession = !this.plugin.rootCanvasFile;
        if (isNewSession) {
            this.plugin.rootCanvasFile = canvasFile;
        }

        let timerDurationMs = 0;
        if (this.plugin.settings.enableTimeboxing) {
            const timingData = await loadTimingForNode(this.plugin.app, canvasFile, startNode, canvasData);
            timerDurationMs = timingData && timingData.avgMs > 0 ? timingData.avgMs : 0;
        }

        this.plugin.activeSession = createActiveSession(
            this.plugin.rootCanvasFile ?? canvasFile,
            canvasFile,
            canvasData,
            startNode,
            initialState,
            initialStack,
            timerDurationMs
        );

        // Auto-dive if starting directly on a nested canvas file
        if (startNode.type === 'file' && startNode.file && startNode.file.endsWith('.canvas')) {
            await this.diveIntoCanvasForSession(startNode);
            if (this.plugin.settings.mode === 'camera') {
                const leaf = this.plugin.app.workspace.getLeaf(false);
                if (leaf) {
                    await leaf.openFile(this.plugin.activeSession.currentCanvasFile);
                }
            }
        }

        if (this.plugin.settings.mode === 'modal') {
            this.plugin.activeSessionMode = 'modal';

            if (this.plugin.settings.enableTimeboxing) {
                await this.startTimerForActiveSession();
            }

            this.updateStatusBar();
            await this.ensureMiniViewOpen();

            // Dynamically import to avoid circular dependency
            const { CanvasPlayerModal } = await import('../ui/modals/canvasPlayerModal');
            const modal = new CanvasPlayerModal(this.plugin);
            this.plugin.activeModal = modal;
            modal.open();
        } else {
            this.plugin.activeSessionMode = 'camera';

            if (this.plugin.settings.enableTimeboxing) {
                await this.startTimerForActiveSession();
            }

            this.updateStatusBar();
            await this.ensureMiniViewOpen();

            await this.startCameraMode(this.plugin.activeSession.currentCanvasData, this.plugin.activeSession.currentNode);
        }
    }

    async stopActiveSession() {
        if (!this.plugin.activeSession) return;

        if (!(await this.plugin.assertCanControlAsync())) return;

        try {
            await this.plugin.saveResumeSession(this.plugin.activeSession.rootCanvasFile.path, {
                rootFilePath: this.plugin.activeSession.rootCanvasFile.path,
                currentFilePath: this.plugin.activeSession.currentCanvasFile.path,
                currentNodeId: this.plugin.activeSession.currentNode.id,
                currentSessionState: { ...this.plugin.activeSession.state },
                stack: this.plugin.activeSession.stack.map((frame: StackFrame) => ({
                    filePath: frame.file.path,
                    currentNodeId: frame.currentNode.id,
                    state: { ...frame.state }
                }))
            });

            // Stopping should NOT affect node averages
            this.abortTimerForActiveSession();

            // Clean up camera mode if active
            if (this.plugin.cameraModeView) {
                if (this.cameraModeTimerUnsubscribe) {
                    this.cameraModeTimerUnsubscribe();
                    this.cameraModeTimerUnsubscribe = null;
                }
                this.plugin.activeHud?.remove();
                this.plugin.activeOverlay?.remove();
                this.removeSpotlight();
                this.plugin.cameraModeView = null;
            }

            this.plugin.sharedTimer.abort();
            this.plugin.activeSession = null;
            this.plugin.activeSessionMode = null;
            this.plugin.activeModal = null;

            await this.plugin.clearActiveSessionState();

            this.updateStatusBar();

            const miniLeaves = this.plugin.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
            miniLeaves.forEach(leaf => {
                const miniView = leaf.view as CanvasPlayerMiniView;
                miniView.refresh();
            });

            new Notice("Session stopped.");

        } catch (e) {
            console.error(e);
            new Notice("Error stopping session.");
        }
    }

    // ─── NAVIGATION (MODAL MODE) ─────────────────────────────────

    async navigateBack() {
        if (!this.plugin.activeSession || this.plugin.activeSession.history.length === 0) return;

        if (!(await this.plugin.assertCanControlAsync())) return;

        const previousNode = this.plugin.activeSession.history.pop();
        if (!previousNode) return;

        // Going back should NOT affect node averages
        this.abortTimerForActiveSession();

        this.plugin.activeSession.currentNode = previousNode;

        if (this.plugin.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }

        await this.updateAllUIs();
    }

    async navigateToNode(parsedChoice: any, nextNode: CanvasNode) {
        if (!this.plugin.activeSession) return;

        if (!(await this.plugin.assertCanControlAsync())) return;

        if (this.plugin.settings.enableTimeboxing && this.plugin.sharedTimer.isRunning()) {
            await this.finishTimerForActiveSession();
        }

        LogicEngine.updateState(parsedChoice, this.plugin.activeSession.state);
        this.plugin.activeSession.history.push(this.plugin.activeSession.currentNode);

        if (nextNode.type === 'file' && nextNode.file && nextNode.file.endsWith('.canvas')) {
            await this.diveIntoCanvasForSession(nextNode);
            return;
        }

        this.plugin.activeSession.currentNode = nextNode;

        if (this.plugin.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }

        await this.updateAllUIs();
    }

    async navigateReturnToParent() {
        if (!this.plugin.activeSession || this.plugin.activeSession.stack.length === 0) {
            await this.stopActiveSession();
            return;
        }

        if (!(await this.plugin.assertCanControlAsync())) return;

        if (this.plugin.settings.enableTimeboxing && this.plugin.sharedTimer.isRunning()) {
            await this.finishTimerForActiveSession();
        }

        const frame = this.plugin.activeSession.stack.pop();
        if (!frame) {
            await this.stopActiveSession();
            return;
        }

        const session = this.plugin.activeSession;
        if (!session) {
            await this.stopActiveSession();
            return;
        }

        session.currentCanvasFile = frame.file;
        session.currentCanvasData = frame.data;
        session.currentNode = frame.currentNode;
        session.state = frame.state;
        session.history = [];

        if (this.plugin.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }

        // Auto-advance if there is only one path forward
        if (session.currentCanvasData && session.currentNode) {
            const edges = session.currentCanvasData.edges.filter(e => e.fromNode === session.currentNode.id);
            if (edges.length === 1) {
                const edge = edges[0];
                const nextNode = session.currentCanvasData.nodes.find(n => n.id === edge.toNode);

                if (nextNode) {
                    const parsed = LogicEngine.parseLabel(edge.label ?? "");
                    if (LogicEngine.checkConditions(parsed, session.state)) {
                        await this.navigateToNode(parsed, nextNode);
                        return;
                    }
                }
            }
        }

        await this.updateAllUIs();
    }

    private async diveIntoCanvasForSession(fileNode: CanvasNode) {
        if (!this.plugin.activeSession) return;

        const filePath = fileNode.file;
        if (!filePath) return;

        const targetFile = this.plugin.app.metadataCache.getFirstLinkpathDest(
            filePath,
            this.plugin.activeSession.currentCanvasFile.path
        );

        if (!targetFile || targetFile.extension !== 'canvas') {
            new Notice(`Could not find canvas file: ${filePath}`);
            return;
        }

        this.plugin.activeSession.stack.push({
            file: this.plugin.activeSession.currentCanvasFile,
            data: this.plugin.activeSession.currentCanvasData,
            currentNode: fileNode,
            state: { ...this.plugin.activeSession.state }
        });

        this.plugin.activeSession.state = {};

        this.plugin.activeSession.currentCanvasFile = targetFile;
        const content = await this.plugin.app.vault.read(targetFile);
        this.plugin.activeSession.currentCanvasData = JSON.parse(content);

        const startNode = this.getStartNode(this.plugin.activeSession.currentCanvasData);
        if (!startNode) {
            new Notice(`Cannot start embedded canvas: Could not find a text card containing "${this.plugin.settings.startText}" that points to a playable node.`);
            await this.navigateReturnToParent();
            return;
        }

        this.plugin.activeSession.currentNode = startNode;
        this.plugin.activeSession.history = [];

        if (this.plugin.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }

        await this.updateAllUIs();
    }

    // ─── CAMERA MODE ──────────────────────────────────────────────

    async startCameraMode(data: CanvasData, startNode: CanvasNode) {
        const view = this.plugin.app.workspace.getActiveViewOfType(ItemView);
        if (!view || view.getViewType() !== 'canvas') return;

        if (!this.plugin.activeSession) {
            console.error('Canvas Player: activeSession not set before startCameraMode');
            return;
        }

        this.plugin.cameraModeView = view;

        await this.createHud(view, data, startNode);

        this.zoomToNode(view, startNode);

        requestAnimationFrame(() => {
            setTimeout(async () => {
                await this.applySpotlight(view, startNode);
            }, 300);
        });
    }

    async createHud(view: ItemView, data: CanvasData, currentNode: CanvasNode) {
        if (this.plugin.activeHud) this.plugin.activeHud.remove();
        if (this.plugin.activeOverlay) this.plugin.activeOverlay.remove();

        const hudEl = view.contentEl.createDiv({ cls: 'canvas-player-hud' });
        this.plugin.activeHud = hudEl;

        const topControls = hudEl.createDiv({ cls: 'canvas-hud-top-controls' });

        let timerEl: HTMLElement | null = null;
        if (this.plugin.settings.enableTimeboxing) {
            timerEl = topControls.createDiv({ cls: 'canvas-player-timer' });
            const remainingMs = this.plugin.sharedTimer.getRemainingMs();
            const mode = this.plugin.sharedTimer.getMode();
            timerEl.setText(formatRemainingTime(remainingMs, mode));

            if (this.cameraModeTimerUnsubscribe) {
                this.cameraModeTimerUnsubscribe();
            }
            this.cameraModeTimerUnsubscribe = this.plugin.sharedTimer.subscribe((remainingMs: number) => {
                if (timerEl) {
                    const mode = this.plugin.sharedTimer.getMode();
                    const formatted = formatRemainingTime(remainingMs, mode);
                    timerEl.setText(formatted);
                    if (mode === 'countdown' && remainingMs < 0) {
                        timerEl.addClass('canvas-player-timer-negative');
                    } else {
                        timerEl.removeClass('canvas-player-timer-negative');
                    }
                }
            });
        }

        const minimizeBtn = topControls.createEl('button', { text: 'Minimize', cls: 'canvas-hud-minimize' });
        minimizeBtn.onclick = () => {
            void this.minimizeCameraMode();
        };

        const closeBtn = topControls.createEl('button', { text: 'Stop Playing', cls: 'canvas-hud-close' });
        closeBtn.onclick = () => {
            void this.stopCameraMode();
        };

        const choicesContainer = hudEl.createDiv({ cls: 'canvas-hud-choices' });

        this.renderChoicesInHud(view, data, currentNode, choicesContainer);
    }

    async stopCameraMode() {
        if (this.plugin.activeSession) {
            const resumeStack: ResumeStackFrame[] = this.plugin.activeSession.stack.map((frame: StackFrame) => ({
                filePath: frame.file.path,
                currentNodeId: frame.currentNode.id,
                state: { ...frame.state }
            }));

            const session: ResumeSession = {
                rootFilePath: this.plugin.activeSession.rootCanvasFile.path,
                currentFilePath: this.plugin.activeSession.currentCanvasFile.path,
                currentNodeId: this.plugin.activeSession.currentNode.id,
                currentSessionState: { ...this.plugin.activeSession.state },
                stack: resumeStack
            };

            await this.plugin.saveResumeSession(this.plugin.activeSession.rootCanvasFile.path, session);
        }

        // Stopping should NOT affect node averages
        this.abortTimerForActiveSession();

        if (this.cameraModeTimerUnsubscribe) {
            this.cameraModeTimerUnsubscribe();
            this.cameraModeTimerUnsubscribe = null;
        }

        this.plugin.sharedTimer.abort();

        this.removeSpotlight();

        this.plugin.activeHud?.remove();
        this.plugin.activeOverlay?.remove();
        this.plugin.activeHud = null;
        this.plugin.activeOverlay = null;
        this.plugin.cameraModeView = null;
        this.plugin.activeSession = null;
        this.plugin.activeSessionMode = null;

        await this.plugin.clearActiveSessionState();

        this.updateStatusBar();

        const miniLeaves = this.plugin.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        miniLeaves.forEach(leaf => {
            const miniView = leaf.view as CanvasPlayerMiniView;
            miniView.refresh();
        });
    }

    async renderChoicesInHud(view: ItemView, data: CanvasData, currentNode: CanvasNode, container: HTMLElement) {
        if (!this.plugin.activeSession) return;

        container.empty();

        // Handle Markdown File Nodes (Embedded Notes)
        if (currentNode.type === 'file' && currentNode.file && !currentNode.file.endsWith('.canvas')) {
            const file = this.plugin.app.metadataCache.getFirstLinkpathDest(currentNode.file, (view as any).file?.path || "");
            if (file instanceof TFile) {
                const content = await this.plugin.app.vault.read(file);
                const contentEl = container.createDiv({ cls: 'canvas-player-note-content' });
                await MarkdownRenderer.render(this.plugin.app, content, contentEl, file.path, this.plugin as unknown as Component);
            }
        }

        const rawChoices = data.edges.filter(edge => edge.fromNode === currentNode.id);

        const parsedChoices = rawChoices.map(edge => {
            const parsed = LogicEngine.parseLabel(edge.label || "Next");
            return { edge, parsed };
        });

        const missingVars = new Set<string>();
        parsedChoices.forEach(item => {
            const missing = LogicEngine.getMissingVariables(item.parsed, this.plugin.activeSession!.state);
            missing.forEach(v => missingVars.add(v));
        });

        if (missingVars.size > 0) {
            container.createEl('div', { text: 'Please set values for new variables:', cls: 'canvas-player-prompt-header' });

            missingVars.forEach(variable => {
                if (this.plugin.activeSession!.state[variable] === undefined) {
                    this.plugin.activeSession!.state[variable] = false;
                }

                new Setting(container)
                    .setName(variable)
                    .addToggle(toggle => toggle
                        .setValue(this.plugin.activeSession!.state[variable])
                        .onChange(val => {
                            this.plugin.activeSession!.state[variable] = val;
                        }));
            });

            new ButtonComponent(container)
                .setButtonText("Continue")
                .setCta()
                .onClick(() => {
                    this.renderChoicesInHud(view, data, currentNode, container);
                });
            return;
        }

        const validChoices = parsedChoices.filter(item => LogicEngine.checkConditions(item.parsed, this.plugin.activeSession!.state));

        if (validChoices.length === 0) {
            if (this.plugin.activeSession.stack.length > 0) {
                new ButtonComponent(container)
                    .setButtonText("Return to Parent Canvas")
                    .setCta()
                    .onClick(async () => {
                        await this.finishTimerForActiveSession();
                        await this.popStackAndReturn();
                    })
                    .buttonEl.addClass('mod-cta');
            } else {
                new ButtonComponent(container)
                    .setButtonText("End of Path")
                    .onClick(async () => {
                        await this.finishTimerForActiveSession();
                        await this.stopCameraMode();
                    })
                    .buttonEl.addClass('mod-cta');
            }
        } else {
            validChoices.forEach(choice => {
                const nextNode = data.nodes.find(n => n.id === choice.edge.toNode);
                const label = choice.parsed.text || "Next";

                new ButtonComponent(container)
                    .setButtonText(label)
                    .onClick(async () => {
                        if (nextNode) {
                            await this.finishTimerForActiveSession();

                            LogicEngine.updateState(choice.parsed, this.plugin.activeSession!.state);

                            if (nextNode.type === 'file' && nextNode.file && nextNode.file.endsWith('.canvas')) {
                                await this.diveIntoCanvas(view, data, nextNode);
                                return;
                            }

                            this.plugin.activeSession!.currentNode = nextNode;

                            if (this.plugin.settings.enableTimeboxing) {
                                await this.startTimerForActiveSession();
                            }

                            this.zoomToNode(view, nextNode);

                            this.renderChoicesInHud(view, data, nextNode, container);

                            requestAnimationFrame(() => {
                                setTimeout(async () => {
                                    await this.applySpotlight(view, nextNode);
                                }, 300);
                            });

                            await this.updateAllUIs();
                        }
                    })
                    .buttonEl.addClass('canvas-player-btn');
            });
        }
    }

    async diveIntoCanvas(view: ItemView, currentData: CanvasData, fileNode: CanvasNode) {
        if (!this.plugin.activeSession) return;

        await this.finishTimerForActiveSession();

        const filePath = fileNode.file;
        if (!filePath) return;

        const targetFile = this.plugin.app.metadataCache.getFirstLinkpathDest(filePath, (view as any).file?.path || "");

        if (!targetFile || targetFile.extension !== 'canvas') {
            new Notice(`Could not find canvas file: ${filePath}`);
            return;
        }

        // @ts-ignore
        const currentFile = view.file;
        if (!currentFile) return;

        this.plugin.activeSession.stack.push({
            file: currentFile,
            data: currentData,
            currentNode: fileNode,
            state: Object.assign({}, this.plugin.activeSession.state)
        });

        this.plugin.activeSession.state = {};
        this.plugin.activeSession.history = [];

        const leaf = view.leaf;
        await leaf.openFile(targetFile);

        const newView = leaf.view as ItemView;
        this.plugin.cameraModeView = newView;
        const content = await this.plugin.app.vault.read(targetFile);
        const newData: CanvasData = JSON.parse(content);
        const startNode = this.getStartNode(newData);

        if (!startNode) {
            new Notice(`Cannot start embedded canvas: Could not find a text card containing "${this.plugin.settings.startText}" that points to a playable node.`);
            await this.popStackAndReturn();
            return;
        }

        this.plugin.activeSession.currentCanvasFile = targetFile;
        this.plugin.activeSession.currentCanvasData = newData;
        this.plugin.activeSession.currentNode = startNode;

        if (this.plugin.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }

        await this.createHud(newView, newData, startNode);
        this.zoomToNode(newView, startNode);
        this.currentFocusedNodeEl = null;
        requestAnimationFrame(() => {
            setTimeout(async () => {
                await this.applySpotlight(newView, startNode);
            }, 300);
        });

        await this.updateAllUIs();
    }

    async popStackAndReturn() {
        if (!this.plugin.activeSession) return;

        await this.finishTimerForActiveSession();

        const frame = this.plugin.activeSession.stack.pop();
        if (!frame) {
            await this.stopCameraMode();
            return;
        }

        const leaf = this.plugin.app.workspace.getLeaf();
        if (!leaf) return;

        await leaf.openFile(frame.file);
        const view = leaf.view as ItemView;
        this.plugin.cameraModeView = view;

        this.plugin.activeSession.state = frame.state;
        this.plugin.activeSession.currentCanvasFile = frame.file;
        this.plugin.activeSession.currentCanvasData = frame.data;
        this.plugin.activeSession.currentNode = frame.currentNode;
        this.plugin.activeSession.history = [];

        if (this.plugin.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }

        // Auto-advance if there is only one path forward
        const edges = frame.data.edges.filter(e => e.fromNode === frame.currentNode.id);
        if (edges.length === 1) {
            const edge = edges[0];
            const nextNode = frame.data.nodes.find(n => n.id === edge.toNode);
            if (nextNode) {
                const parsed = LogicEngine.parseLabel(edge.label || "");
                if (LogicEngine.checkConditions(parsed, this.plugin.activeSession.state)) {
                    LogicEngine.updateState(parsed, this.plugin.activeSession.state);

                    if (nextNode.type === 'file' && nextNode.file && nextNode.file.endsWith('.canvas')) {
                        await this.diveIntoCanvas(view, frame.data, nextNode);
                        return;
                    }

                    this.plugin.activeSession.currentNode = nextNode;

                    await this.finishTimerForActiveSession();
                    if (this.plugin.settings.enableTimeboxing) {
                        await this.startTimerForActiveSession();
                    }

                    await this.createHud(view, frame.data, nextNode);
                    this.zoomToNode(view, nextNode);
                    requestAnimationFrame(() => {
                        setTimeout(async () => {
                            await this.applySpotlight(view, nextNode);
                        }, 300);
                    });
                    await this.updateAllUIs();
                    return;
                }
            }
        }

        await this.createHud(view, frame.data, frame.currentNode);
        this.zoomToNode(view, frame.currentNode);
        this.currentFocusedNodeEl = null;
        requestAnimationFrame(() => {
            setTimeout(async () => {
                await this.applySpotlight(view, frame.currentNode);
            }, 300);
        });

        await this.updateAllUIs();
    }

    // ─── CAMERA HELPERS ───────────────────────────────────────────

    zoomToNode(view: any, node: CanvasNode) {
        if (view && view.canvas) {
            const xPadding = node.width * 0.1;
            const yPadding = node.height * 0.1;
            view.canvas.zoomToBbox({
                minX: node.x - xPadding,
                minY: node.y - yPadding,
                maxX: node.x + node.width + xPadding,
                maxY: node.y + node.height + yPadding
            });
        }
    }

    async zoomToStartOfActiveCanvas() {
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'canvas') {
            new Notice('Please open a Canvas file first.');
            return;
        }

        const view = this.plugin.app.workspace.getActiveViewOfType(ItemView);
        if (!view || view.getViewType() !== 'canvas') {
            new Notice('Please focus a Canvas view.');
            return;
        }

        try {
            const content = await this.plugin.app.vault.read(activeFile);
            const canvasData: CanvasData = JSON.parse(content);
            const startNode = this.getStartNode(canvasData);

            if (!startNode) {
                new Notice(`Cannot zoom to start: Could not find a text card containing "${this.plugin.settings.startText}" that points to a playable node. Please ensure your canvas has a start marker card.`);
                return;
            }

            this.zoomToNode(view, startNode);
        } catch (error) {
            console.error('Canvas Player: failed to zoom to start', error);
            new Notice('Unable to zoom to start of this canvas.');
        }
    }

    async findCanvasNode(view: ItemView, node: CanvasNode, maxRetries: number = 5, initialDelay: number = 100): Promise<HTMLElement | null> {
        const canvas = (view as any).canvas;
        if (canvas && canvas.nodes) {
            try {
                const canvasNode = canvas.nodes.get?.(node.id) || canvas.nodes[node.id];

                if (canvasNode) {
                    const domElement = canvasNode.nodeEl ||
                        canvasNode.el ||
                        canvasNode.element ||
                        canvasNode.domEl ||
                        canvasNode.containerEl;

                    if (domElement && domElement instanceof HTMLElement) {
                        return domElement;
                    }
                }
            } catch (e) {
                console.warn('Canvas Player: Error accessing canvas.nodes API:', e);
            }
        }

        const selectors = [
            `.canvas-node[data-id="${node.id}"]`,
            `.canvas-node[data-node-id="${node.id}"]`,
            `[data-id="${node.id}"].canvas-node`,
            `[data-node-id="${node.id}"].canvas-node`
        ];

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            for (const selector of selectors) {
                const element = view.contentEl.querySelector(selector) as HTMLElement;
                if (element) {
                    return element;
                }
            }

            if (attempt === 0 || attempt === 2) {
                const allNodes = view.contentEl.querySelectorAll('.canvas-node');
                for (const nodeEl of Array.from(allNodes)) {
                    const el = nodeEl as HTMLElement;
                    const nodeId = el.getAttribute('data-id') ||
                        el.getAttribute('data-node-id') ||
                        (el as any).dataset?.id ||
                        (el as any).dataset?.nodeId ||
                        el.id;

                    if (nodeId === node.id) {
                        return el;
                    }
                }
            }

            if (attempt < maxRetries - 1) {
                const delay = initialDelay * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, delay));

                if (canvas && canvas.nodes) {
                    try {
                        const canvasNode = canvas.nodes.get?.(node.id) || canvas.nodes[node.id];
                        if (canvasNode) {
                            const domElement = canvasNode.nodeEl ||
                                canvasNode.el ||
                                canvasNode.element ||
                                canvasNode.domEl ||
                                canvasNode.containerEl;
                            if (domElement && domElement instanceof HTMLElement) {
                                return domElement;
                            }
                        }
                    } catch (e) {
                        // Continue to next attempt
                    }
                }
            }
        }

        console.warn(`Canvas Player: Could not find node element with id ${node.id} after ${maxRetries} attempts`);
        return null;
    }

    async applySpotlight(view: ItemView, node: CanvasNode) {
        const canvasWrapper = view.contentEl.querySelector('.canvas-wrapper') ||
            view.contentEl.querySelector('.canvas')?.parentElement;

        if (!canvasWrapper) {
            console.warn('Canvas Player: Could not find canvas wrapper element');
            return;
        }

        canvasWrapper.setAttribute('data-focus-mode-enabled', 'true');

        const targetEl = await this.findCanvasNode(view, node);

        if (targetEl) {
            if (this.currentFocusedNodeEl && this.currentFocusedNodeEl !== targetEl) {
                this.currentFocusedNodeEl.classList.remove('is-focused');
            }

            targetEl.classList.add('is-focused');
            this.currentFocusedNodeEl = targetEl;
        } else {
            console.warn(`Canvas Player: Could not apply focus to node ${node.id} - element not found`);
            this.currentFocusedNodeEl = null;
        }
    }

    removeSpotlight(view?: ItemView) {
        if (this.currentFocusedNodeEl) {
            try {
                this.currentFocusedNodeEl.classList.remove('is-focused');
            } catch (e) {
                // Node might have been removed from DOM
            }
            this.currentFocusedNodeEl = null;
        }

        if (view) {
            if (!view || !view.contentEl) return;

            try {
                const allFocusedNodes = view.contentEl.querySelectorAll('.canvas-node.is-focused');
                allFocusedNodes.forEach(node => node.classList.remove('is-focused'));

                const canvasWrapper = view.contentEl.querySelector('.canvas-wrapper') ||
                    view.contentEl.querySelector('.canvas')?.parentElement;
                if (canvasWrapper) {
                    canvasWrapper.removeAttribute('data-focus-mode-enabled');
                }
            } catch (e) {
                console.warn('Canvas Player: Error removing spotlight from view', e);
            }
        } else {
            try {
                this.plugin.app.workspace.iterateAllLeaves((leaf) => {
                    try {
                        if (!leaf.view || leaf.view.getViewType() !== 'canvas') return;

                        const v = leaf.view as ItemView;
                        if (!v || !v.contentEl) return;

                        const allFocusedNodes = v.contentEl.querySelectorAll('.canvas-node.is-focused');
                        allFocusedNodes.forEach(node => node.classList.remove('is-focused'));

                        const canvasWrapper = v.contentEl.querySelector('.canvas-wrapper') ||
                            v.contentEl.querySelector('.canvas')?.parentElement;
                        if (canvasWrapper) {
                            canvasWrapper.removeAttribute('data-focus-mode-enabled');
                        }
                    } catch (e) {
                        console.warn('Canvas Player: Error processing view in removeSpotlight', e);
                    }
                });
            } catch (e) {
                console.warn('Canvas Player: Error iterating leaves in removeSpotlight', e);
            }
        }
    }

    // ─── MINIMIZE / RESTORE ───────────────────────────────────────

    async minimizePlayer() {
        if (!this.plugin.activeSession) return;

        if (this.plugin.activeModal) {
            this.plugin.activeModal.isMinimizing = true;
            this.plugin.activeModal.close();
            this.plugin.activeModal = null;
        }

        await this.ensureMiniViewOpen();
        await this.updateAllUIs();
    }

    async restorePlayer() {
        if (!this.plugin.activeSession) return;

        const mode = this.plugin.activeSessionMode ?? this.plugin.settings.mode;

        if (mode === 'modal') {
            const { CanvasPlayerModal } = await import('../ui/modals/canvasPlayerModal');
            const session = this.plugin.activeSession;
            const modal = new CanvasPlayerModal(this.plugin);
            this.plugin.activeModal = modal;
            modal.open();
        } else {
            if (this.plugin.cameraModeView) {
                await this.restoreCameraMode();
            } else {
                const leaf = this.plugin.app.workspace.getLeaf(false) ?? this.plugin.app.workspace.getLeaf(true);
                if (!leaf) return;
                await leaf.openFile(this.plugin.activeSession.currentCanvasFile);
                this.plugin.app.workspace.revealLeaf(leaf);
                await this.startCameraMode(this.plugin.activeSession.currentCanvasData, this.plugin.activeSession.currentNode);
            }
        }

        await this.updateAllUIs();
    }

    async minimizeCameraMode() {
        if (!this.plugin.activeSession || !this.plugin.cameraModeView) return;

        if (this.plugin.activeHud) {
            this.plugin.activeHud.hide();
        }

        await this.ensureMiniViewOpen();
        await this.updateAllUIs();
    }

    async restoreCameraMode() {
        if (!this.plugin.activeSession || !this.plugin.cameraModeView) return;

        if (this.plugin.activeHud) {
            this.plugin.activeHud.show();
        } else {
            await this.createHud(
                this.plugin.cameraModeView,
                this.plugin.activeSession.currentCanvasData,
                this.plugin.activeSession.currentNode
            );
        }

        this.zoomToNode(this.plugin.cameraModeView, this.plugin.activeSession.currentNode);
        requestAnimationFrame(() => {
            setTimeout(async () => {
                await this.applySpotlight(this.plugin.cameraModeView!, this.plugin.activeSession!.currentNode);
            }, 300);
        });

        await this.updateAllUIs();
    }

    isPlayerMinimized(): boolean {
        if (!this.plugin.activeSession) return false;

        const mode = this.plugin.activeSessionMode ?? this.plugin.settings.mode;

        if (mode === 'modal') {
            return this.plugin.activeModal === null;
        }

        if (mode === 'camera') {
            if (!this.plugin.cameraModeView) return true;
            if (!this.plugin.activeHud) return true;
            return this.plugin.activeHud.offsetParent === null;
        }

        return false;
    }

    async ensureMiniViewOpen() {
        const leaves = this.plugin.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        if (leaves.length === 0) {
            const leaf = this.plugin.app.workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({
                    type: CANVAS_PLAYER_MINI_VIEW_TYPE,
                    active: true
                });
            }
        } else {
            this.plugin.app.workspace.revealLeaf(leaves[0]);
        }

        const miniLeaves = this.plugin.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        if (miniLeaves.length > 0) {
            const miniView = miniLeaves[0].view as CanvasPlayerMiniView;
            await miniView.refresh();
        }
    }

    async closeMiniView() {
        const leaves = this.plugin.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        for (const leaf of leaves) {
            await leaf.setViewState({
                type: 'empty',
                active: false
            });
        }
    }

    // ─── TIMER ────────────────────────────────────────────────────

    async startTimerForActiveSession() {
        if (!this.plugin.activeSession || !this.plugin.settings.enableTimeboxing) return;

        const timingData = await loadTimingForNode(
            this.plugin.app,
            this.plugin.activeSession.currentCanvasFile,
            this.plugin.activeSession.currentNode,
            this.plugin.activeSession.currentCanvasData
        );

        if (timingData && timingData.avgMs > 0) {
            const durationMs = timingData.avgMs;
            this.plugin.activeSession.timerDurationMs = durationMs;
            this.plugin.activeSession.timerStartTimeMs = Date.now();
            this.plugin.sharedTimer.start(durationMs, 'countdown');
        } else {
            this.plugin.activeSession.timerDurationMs = 0;
            this.plugin.activeSession.timerStartTimeMs = Date.now();
            this.plugin.sharedTimer.start(0, 'countup');
        }

        this.updateStatusBar();
        await this.plugin.saveActiveSessionState();
    }

    async finishTimerForActiveSession() {
        if (!this.plugin.activeSession || !this.plugin.settings.enableTimeboxing || !this.plugin.sharedTimer.isRunning()) {
            return;
        }

        const elapsedMs = this.plugin.sharedTimer.finish();

        const existingTiming = await loadTimingForNode(
            this.plugin.app,
            this.plugin.activeSession.currentCanvasFile,
            this.plugin.activeSession.currentNode,
            this.plugin.activeSession.currentCanvasData
        );

        const newTiming = updateRobustAverage(existingTiming, elapsedMs);

        // Award points only if this is NOT the first completion (calibration)
        if (existingTiming && existingTiming.avgMs > 0) {
            const points = calculatePoints(elapsedMs, existingTiming.avgMs);
            if (points > 0) {
                const ratio = elapsedMs / existingTiming.avgMs;
                const message = getPointsMessage(points, ratio);
                recordEarn(this.plugin.economy, this.plugin.deviceId, points, {
                    nodeId: this.plugin.activeSession.currentNode.id
                });
                await this.plugin.savePluginData();
                new Notice(message);
            }
        }

        const canvasNeedsSave = await saveTimingForNode(
            this.plugin.app,
            this.plugin.activeSession.currentCanvasFile,
            this.plugin.activeSession.currentNode,
            this.plugin.activeSession.currentCanvasData,
            newTiming
        );

        if (canvasNeedsSave) {
            const content = JSON.stringify(this.plugin.activeSession.currentCanvasData, null, 2);
            await this.plugin.app.vault.modify(this.plugin.activeSession.currentCanvasFile, content);
        }
    }

    abortTimerForActiveSession(): void {
        if (!this.plugin.settings.enableTimeboxing) return;
        if (!this.plugin.sharedTimer.isRunning()) return;
        this.plugin.sharedTimer.abort();
    }

    // ─── UI UPDATES ───────────────────────────────────────────────

    async updateAllUIs() {
        if (this.plugin.activeModal) {
            await this.plugin.activeModal.refreshScene();
        }

        const miniLeaves = this.plugin.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        miniLeaves.forEach(leaf => {
            const miniView = leaf.view as CanvasPlayerMiniView;
            miniView.refresh();
        });

        this.updateStatusBar();
    }

    updateStatusBar() {
        if (!this.plugin.statusBarItem) return;

        if (!this.plugin.activeSession) {
            this.plugin.statusBarItem.hide();
            return;
        }

        if (!this.plugin.settings.enableTimeboxing) {
            this.plugin.statusBarItem.hide();
            return;
        }

        this.plugin.statusBarItem.show();
        const remainingMs = this.plugin.sharedTimer.getRemainingMs();
        const mode = this.plugin.sharedTimer.getMode();
        const formatted = formatRemainingTime(remainingMs, mode);
        this.plugin.statusBarItem.setText(`Canvas Player: ${formatted}`);
    }
}

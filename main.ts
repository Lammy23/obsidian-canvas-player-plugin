import { App, Modal, Plugin, Notice, MarkdownRenderer, ButtonComponent, PluginSettingTab, Setting, ItemView, Component, TFile, Menu, debounce, WorkspaceLeaf } from 'obsidian';
import { LogicEngine, GameState } from './logic';
import { CanvasNode, CanvasData, StackFrame } from './types';
import { CanvasPlayerSettings, DEFAULT_SETTINGS } from './settings';
import { extractNodeInfo, transformNode, convertCardToGroup, convertGroupToCard } from './canvasTransforms';
import { NodeTimerController, TimingData } from './timeboxing';
import { loadTimingForNode, saveTimingForNode } from './timingStorage';
import { PluginData, ResumeSession, ResumeStackFrame, validateResumeSession, restoreStackFromResume } from './resumeStorage';
import { resetTimeboxingRecursive } from './timeboxingReset';
import { SharedCountdownTimer, formatRemainingTime } from './sharedCountdownTimer';
import { ActiveSession, createActiveSession, cloneActiveSession } from './playerSession';
import { CanvasPlayerMiniView, CANVAS_PLAYER_MINI_VIEW_TYPE } from './miniPlayerView';

export class CanvasPlayerPlugin extends Plugin {
    settings: CanvasPlayerSettings;
    activeHud: HTMLElement | null = null; 
    activeOverlay: HTMLElement | null = null;
    currentSessionState: GameState = {};
    stack: StackFrame[] = [];
    
    // Map to track reset stats button elements per view
    resetStatsElements: Map<ItemView, HTMLElement> = new Map();
    
    // Timer state for Camera Mode (legacy, will migrate to shared timer)
    cameraTimer: NodeTimerController | null = null;
    currentCanvasFile: TFile | null = null;
    currentCanvasData: CanvasData | null = null;
    currentNodeForTimer: CanvasNode | null = null;
    
    // Resume session tracking
    private rootCanvasFile: TFile | null = null; // Track root canvas for saving resume position

    // Active session management (for minimize/restore)
    activeSession: ActiveSession | null = null;
    sharedTimer: SharedCountdownTimer = new SharedCountdownTimer();
    activeModal: CanvasPlayerModal | null = null; // Track if modal is open
    statusBarItem: HTMLElement | null = null; // Status bar timer item
    statusBarUnsubscribe: (() => void) | null = null; // Timer subscription for status bar
    
    // Track currently focused node element for efficient blur transitions
    private currentFocusedNodeEl: HTMLElement | null = null;

    private readonly actionableView = (view: ItemView): view is ItemView & {
        addAction(icon: string, title: string, callback: () => void): void;
    } => typeof (view as ItemView & { addAction?: unknown }).addAction === 'function';

    async onload() {
        await this.loadPluginData();

        // Register mini-player view
        this.registerView(
            CANVAS_PLAYER_MINI_VIEW_TYPE,
            (leaf) => new CanvasPlayerMiniView(leaf, this)
        );

        // Initialize status bar item (initially hidden)
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass('canvas-player-statusbar-item');
        this.statusBarItem.hide();
        this.statusBarItem.onClickEvent(() => {
            void this.restorePlayer();
        });
        
        // Subscribe status bar to timer updates
        this.statusBarUnsubscribe = this.sharedTimer.subscribe(() => {
            this.updateStatusBar();
        });

        this.app.workspace.onLayoutReady(() => {
            this.refreshCanvasViewActions();
        });

        this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
            this.refreshCanvasViewActions();
        }));

        this.addCommand({
            id: 'play-canvas-command',
            name: 'Play current canvas (from start)',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'canvas') {
                    if (!checking) this.playActiveCanvas();
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'play-canvas-command-last',
            name: 'Play current canvas (from last)',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'canvas') {
                    if (!checking) void this.playActiveCanvasFromLast();
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'zoom-canvas-to-start',
            name: 'Zoom Canvas to Start',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'canvas') {
                    if (!checking) void this.zoomToStartOfActiveCanvas();
                    return true;
                }
                return false;
            }
        });

        // Commands for minimized player
        this.addCommand({
            id: 'canvas-player-restore',
            name: 'Restore Canvas Player',
            checkCallback: (checking: boolean) => {
                if (this.activeSession) {
                    if (!checking) void this.restorePlayer();
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'canvas-player-stop',
            name: 'Stop Canvas Player',
            checkCallback: (checking: boolean) => {
                if (this.activeSession) {
                    if (!checking) void this.stopActiveSession();
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'canvas-player-minimize',
            name: 'Minimize Canvas Player',
            checkCallback: (checking: boolean) => {
                if (this.activeModal) {
                    if (!checking) void this.minimizePlayer();
                    return true;
                }
                return false;
            }
        });

        this.addSettingTab(new CanvasPlayerSettingTab(this.app, this));

        // Register context menu for canvas nodes
        // Note: canvas:node-menu is not in official types but is available in Obsidian
        this.registerEvent(
            (this.app.workspace as any).on('canvas:node-menu', (menu: Menu, node: any) => {
                menu.addItem((item: any) => {
                    item
                        .setTitle('Play from here')
                        .setIcon('play-circle')
                        .onClick(async () => {
                            await this.playFromNode(node);
                        });
                });
                
                // Add transform menu items
                this.addTransformMenuItems(menu, node);
            })
        );
        
        // Also register for group-menu as a compatibility hook
        // Some Obsidian builds fire a dedicated group menu event
        this.registerEvent(
            (this.app.workspace as any).on('canvas:group-menu', (menu: Menu, node: any) => {
                this.addTransformMenuItems(menu, node);
            })
        );
    }

    onunload() {
        // Clean up any active timers
        if (this.cameraTimer) {
            this.cameraTimer.abort();
            this.cameraTimer = null;
        }
        
        // Clean up shared timer
        this.sharedTimer.abort();
        
        // Unsubscribe status bar
        if (this.statusBarUnsubscribe) {
            this.statusBarUnsubscribe();
            this.statusBarUnsubscribe = null;
        }
        
        // Close active modal if any
        if (this.activeModal) {
            this.activeModal.close();
            this.activeModal = null;
        }
        
        // Clear active session
        this.activeSession = null;
        
        // Hide status bar
        if (this.statusBarItem) {
            this.statusBarItem.hide();
        }
    }

    // ... existing code ...

    refreshCanvasViewActions() {
        this.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view.getViewType() !== 'canvas') return;
    
        const view = leaf.view as ItemView;
    
        // headerEl is not guaranteed across Obsidian versions/timing
        const headerEl: HTMLElement | null =
            ((view as any).headerEl as HTMLElement | undefined) ??
            (view.containerEl?.querySelector?.(".view-header") as HTMLElement | null) ??
            null;
    
        const actionsContainer =
            headerEl?.querySelector?.(".view-actions") ?? null;
    
        // Add Reset Stats button if timeboxing is enabled
        if (this.settings.enableTimeboxing) {
            if (!this.resetStatsElements.has(view) && actionsContainer) {
            const file = ((view as any).file as TFile | null) ?? undefined;
            if (file && file.extension === "canvas") {
                const resetBtn = document.createElement("button");
                resetBtn.textContent = "Reset stats";
                resetBtn.className = "canvas-reset-stats-btn";
                resetBtn.setAttribute("aria-label", "Reset timeboxing stats for this canvas");
                resetBtn.style.marginRight = "10px";
                resetBtn.style.fontSize = "0.85em";
                resetBtn.style.padding = "4px 8px";
                resetBtn.onclick = () => {
                new ConfirmResetTimeboxingModal(this.app, this, file).open();
                };
    
                actionsContainer.insertBefore(resetBtn, actionsContainer.lastChild);
                this.resetStatsElements.set(view, resetBtn);
            }
            }
        } else {
            const resetBtn = this.resetStatsElements.get(view);
            if (resetBtn) {
            resetBtn.remove();
            this.resetStatsElements.delete(view);
            }
        }
    
        // If there's no header yet, don't try to add actions (it may throw internally)
        if (!headerEl) return;
    
        // Add Player buttons
        if (!this.actionableView(view)) return;
        if ((view as any)._hasCanvasPlayerButton) return;
    
        try {
            view.addAction("play", "Play from start", () => this.playActiveCanvas());
            view.addAction("play-circle", "Play from last", () => void this.playActiveCanvasFromLast());
            view.addAction("zoom-in", "Zoom to start", () => void this.zoomToStartOfActiveCanvas());
            (view as any)._hasCanvasPlayerButton = true;
        } catch (e) {
            console.warn("Canvas Player: failed to add canvas header actions", e);
        }
        });
    }
  
  // ... existing code ...

    getStartNode(data: CanvasData): CanvasNode | null {
        const startText = this.settings.startText?.toLowerCase().trim();
        if (!startText) {
            // If no start text configured, fall back to old behavior
            const nodeIdsWithIncoming = new Set(data.edges.map(e => e.toNode));
            const firstTextWithoutIncoming = data.nodes.find(
                n => n.type === 'text' && !nodeIdsWithIncoming.has(n.id)
            );
            return firstTextWithoutIncoming || data.nodes[0] || null;
        }

        // Find the marker node (contains startText)
        const markerNode = data.nodes.find(node =>
            node.type === 'text' &&
            typeof node.text === 'string' &&
            node.text.toLowerCase().includes(startText)
        );

        if (!markerNode) {
            // Marker node not found - return null (caller will show warning)
            return null;
        }

        // Find the node the marker points to (skip the marker node)
        const edgesFromMarker = data.edges.filter(edge => edge.fromNode === markerNode.id);
        if (edgesFromMarker.length === 0) {
            // Marker node has no outgoing edges - return null (caller will show warning)
            return null;
        }

        // Get the first node the marker points to
        const targetNodeId = edgesFromMarker[0].toNode;
        const targetNode = data.nodes.find(n => n.id === targetNodeId);
        
        return targetNode || null;
    }

    async loadPluginData(): Promise<void> {
        const rawData = await this.loadData();
        
        // Migration: if data is flat (old format), wrap it
        if (rawData && !rawData.settings && !rawData.resumeSessions) {
            // Old format: data is directly the settings object
            const pluginData: PluginData = {
                settings: rawData,
                resumeSessions: {}
            };
            this.settings = Object.assign({}, DEFAULT_SETTINGS, pluginData.settings);
            // Migrate: save new format
            await this.saveData(pluginData);
        } else {
            // New format: has settings and resumeSessions
            const pluginData = rawData as PluginData;
            this.settings = Object.assign({}, DEFAULT_SETTINGS, pluginData?.settings || {});
            
            // Ensure resumeSessions exists
            if (!pluginData?.resumeSessions) {
                const updatedData: PluginData = {
                    settings: this.settings,
                    resumeSessions: {}
                };
                await this.saveData(updatedData);
            }
        }
        
        // Clean up any old complexity-related settings that might exist
        if ('showComplexityScore' in this.settings) {
            delete (this.settings as any).showComplexityScore;
        }
        if ('complexityWeights' in this.settings) {
            delete (this.settings as any).complexityWeights;
        }
    }

    async savePluginData(): Promise<void> {
        const currentData = (await this.loadData()) as PluginData | null;
        const pluginData: PluginData = {
            settings: this.settings,
            resumeSessions: currentData?.resumeSessions || {}
        };
        await this.saveData(pluginData);
        
        // Refresh UI based on new settings
        this.refreshCanvasViewActions();
    }

    async saveResumeSession(rootFilePath: string, session: ResumeSession): Promise<void> {
        const currentData = (await this.loadData()) as PluginData | null;
        const pluginData: PluginData = {
            settings: this.settings,
            resumeSessions: { ...(currentData?.resumeSessions || {}), [rootFilePath]: session }
        };
        await this.saveData(pluginData);
    }

    async getResumeSession(rootFilePath: string): Promise<ResumeSession | null> {
        const currentData = (await this.loadData()) as PluginData | null;
        return currentData?.resumeSessions?.[rootFilePath] || null;
    }

    async clearResumeSession(rootFilePath: string): Promise<void> {
        const currentData = (await this.loadData()) as PluginData | null;
        if (!currentData?.resumeSessions) return;
        
        const { [rootFilePath]: _, ...remainingSessions } = currentData.resumeSessions;
        const pluginData: PluginData = {
            settings: this.settings,
            resumeSessions: remainingSessions
        };
        await this.saveData(pluginData);
    }

    // Legacy methods for compatibility (redirect to new methods)
    async loadSettings() {
        await this.loadPluginData();
    }

    async saveSettings() {
        await this.savePluginData();
    }

    async playActiveCanvas() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'canvas') {
            new Notice('Please open a Canvas file first.');
            return;
        }

        // Reset root tracking for new session
        this.rootCanvasFile = activeFile;

        const content = await this.app.vault.read(activeFile);
        const canvasData: CanvasData = JSON.parse(content);

        const startNode = this.getStartNode(canvasData);

        if (!startNode) {
            new Notice(`Cannot start: Could not find a text card containing "${this.settings.startText}" that points to a playable node. Please ensure your canvas has a start marker card.`);
            return;
        }

        await this.playCanvasFromNode(activeFile, canvasData, startNode);
    }

    async playActiveCanvasFromLast() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'canvas') {
            new Notice('Please open a Canvas file first.');
            return;
        }

        // Load resume session
        const session = await this.getResumeSession(activeFile.path);
        if (!session) {
            new Notice('No saved position found for this canvas. Starting from the beginning.');
            await this.playActiveCanvas();
            return;
        }

        // Validate session
        const validationError = await validateResumeSession(this.app, session);
        if (validationError) {
            new Notice(`Cannot resume: ${validationError}. Starting from the beginning.`);
            await this.clearResumeSession(activeFile.path);
            await this.playActiveCanvas();
            return;
        }

        try {
            // Set root tracking
            this.rootCanvasFile = activeFile;

            // Restore stack
            this.stack = await restoreStackFromResume(this.app, session.stack);

            // Load current canvas and node
            const currentFile = this.app.vault.getAbstractFileByPath(session.currentFilePath);
            if (!(currentFile instanceof TFile)) {
                throw new Error(`Current file not found: ${session.currentFilePath}`);
            }

            const content = await this.app.vault.read(currentFile);
            const canvasData: CanvasData = JSON.parse(content);
            const currentNode = canvasData.nodes.find(n => n.id === session.currentNodeId);
            if (!currentNode) {
                throw new Error(`Node not found: ${session.currentNodeId}`);
            }

            // Start playback at saved node with restored state and stack
            await this.playCanvasFromNode(currentFile, canvasData, currentNode, session.currentSessionState, this.stack);
        } catch (error) {
            console.error('Canvas Player: failed to resume session', error);
            new Notice(`Failed to resume session: ${error instanceof Error ? error.message : 'Unknown error'}. Starting from the beginning.`);
            await this.clearResumeSession(activeFile.path);
            await this.playActiveCanvas();
        }
    }

    addTransformMenuItems(menu: Menu, node: any) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo) {
            return;
        }
        
        const { id, type } = nodeInfo;
        
        // Add separator before transform options
        menu.addSeparator();
        
        // Card to Group conversion
        if (type === 'text' || type === 'file') {
            menu.addItem((item: any) => {
                item
                    .setTitle('Convert to group')
                    .setIcon('folder')
                    .onClick(async () => {
                        await transformNode(this.app, id, type, convertCardToGroup);
                    });
            });
        }
        
        // Group to Card conversion
        if (type === 'group') {
            menu.addItem((item: any) => {
                item
                    .setTitle('Convert to card')
                    .setIcon('file-text')
                    .onClick(async () => {
                        await transformNode(this.app, id, type, convertGroupToCard);
                    });
            });
        }
    }

    async playFromNode(contextNode: any) {
        // Get the node ID from the context menu node
        // The node structure may vary, so check multiple possible properties
        const nodeId = contextNode?.id || contextNode?.node?.id || contextNode?.getData?.()?.id;
        if (!nodeId) {
            console.error('Canvas Player: Could not extract node ID from context node', contextNode);
            new Notice('Could not identify the selected card.');
            return;
        }

        // Get the active canvas file
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'canvas') {
            new Notice('Please open a Canvas file first.');
            return;
        }

        try {
            // Load canvas data
            const content = await this.app.vault.read(activeFile);
            const canvasData: CanvasData = JSON.parse(content);

            // Find the matching node in the canvas data
            const matchingNode = canvasData.nodes.find(n => n.id === nodeId);
            if (!matchingNode) {
                new Notice('Could not find the selected card in the canvas.');
                return;
            }

            // Only allow playing from text nodes
            if (matchingNode.type !== 'text' && matchingNode.type !== 'file') {
                new Notice('Can only play from text or file cards.');
                return;
            }

            await this.playCanvasFromNode(activeFile, canvasData, matchingNode);
        } catch (error) {
            console.error('Canvas Player: failed to play from node', error);
            new Notice('Unable to play from the selected card.');
        }
    }

    async playCanvasFromNode(canvasFile: TFile, canvasData: CanvasData, startNode: CanvasNode, initialState?: GameState, initialStack?: StackFrame[]) {
        // If rootCanvasFile is not set, this is a new session (not a resume)
        const isNewSession = !this.rootCanvasFile;
        if (isNewSession) {
            this.rootCanvasFile = canvasFile;
        }

        if (this.settings.mode === 'modal') {
            // Create active session for modal mode
            const rootFile = this.rootCanvasFile ?? canvasFile;
            let timerDurationMs = 0;
            
            if (this.settings.enableTimeboxing) {
                const timingData = await loadTimingForNode(this.app, canvasFile, startNode, canvasData);
                const defaultMs = this.settings.defaultNodeDurationMinutes * 60 * 1000;
                timerDurationMs = timingData ? timingData.avgMs : defaultMs;
            }
            
            this.activeSession = createActiveSession(
                rootFile,
                canvasFile,
                canvasData,
                startNode,
                initialState,
                initialStack,
                timerDurationMs
            );
            
            // Start shared timer if timeboxing is enabled
            if (this.settings.enableTimeboxing && timerDurationMs > 0) {
                this.sharedTimer.start(timerDurationMs);
            }
            
            // Update status bar
            this.updateStatusBar();
            
            // Ensure mini view is available (will be opened on minimize)
            const modal = new CanvasPlayerModal(this, canvasFile, canvasData, startNode, initialState, initialStack, rootFile);
            this.activeModal = modal;
            modal.open();
        } else {
            // For camera mode, restore state/stack if provided (resume), otherwise reset (new session)
            if (initialState) {
                this.currentSessionState = { ...initialState };
            } else if (isNewSession) {
                this.currentSessionState = {}; // Reset for new session
            }
            if (initialStack) {
                this.stack = initialStack.map(frame => ({
                    file: frame.file,
                    data: frame.data,
                    currentNode: frame.currentNode,
                    state: { ...frame.state }
                }));
            } else if (isNewSession) {
                this.stack = []; // Reset for new session
            }
            await this.startCameraMode(canvasData, startNode);
        }
    }

    async zoomToStartOfActiveCanvas() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'canvas') {
            new Notice('Please open a Canvas file first.');
            return;
        }

        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (!view || view.getViewType() !== 'canvas') {
            new Notice('Please focus a Canvas view.');
            return;
        }

        try {
            const content = await this.app.vault.read(activeFile);
            const canvasData: CanvasData = JSON.parse(content);
            const startNode = this.getStartNode(canvasData);

            if (!startNode) {
                new Notice(`Cannot zoom to start: Could not find a text card containing "${this.settings.startText}" that points to a playable node. Please ensure your canvas has a start marker card.`);
                return;
            }

            this.zoomToNode(view, startNode);
        } catch (error) {
            console.error('Canvas Player: failed to zoom to start', error);
            new Notice('Unable to zoom to start of this canvas.');
        }
    }

    // --- CAMERA MODE LOGIC ---
    async startCameraMode(data: CanvasData, startNode: CanvasNode) {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        if (!view || view.getViewType() !== 'canvas') return;

        // State and stack are managed by playCanvasFromNode:
        // - For new sessions: state/stack are empty (already reset)
        // - For resume: state/stack are restored before calling this method

        await this.createHud(view, data, startNode);
        
        // Initial Move
        this.zoomToNode(view, startNode);
        
        // Apply spotlight after zoom settles (blur will be enabled, node will be focused)
        requestAnimationFrame(() => {
            setTimeout(async () => {
                await this.applySpotlight(view, startNode);
            }, 300); // Reduced delay - blur stays active
        });
    }

    async createHud(view: ItemView, data: CanvasData, currentNode: CanvasNode) {
        if (this.activeHud) this.activeHud.remove();
        if (this.activeOverlay) this.activeOverlay.remove();

        // Note: Overlay is no longer used for blur (we use CSS classes instead)
        // Keeping activeOverlay variable for potential future use, but not creating it here

        // Create HUD
        const hudEl = view.contentEl.createDiv({ cls: 'canvas-player-hud' });
        this.activeHud = hudEl;

        // Top-right controls container
        const topControls = hudEl.createDiv({ cls: 'canvas-hud-top-controls' });
        
        // Timer display (top-right) - only if timeboxing is enabled
        let timerEl: HTMLElement | null = null;
        if (this.settings.enableTimeboxing) {
            timerEl = topControls.createDiv({ cls: 'canvas-player-timer' });
            timerEl.setText('--:--');
        }
        
        const closeBtn = topControls.createEl('button', { text: 'Stop Playing', cls: 'canvas-hud-close' });
        closeBtn.onclick = () => {
           void this.stopCameraMode();
        };

        const choicesContainer = hudEl.createDiv({ cls: 'canvas-hud-choices' });
        
        // Store current context for timer
        this.currentCanvasFile = (view as any).file;
        this.currentCanvasData = data;
        this.currentNodeForTimer = currentNode;
        
        // Start timer for current node (if enabled and timer element exists)
        if (timerEl) {
            await this.startTimerForNode(view, data, currentNode, timerEl);
        }
        
        this.renderChoicesInHud(view, data, currentNode, choicesContainer);
    }

    async startTimerForNode(view: ItemView, data: CanvasData, node: CanvasNode, timerEl: HTMLElement) {
        // Only start timer if timeboxing is enabled
        if (!this.settings.enableTimeboxing) {
            return;
        }

        // Abort any existing timer
        if (this.cameraTimer) {
            this.cameraTimer.abort();
            this.cameraTimer = null;
        }

        // Load timing data for this node
        const canvasFile = (view as any).file;
        if (!canvasFile) return;

        const timingData = await loadTimingForNode(this.app, canvasFile, node, data);
        const defaultMs = this.settings.defaultNodeDurationMinutes * 60 * 1000;
        const initialMs = timingData ? timingData.avgMs : defaultMs;

        // Create and start timer
        this.cameraTimer = new NodeTimerController();
        this.cameraTimer.start(initialMs, timerEl);
    }

    async finishTimerForCurrentNode(): Promise<void> {
        // Only finish timer if timeboxing is enabled
        if (!this.settings.enableTimeboxing || !this.cameraTimer || !this.currentCanvasFile || !this.currentCanvasData || !this.currentNodeForTimer) {
            return;
        }

        const elapsedMs = this.cameraTimer.finish();
        
        // Load existing timing or start fresh
        const existingTiming = await loadTimingForNode(
            this.app,
            this.currentCanvasFile,
            this.currentNodeForTimer,
            this.currentCanvasData
        );

        let newTiming: TimingData;
        if (existingTiming) {
            newTiming = NodeTimerController.updateAverage(
                existingTiming.avgMs,
                existingTiming.samples,
                elapsedMs
            );
        } else {
            newTiming = { avgMs: elapsedMs, samples: 1 };
        }

        // Save timing back
        const canvasNeedsSave = await saveTimingForNode(
            this.app,
            this.currentCanvasFile,
            this.currentNodeForTimer,
            this.currentCanvasData,
            newTiming
        );

        // If canvas needs save (text nodes or fallback), write it
        if (canvasNeedsSave && this.currentCanvasFile) {
            const content = JSON.stringify(this.currentCanvasData, null, 2);
            await this.app.vault.modify(this.currentCanvasFile, content);
        }

        this.cameraTimer = null;
    }

    async stopCameraMode() {
         // Save resume session before stopping
         if (this.rootCanvasFile && this.currentCanvasFile && this.currentCanvasData && this.currentNodeForTimer) {
             const resumeStack: ResumeStackFrame[] = this.stack.map(frame => ({
                 filePath: frame.file.path,
                 currentNodeId: frame.currentNode.id,
                 state: { ...frame.state }
             }));

             const session: ResumeSession = {
                 rootFilePath: this.rootCanvasFile.path,
                 currentFilePath: this.currentCanvasFile.path,
                 currentNodeId: this.currentNodeForTimer.id,
                 currentSessionState: { ...this.currentSessionState },
                 stack: resumeStack
             };

             await this.saveResumeSession(this.rootCanvasFile.path, session);
         }

         // Abort timer (don't save)
         if (this.cameraTimer) {
             this.cameraTimer.abort();
             this.cameraTimer = null;
         }
         
        // Remove spotlight from all views
        this.removeSpotlight();
        
        this.activeHud?.remove();
        this.activeOverlay?.remove();
        this.activeHud = null;
        this.activeOverlay = null;
        this.stack = []; // Clear stack on stop
        this.currentCanvasFile = null;
        this.currentCanvasData = null;
        this.currentNodeForTimer = null;
        this.rootCanvasFile = null;
    }

    async renderChoicesInHud(view: ItemView, data: CanvasData, currentNode: CanvasNode, container: HTMLElement) {
        container.empty();

        // Handle Markdown File Nodes (Embedded Notes)
        if (currentNode.type === 'file' && currentNode.file && !currentNode.file.endsWith('.canvas')) {
             const file = this.app.metadataCache.getFirstLinkpathDest(currentNode.file, (view as any).file?.path || "");
             if (file instanceof TFile) {
                 const content = await this.app.vault.read(file);
                 const contentEl = container.createDiv({ cls: 'canvas-player-note-content' });
                 await MarkdownRenderer.render(this.app, content, contentEl, file.path, this as unknown as Component);
             }
        }

        const rawChoices = data.edges.filter(edge => edge.fromNode === currentNode.id);
        
        // 1. Pre-parse choices and check for missing variables
        const parsedChoices = rawChoices.map(edge => {
            const parsed = LogicEngine.parseLabel(edge.label || "Next");
            return { edge, parsed };
        });

        const missingVars = new Set<string>();
        parsedChoices.forEach(item => {
            const missing = LogicEngine.getMissingVariables(item.parsed, this.currentSessionState);
            missing.forEach(v => missingVars.add(v));
        });

        if (missingVars.size > 0) {
            container.createEl('div', { text: 'Please set values for new variables:', cls: 'canvas-player-prompt-header' });
            
            missingVars.forEach(variable => {
                // Default to false if not set
                if (this.currentSessionState[variable] === undefined) {
                    this.currentSessionState[variable] = false;
                }

                new Setting(container)
                    .setName(variable)
                    .addToggle(toggle => toggle
                        .setValue(this.currentSessionState[variable])
                        .onChange(val => {
                            this.currentSessionState[variable] = val;
                        }));
            });

            new ButtonComponent(container)
                .setButtonText("Continue")
                .setCta()
                .onClick(() => {
                    // Re-run render to process choices with updated state
                    this.renderChoicesInHud(view, data, currentNode, container);
                });
            return;
        }
        
        // 2. Filter choices based on state
        const validChoices = parsedChoices.filter(item => LogicEngine.checkConditions(item.parsed, this.currentSessionState));

        if (validChoices.length === 0) {
            if (this.stack.length > 0) {
                new ButtonComponent(container)
                    .setButtonText("Return to Parent Canvas")
                    .setCta()
                    .onClick(async () => {
                         // Finish and save timer before returning
                         await this.finishTimerForCurrentNode();
                         await this.popStackAndReturn();
                    })
                    .buttonEl.addClass('mod-cta');
            } else {
                new ButtonComponent(container)
                    .setButtonText("End of Path") 
                    .onClick(async () => {
                        // Finish and save timer before stopping
                        await this.finishTimerForCurrentNode();
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
                            // Finish and save timer for current node
                            await this.finishTimerForCurrentNode();
                            
                            // Update state
                            LogicEngine.updateState(choice.parsed, this.currentSessionState);

                            // Check if next node is a Canvas file
                            if (nextNode.type === 'file' && nextNode.file && nextNode.file.endsWith('.canvas')) {
                                await this.diveIntoCanvas(view, data, nextNode);
                                return;
                            }

                            // 1. Move Camera (blur stays active, only focused node will change)
                            this.zoomToNode(view, nextNode);
                            
                            // 2. Update timer context and restart timer for next node (if enabled)
                            this.currentNodeForTimer = nextNode;
                            if (this.settings.enableTimeboxing) {
                                const timerEl = this.activeHud?.querySelector('.canvas-player-timer') as HTMLElement;
                                if (timerEl && this.currentCanvasData) {
                                    await this.startTimerForNode(view, this.currentCanvasData, nextNode, timerEl);
                                }
                            }
                            
                            // 3. Render next buttons immediately
                            this.renderChoicesInHud(view, data, nextNode, container);
                            
                            // 4. Update spotlight to new node (smooth transition, no blur gap)
                            // Use requestAnimationFrame for smoother timing, then small delay for zoom to settle
                            requestAnimationFrame(() => {
                                setTimeout(async () => {
                                    await this.applySpotlight(view, nextNode);
                                }, 300); // Reduced delay - blur stays active, only focused node changes
                            });
                        }
                    })
                    .buttonEl.addClass('canvas-player-btn');
            });
        }
    }

    async diveIntoCanvas(view: ItemView, currentData: CanvasData, fileNode: CanvasNode) {
        // Finish and save timer for current file node before diving
        await this.finishTimerForCurrentNode();
        
        const filePath = fileNode.file;
        if (!filePath) return;

        const targetFile = this.app.metadataCache.getFirstLinkpathDest(filePath, (view as any).file?.path || "");
        
        if (!targetFile || targetFile.extension !== 'canvas') {
             new Notice(`Could not find canvas file: ${filePath}`);
             return;
        }

        // 1. Push to stack
        // We need the current file.
        // @ts-ignore
        const currentFile = view.file; 
        if (!currentFile) return;

        this.stack.push({
            file: currentFile,
            data: currentData,
            currentNode: fileNode,
            state: Object.assign({}, this.currentSessionState) // Clone state if needed, or store "parent" state
        });

        // 2. Reset state for isolated scope (User selected "Isolated")
        this.currentSessionState = {}; 

        // 3. Open the new file
        const leaf = view.leaf;
        await leaf.openFile(targetFile);
        
        // 4. Get new view and data
        const newView = leaf.view as ItemView;
        const content = await this.app.vault.read(targetFile);
        const newData: CanvasData = JSON.parse(content);
        const startNode = this.getStartNode(newData);

        if (!startNode) {
             new Notice(`Cannot start embedded canvas: Could not find a text card containing "${this.settings.startText}" that points to a playable node.`);
             // Rollback?
             await this.popStackAndReturn();
             return;
        }

        // 5. Start playing in new context
        await this.createHud(newView, newData, startNode);
        this.zoomToNode(newView, startNode);
        // Clear previous focused node since we're in a new canvas
        this.currentFocusedNodeEl = null;
        requestAnimationFrame(() => {
            setTimeout(async () => {
                await this.applySpotlight(newView, startNode);
            }, 300); // Reduced delay - blur stays active
        });
    }

    async popStackAndReturn() {
        // Finish and save timer for current node (if any) before returning
        await this.finishTimerForCurrentNode();
        
        const frame = this.stack.pop();
        if (!frame) {
            await this.stopCameraMode();
            return;
        }

        // Restore active file
        const leaf = this.app.workspace.getLeaf();
        if (!leaf) return;

        await leaf.openFile(frame.file);
        const view = leaf.view as ItemView;

        // Restore state (Isolated means we discard current, restore parent)
        // Note: If user selected "Shared", we wouldn't discard, but merge or keep. 
        // Implementing Isolated as requested.
        this.currentSessionState = frame.state;

        // Restore HUD at the node we left off (the File node)
        await this.createHud(view, frame.data, frame.currentNode);
        
        // Zoom to that node
        this.zoomToNode(view, frame.currentNode);
        // Clear previous focused node since we're returning to a different canvas
        this.currentFocusedNodeEl = null;
        requestAnimationFrame(() => {
            setTimeout(async () => {
                await this.applySpotlight(view, frame.currentNode);
            }, 300); // Reduced delay - blur stays active
        });
    }

    removeSpotlight(view?: ItemView) {
        // Clear tracked focused node
        if (this.currentFocusedNodeEl) {
            try {
                this.currentFocusedNodeEl.classList.remove('is-focused');
            } catch (e) {
                // Node might have been removed from DOM
            }
            this.currentFocusedNodeEl = null;
        }
        
        // Remove is-focused class from all nodes (fallback cleanup)
        if (view) {
            // Safety check: ensure view and contentEl exist
            if (!view || !view.contentEl) {
                return;
            }
            
            try {
                const allFocusedNodes = view.contentEl.querySelectorAll('.canvas-node.is-focused');
                allFocusedNodes.forEach(node => node.classList.remove('is-focused'));
                
                // Find canvas wrapper and remove focus mode attribute
                const canvasWrapper = view.contentEl.querySelector('.canvas-wrapper') || 
                                     view.contentEl.querySelector('.canvas')?.parentElement;
                if (canvasWrapper) {
                    canvasWrapper.removeAttribute('data-focus-mode-enabled');
                }
            } catch (e) {
                console.warn('Canvas Player: Error removing spotlight from view', e);
            }
        } else {
            // Fallback: remove from all canvas views if view not provided
            try {
                this.app.workspace.iterateAllLeaves((leaf) => {
                    try {
                        if (!leaf.view || leaf.view.getViewType() !== 'canvas') {
                            return;
                        }
                        
                        const view = leaf.view as ItemView;
                        // Safety check: ensure view and contentEl exist
                        if (!view || !view.contentEl) {
                            return;
                        }
                        
                        const allFocusedNodes = view.contentEl.querySelectorAll('.canvas-node.is-focused');
                        allFocusedNodes.forEach(node => node.classList.remove('is-focused'));
                        
                        const canvasWrapper = view.contentEl.querySelector('.canvas-wrapper') || 
                                             view.contentEl.querySelector('.canvas')?.parentElement;
                        if (canvasWrapper) {
                            canvasWrapper.removeAttribute('data-focus-mode-enabled');
                        }
                    } catch (e) {
                        // Silently skip invalid views
                        console.warn('Canvas Player: Error processing view in removeSpotlight', e);
                    }
                });
            } catch (e) {
                console.warn('Canvas Player: Error iterating leaves in removeSpotlight', e);
            }
        }
    }

    /**
     * Find a canvas node element in the DOM with retry logic and multiple selector strategies.
     * @param view The canvas view
     * @param node The canvas node to find
     * @param maxRetries Maximum number of retry attempts (default: 5)
     * @param initialDelay Initial delay in milliseconds (default: 100)
     * @returns The found node element or null
     */

    async findCanvasNode(view: ItemView, node: CanvasNode, maxRetries: number = 5, initialDelay: number = 100): Promise<HTMLElement | null> {
        // Primary approach: Use Canvas API to get node object, then access its DOM element
        const canvas = (view as any).canvas;
        if (canvas && canvas.nodes) {
            try {
                // canvas.nodes is a Map where keys are node IDs
                // Try both Map.get() method and bracket notation
                const canvasNode = canvas.nodes.get?.(node.id) || canvas.nodes[node.id];
                
                if (canvasNode) {
                    // Try common property names for the DOM element reference
                    const domElement = canvasNode.nodeEl || 
                                     canvasNode.el || 
                                     canvasNode.element || 
                                     canvasNode.domEl ||
                                     canvasNode.containerEl;
                    
                    if (domElement && domElement instanceof HTMLElement) {
                        console.log(`Canvas Player: Found node ${node.id} via Canvas API`);
                        return domElement;
                    } else {
                        console.warn(`Canvas Player: Found canvas node object for ${node.id} but no DOM element reference`);
                    }
                }
            } catch (e) {
                console.warn('Canvas Player: Error accessing canvas.nodes API:', e);
            }
        }

        // Fallback: DOM-based approach with retry logic
        // This handles cases where Canvas API isn't available or node isn't in the map yet
        const selectors = [
            `.canvas-node[data-id="${node.id}"]`,
            `.canvas-node[data-node-id="${node.id}"]`,
            `[data-id="${node.id}"].canvas-node`,
            `[data-node-id="${node.id}"].canvas-node`
        ];

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            // Try each selector strategy
            for (const selector of selectors) {
                const element = view.contentEl.querySelector(selector) as HTMLElement;
                if (element) {
                    console.log(`Canvas Player: Found node ${node.id} using DOM selector "${selector}" on attempt ${attempt + 1}`);
                    return element;
                }
            }

            // Fallback: Try to find by querying all nodes and matching ID
            if (attempt === 0 || attempt === 2) {
                const allNodes = view.contentEl.querySelectorAll('.canvas-node');
                for (const nodeEl of Array.from(allNodes)) {
                    const el = nodeEl as HTMLElement;
                    // Check various ways the ID might be stored in DOM
                    const nodeId = el.getAttribute('data-id') || 
                                  el.getAttribute('data-node-id') ||
                                  (el as any).dataset?.id ||
                                  (el as any).dataset?.nodeId ||
                                  el.id;
                    
                    if (nodeId === node.id) {
                        console.log(`Canvas Player: Found node ${node.id} by iterating DOM nodes on attempt ${attempt + 1}`);
                        return el;
                    }
                }
            }

            // If not found, wait before retrying (exponential backoff)
            if (attempt < maxRetries - 1) {
                const delay = initialDelay * Math.pow(2, attempt);
                console.log(`Canvas Player: Node ${node.id} not found, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                
                // Try Canvas API again after delay (node might have been added to the map)
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
                                console.log(`Canvas Player: Found node ${node.id} via Canvas API on retry ${attempt + 1}`);
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
        // Find the canvas wrapper element
        // Try .canvas-wrapper first, then fall back to .canvas parent
        const canvasWrapper = view.contentEl.querySelector('.canvas-wrapper') || 
                             view.contentEl.querySelector('.canvas')?.parentElement;
        
        if (!canvasWrapper) {
            console.warn('Canvas Player: Could not find canvas wrapper element');
            return;
        }

        // Enable focus mode on the canvas wrapper (keep blur active throughout transition)
        canvasWrapper.setAttribute('data-focus-mode-enabled', 'true');

        // Find the current node DOM element using retry logic
        const targetEl = await this.findCanvasNode(view, node);
        
        if (targetEl) {
            // Remove is-focused from previously focused node (if different)
            if (this.currentFocusedNodeEl && this.currentFocusedNodeEl !== targetEl) {
                this.currentFocusedNodeEl.classList.remove('is-focused');
            }
            
            // Add is-focused class to the current node
            targetEl.classList.add('is-focused');
            this.currentFocusedNodeEl = targetEl;
            console.log(`Canvas Player: Applied is-focused class to node ${node.id}`);
        } else {
            console.warn(`Canvas Player: Could not apply focus to node ${node.id} - element not found`);
            // Clear tracked node if we couldn't find the new one
            this.currentFocusedNodeEl = null;
        }
    }

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

    // ========== Active Session Management Methods ==========

    /**
     * Update status bar display based on active session state.
     */
    updateStatusBar() {
        if (!this.statusBarItem) return;
        
        if (!this.activeSession) {
            this.statusBarItem.hide();
            return;
        }
        
        if (!this.settings.enableTimeboxing) {
            this.statusBarItem.hide();
            return;
        }
        
        this.statusBarItem.show();
        const remainingMs = this.sharedTimer.getRemainingMs();
        const formatted = formatRemainingTime(remainingMs);
        this.statusBarItem.setText(`Canvas Player: ${formatted}`);
    }

    /**
     * Minimize the player (close modal, open mini view).
     */
    async minimizePlayer() {
        if (!this.activeSession) return;
        
        // Close modal (but keep session active)
        if (this.activeModal) {
            this.activeModal.close();
            this.activeModal = null;
        }
        
        // Ensure mini view is open
        await this.ensureMiniViewOpen();
    }

    /**
     * Restore the player (reopen modal).
     */
    async restorePlayer() {
        if (!this.activeSession) return;
        
        // Reopen modal
        const session = this.activeSession;
        const modal = new CanvasPlayerModal(
            this,
            session.currentCanvasFile,
            session.currentCanvasData,
            session.currentNode,
            session.state,
            session.stack,
            session.rootCanvasFile
        );
        this.activeModal = modal;
        modal.open();
    }

    /**
     * Ensure the mini-player view is open in the right sidebar.
     */
    async ensureMiniViewOpen() {
        const leaves = this.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        if (leaves.length === 0) {
            // Open in right sidebar
            const leaf = this.app.workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({
                    type: CANVAS_PLAYER_MINI_VIEW_TYPE,
                    active: true
                });
            }
        } else {
            // Focus existing view
            this.app.workspace.revealLeaf(leaves[0]);
        }
        
        // Refresh mini view
        const miniLeaves = this.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        if (miniLeaves.length > 0) {
            const miniView = miniLeaves[0].view as CanvasPlayerMiniView;
            await miniView.refresh();
        }
    }

    /**
     * Stop the active session.
     */
    async stopActiveSession() {
        if (!this.activeSession) return;
        
        // Save resume session before stopping
        await this.saveResumeSession(this.activeSession.rootCanvasFile.path, {
            rootFilePath: this.activeSession.rootCanvasFile.path,
            currentFilePath: this.activeSession.currentCanvasFile.path,
            currentNodeId: this.activeSession.currentNode.id,
            currentSessionState: { ...this.activeSession.state },
            stack: this.activeSession.stack.map(frame => ({
                filePath: frame.file.path,
                currentNodeId: frame.currentNode.id,
                state: { ...frame.state }
            }))
        });
        
        // Finish and save timer for current node
        if (this.settings.enableTimeboxing && this.sharedTimer.isRunning()) {
            await this.finishTimerForActiveSession();
        }
        
        // Clean up
        this.sharedTimer.abort();
        this.activeSession = null;
        this.activeModal = null;
        
        // Update UI
        this.updateStatusBar();
        const miniLeaves = this.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        miniLeaves.forEach(leaf => {
            const miniView = leaf.view as CanvasPlayerMiniView;
            miniView.refresh();
        });
    }

    /**
     * Navigate back in the session history.
     */
    async navigateBack() {
        if (!this.activeSession || this.activeSession.history.length === 0) return;
        
        const previousNode = this.activeSession.history.pop();
        if (!previousNode) return;
        
        // Finish timer for current node
        if (this.settings.enableTimeboxing && this.sharedTimer.isRunning()) {
            await this.finishTimerForActiveSession();
        }
        
        // Update session
        this.activeSession.currentNode = previousNode;
        
        // Start timer for previous node
        if (this.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }
        
        // Update UI
        await this.updateAllUIs();
    }

    /**
     * Navigate to a specific node (from a choice).
     */
    async navigateToNode(parsedChoice: any, nextNode: CanvasNode) {
        if (!this.activeSession) return;
        
        // Finish timer for current node
        if (this.settings.enableTimeboxing && this.sharedTimer.isRunning()) {
            await this.finishTimerForActiveSession();
        }
        
        // Update state
        LogicEngine.updateState(parsedChoice, this.activeSession.state);
        
        // Push current node to history
        this.activeSession.history.push(this.activeSession.currentNode);
        
        // Check if next node is a canvas file (dive into nested canvas)
        if (nextNode.type === 'file' && nextNode.file && nextNode.file.endsWith('.canvas')) {
            await this.diveIntoCanvasForSession(nextNode);
            return;
        }
        
        // Update to next node
        this.activeSession.currentNode = nextNode;
        
        // Start timer for next node
        if (this.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }
        
        // Update UI
        await this.updateAllUIs();
    }

    /**
     * Navigate return to parent canvas (pop stack).
     */
    async navigateReturnToParent() {
        if (!this.activeSession || this.activeSession.stack.length === 0) {
            await this.stopActiveSession();
            return;
        }
        
        // Finish timer for current node
        if (this.settings.enableTimeboxing && this.sharedTimer.isRunning()) {
            await this.finishTimerForActiveSession();
        }
        
        const frame = this.activeSession.stack.pop();
        if (!frame) {
            await this.stopActiveSession();
            return;
        }
        
        // Restore parent context
        this.activeSession.currentCanvasFile = frame.file;
        this.activeSession.currentCanvasData = frame.data;
        this.activeSession.currentNode = frame.currentNode;
        this.activeSession.state = frame.state;
        this.activeSession.history = [];
        
        // Start timer for restored node
        if (this.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }
        
        // Update UI
        await this.updateAllUIs();
    }

    /**
     * Dive into a nested canvas file.
     */
    private async diveIntoCanvasForSession(fileNode: CanvasNode) {
        if (!this.activeSession) return;
        
        const filePath = fileNode.file;
        if (!filePath) return;
        
        const targetFile = this.app.metadataCache.getFirstLinkpathDest(
            filePath,
            this.activeSession.currentCanvasFile.path
        );
        
        if (!targetFile || targetFile.extension !== 'canvas') {
            new Notice(`Could not find canvas file: ${filePath}`);
            return;
        }
        
        // Push to stack
        this.activeSession.stack.push({
            file: this.activeSession.currentCanvasFile,
            data: this.activeSession.currentCanvasData,
            currentNode: fileNode,
            state: { ...this.activeSession.state }
        });
        
        // Reset state for isolated scope
        this.activeSession.state = {};
        
        // Load new canvas
        this.activeSession.currentCanvasFile = targetFile;
        const content = await this.app.vault.read(targetFile);
        this.activeSession.currentCanvasData = JSON.parse(content);
        
        const startNode = this.getStartNode(this.activeSession.currentCanvasData);
        if (!startNode) {
            new Notice(`Cannot start embedded canvas: Could not find a text card containing "${this.settings.startText}" that points to a playable node.`);
            await this.navigateReturnToParent();
            return;
        }
        
        this.activeSession.currentNode = startNode;
        this.activeSession.history = [];
        
        // Start timer for new node
        if (this.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }
        
        // Update UI
        await this.updateAllUIs();
    }

    /**
     * Start timer for the current node in active session.
     */
    private async startTimerForActiveSession() {
        if (!this.activeSession || !this.settings.enableTimeboxing) return;
        
        const timingData = await loadTimingForNode(
            this.app,
            this.activeSession.currentCanvasFile,
            this.activeSession.currentNode,
            this.activeSession.currentCanvasData
        );
        const defaultMs = this.settings.defaultNodeDurationMinutes * 60 * 1000;
        const durationMs = timingData ? timingData.avgMs : defaultMs;
        
        this.activeSession.timerDurationMs = durationMs;
        this.activeSession.timerStartTimeMs = Date.now();
        this.sharedTimer.start(durationMs);
        
        this.updateStatusBar();
    }

    /**
     * Finish and save timer for current node in active session.
     */
    private async finishTimerForActiveSession() {
        if (!this.activeSession || !this.settings.enableTimeboxing || !this.sharedTimer.isRunning()) {
            return;
        }
        
        const elapsedMs = this.sharedTimer.finish();
        
        // Load existing timing or start fresh
        const existingTiming = await loadTimingForNode(
            this.app,
            this.activeSession.currentCanvasFile,
            this.activeSession.currentNode,
            this.activeSession.currentCanvasData
        );
        
        let newTiming: TimingData;
        if (existingTiming) {
            newTiming = NodeTimerController.updateAverage(
                existingTiming.avgMs,
                existingTiming.samples,
                elapsedMs
            );
        } else {
            newTiming = { avgMs: elapsedMs, samples: 1 };
        }
        
        // Save timing back
        const canvasNeedsSave = await saveTimingForNode(
            this.app,
            this.activeSession.currentCanvasFile,
            this.activeSession.currentNode,
            this.activeSession.currentCanvasData,
            newTiming
        );
        
        if (canvasNeedsSave) {
            const content = JSON.stringify(this.activeSession.currentCanvasData, null, 2);
            await this.app.vault.modify(this.activeSession.currentCanvasFile, content);
        }
    }

    /**
     * Update all UIs (modal if open, mini view, status bar).
     */
    private async updateAllUIs() {
        // Update modal if open
        if (this.activeModal) {
            await this.activeModal.refreshScene();
        }
        
        // Update mini view
        const miniLeaves = this.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        miniLeaves.forEach(leaf => {
            const miniView = leaf.view as CanvasPlayerMiniView;
            miniView.refresh();
        });
        
        // Update status bar
        this.updateStatusBar();
    }
}

class ConfirmResetTimeboxingModal extends Modal {
    plugin: CanvasPlayerPlugin;
    canvasFile: TFile;

    constructor(app: CanvasPlayerPlugin['app'], plugin: CanvasPlayerPlugin, canvasFile: TFile) {
        super(app);
        this.plugin = plugin;
        this.canvasFile = canvasFile;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Reset timeboxing stats?' });

        contentEl.createEl('p', {
            text: 'This will reset all timeboxing statistics for this canvas, including:'
        });

        const list = contentEl.createEl('ul');
        list.createEl('li', { text: 'Current canvas file' });
        list.createEl('li', { text: 'Linked markdown files referenced by nodes in this canvas' });
        list.createEl('li', { text: 'Note: Nested canvas files are not affected and must be reset manually' });

        contentEl.createEl('p', {
            text: 'This action cannot be undone.',
            cls: 'mod-warning'
        });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        
        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText('Reset')
            .setCta()
            .setWarning()
            .onClick(async () => {
                try {
                    const result = await resetTimeboxingRecursive(this.app, this.canvasFile);
                    this.close();
                    const parts: string[] = [];
                    if (result.canvasCount > 0) {
                        parts.push('canvas reset');
                    }
                    if (result.markdownFileCount > 0) {
                        parts.push(`${result.markdownFileCount} markdown file${result.markdownFileCount !== 1 ? 's' : ''} updated`);
                    }
                    const message = parts.length > 0 
                        ? `Reset timeboxing stats: ${parts.join(' and ')}.`
                        : 'Reset timeboxing stats.';
                    new Notice(message);
                } catch (error) {
                    console.error('Failed to reset timeboxing stats', error);
                    new Notice('Failed to reset timeboxing stats. Check console for details.');
                    this.close();
                }
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class CanvasPlayerSettingTab extends PluginSettingTab {
    plugin: CanvasPlayerPlugin;

    constructor(app: CanvasPlayerPlugin['app'], plugin: CanvasPlayerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Player Mode')
            .setDesc('Choose how you want to play the canvas.')
            .addDropdown(dropdown => dropdown
                .addOption('modal', 'Reader Mode (Text Popup)')
                .addOption('camera', 'Camera Mode (Pan & Zoom)')
                .setValue(this.plugin.settings.mode)
                .onChange(async (value) => {
                    this.plugin.settings.mode = value as 'modal' | 'camera';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Start card text')
            .setDesc('Text that identifies the start marker card. This card must point to the actual first playable node (case-insensitive).')
            .addText(text => text
                .setPlaceholder('canvas-start')
                .setValue(this.plugin.settings.startText)
                .onChange(async (value) => {
                    this.plugin.settings.startText = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h2', { text: 'Timeboxing' });

        new Setting(containerEl)
            .setName('Enable timeboxing timer')
            .setDesc('Show a countdown timer for each node based on average completion time.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTimeboxing)
                .onChange(async (value) => {
                    this.plugin.settings.enableTimeboxing = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Default node duration (minutes)')
            .setDesc('Default countdown time for nodes that have not been timed yet.')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(this.plugin.settings.defaultNodeDurationMinutes.toString())
                .onChange(async (value) => {
                    const numValue = parseInt(value, 10);
                    if (!isNaN(numValue) && numValue > 0 && numValue <= 999) {
                        this.plugin.settings.defaultNodeDurationMinutes = numValue;
                        await this.plugin.saveSettings();
                    }
                }));

        containerEl.createEl('h2', { text: 'Start Node Requirement' });
        containerEl.createEl('p', { 
            text: `Your canvas must have a text card containing the start text (e.g., "${this.plugin.settings.startText}"). This card should point to the actual first playable node. The marker card itself will be skipped during playback.` 
        });
    }

}

class CanvasPlayerModal extends Modal {
    private plugin: CanvasPlayerPlugin;
    private timerEl: HTMLElement | null = null;
    private timerUnsubscribe: (() => void) | null = null;

    constructor(plugin: CanvasPlayerPlugin, canvasFile: TFile, canvasData: CanvasData, startNode: CanvasNode, initialState?: GameState, initialStack?: StackFrame[], rootCanvasFile?: TFile) {
        super(plugin.app);
        this.plugin = plugin;
        // Note: activeSession is created by plugin.playCanvasFromNode before opening modal
    }

    async onOpen() { 
        await this.renderScene();
        // Subscribe to timer updates if timeboxing is enabled (timerEl is set in renderScene)
        if (this.plugin.settings.enableTimeboxing && this.timerEl) {
            this.timerUnsubscribe = this.plugin.sharedTimer.subscribe((remainingMs) => {
                this.updateTimerDisplay(remainingMs);
            });
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
        const formatted = formatRemainingTime(remainingMs);
        this.timerEl.setText(formatted);
        if (remainingMs < 0) {
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
                await this.plugin.navigateBack();
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
                await this.plugin.minimizePlayer();
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
                         await this.plugin.navigateReturnToParent();
                    })
                    .buttonEl.addClass('mod-cta');
            } else {
                new ButtonComponent(buttonContainer).setButtonText("End of Path").onClick(async () => {
                    await this.plugin.stopActiveSession();
                    this.close();
                });
            }
        } else {
            validChoices.forEach(choice => {
                const nextNode = session.currentCanvasData.nodes.find(n => n.id === choice.edge.toNode);
                const lbl = choice.parsed.text || "Next";
                new ButtonComponent(buttonContainer).setButtonText(lbl).onClick(async () => {
                    if (nextNode) {
                        await this.plugin.navigateToNode(choice.parsed, nextNode);
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
            this.plugin.zoomToNode(view, session.currentNode);
        }
    }
}

export default CanvasPlayerPlugin;

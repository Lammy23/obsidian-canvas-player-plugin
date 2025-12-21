import { App, Modal, Plugin, Notice, MarkdownRenderer, ButtonComponent, PluginSettingTab, Setting, ItemView, Component, TFile, Menu, debounce, WorkspaceLeaf } from 'obsidian';
import { LogicEngine, GameState } from './logic';
import { CanvasNode, CanvasData, StackFrame } from './types';
import { CanvasPlayerSettings, DEFAULT_SETTINGS, DEFAULT_COMPLEXITY_WEIGHTS, ComplexityWeights } from './settings';
import { ComplexityCalculator } from './complexity';
import { extractNodeInfo, transformNode, convertCardToGroup, convertGroupToCard } from './canvasTransforms';
import { NodeTimerController, TimingData } from './timeboxing';
import { loadTimingForNode, saveTimingForNode } from './timingStorage';
import { PluginData, ResumeSession, ResumeStackFrame, validateResumeSession, restoreStackFromResume } from './resumeStorage';

export default class CanvasPlayerPlugin extends Plugin {
    settings: CanvasPlayerSettings;
    activeHud: HTMLElement | null = null; 
    activeOverlay: HTMLElement | null = null;
    currentSessionState: GameState = {};
    stack: StackFrame[] = [];
    
    // Map to track score elements per view
    scoreElements: Map<ItemView, HTMLElement> = new Map();
    
    // Timer state for Camera Mode
    cameraTimer: NodeTimerController | null = null;
    currentCanvasFile: TFile | null = null;
    currentCanvasData: CanvasData | null = null;
    currentNodeForTimer: CanvasNode | null = null;
    
    // Resume session tracking
    private rootCanvasFile: TFile | null = null; // Track root canvas for saving resume position

    private readonly actionableView = (view: ItemView): view is ItemView & {
        addAction(icon: string, title: string, callback: () => void): void;
    } => typeof (view as ItemView & { addAction?: unknown }).addAction === 'function';

    async onload() {
        await this.loadPluginData();

        this.app.workspace.onLayoutReady(() => {
            this.refreshCanvasViewActions();
        });

        this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
            this.refreshCanvasViewActions();
        }));
        
        // Update score when file changes
        const debouncedUpdate = debounce((file: TFile) => {
             this.updateComplexityScore(file);
        }, 1000, true);

        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file instanceof TFile && file.extension === 'canvas') {
                debouncedUpdate(file);
            }
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
    }

    refreshCanvasViewActions() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() === 'canvas') {
                const view = leaf.view as ItemView;
                
                // Inject Complexity Score if enabled
                if (this.settings.showComplexityScore) {
                    if (!this.scoreElements.has(view)) {
                        // Find the view actions container
                        // @ts-ignore: headerEl is not in the public API but exists on ItemView
                        const actionsContainer = view.headerEl.querySelector('.view-actions');
                        if (actionsContainer) {
                            const scoreEl = createDiv({ cls: 'canvas-complexity-score' });
                            scoreEl.style.marginRight = '10px';
                            scoreEl.style.fontSize = '0.8em';
                            scoreEl.style.color = 'var(--text-muted)';
                            scoreEl.style.alignSelf = 'center';
                            
                            // Prepend to actions container
                            actionsContainer.insertBefore(scoreEl, actionsContainer.firstChild);
                            this.scoreElements.set(view, scoreEl);
                            
                            // Initial update if file is loaded
                            // @ts-ignore: file exists on ItemView but might be missing from type definition in some versions
                            const file = view.file;
                            if (file) {
                                this.updateComplexityScore(file);
                            }
                        }
                    }
                } else {
                    // If disabled, remove any existing score elements
                    const scoreEl = this.scoreElements.get(view);
                    if (scoreEl) {
                        scoreEl.remove();
                        this.scoreElements.delete(view);
                    }
                }

                // Add Player buttons
                if (!this.actionableView(view)) return;
                if ((view as any)._hasCanvasPlayerButton) return;
                view.addAction('play', 'Play from start', () => {
                    this.playActiveCanvas();
                });
                view.addAction('play-circle', 'Play from last', () => {
                    void this.playActiveCanvasFromLast();
                });
                view.addAction('zoom-in', 'Zoom to start', () => {
                    void this.zoomToStartOfActiveCanvas();
                });
                (view as any)._hasCanvasPlayerButton = true;
            }
        });
    }

    async updateComplexityScore(file: TFile) {
        if (!this.settings.showComplexityScore) return;

        // Only update for active canvas views showing this file
        this.app.workspace.iterateAllLeaves(async (leaf) => {
            if (leaf.view.getViewType() === 'canvas' && (leaf.view as any).file?.path === file.path) {
                const view = leaf.view as ItemView;
                const scoreEl = this.scoreElements.get(view);
                if (scoreEl) {
                    try {
                        const content = await this.app.vault.read(file);
                        const data: CanvasData = JSON.parse(content);
                        const metrics = ComplexityCalculator.calculate(data);
                        const score = ComplexityCalculator.computeScore(metrics, this.settings.complexityWeights);
                        scoreEl.setText(`Complexity: ${score}`);
                        scoreEl.title = `Nodes: ${metrics.nodeCount}\nEdges: ${metrics.edgeCount}\nCyclomatic: ${metrics.cyclomaticComplexity}\nBranching: ${metrics.branchingFactor.toFixed(2)}\nLogic Density: ${(metrics.logicDensity * 100).toFixed(0)}%\nVars: ${metrics.variableCount}\nVol: ${metrics.contentVolume}`;
                    } catch (e) {
                        console.error('Failed to calculate complexity', e);
                        scoreEl.setText('Complexity: Err');
                    }
                }
            }
        });
    }

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
        
        // Ensure nested objects are merged correctly
        this.settings.complexityWeights = Object.assign({}, DEFAULT_COMPLEXITY_WEIGHTS, this.settings.complexityWeights);
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
        
        // Refresh scores when settings change
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'canvas') {
            this.updateComplexityScore(activeFile);
        }
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
            new CanvasPlayerModal(this, canvasFile, canvasData, startNode, initialState, initialStack, this.rootCanvasFile).open();
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
        
        // Wait for zoom to finish before applying blur (approx 400ms)
        setTimeout(() => {
            this.applySpotlight(view, startNode);
        }, 400);
    }

    async createHud(view: ItemView, data: CanvasData, currentNode: CanvasNode) {
        if (this.activeHud) this.activeHud.remove();
        if (this.activeOverlay) this.activeOverlay.remove();

        // 1. Create the Blur Overlay
        const overlayEl = view.contentEl.createDiv({ cls: 'canvas-player-blur-overlay' });
        this.activeOverlay = overlayEl;

        // 2. Create HUD
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

                            // 1. Remove spotlight (clear view for movement)
                            this.removeSpotlight();
                            
                            // 2. Move Camera
                            this.zoomToNode(view, nextNode);
                            
                            // 3. Update timer context and restart timer for next node (if enabled)
                            this.currentNodeForTimer = nextNode;
                            if (this.settings.enableTimeboxing) {
                                const timerEl = this.activeHud?.querySelector('.canvas-player-timer') as HTMLElement;
                                if (timerEl && this.currentCanvasData) {
                                    await this.startTimerForNode(view, this.currentCanvasData, nextNode, timerEl);
                                }
                            }
                            
                            // 4. Render next buttons immediately
                            this.renderChoicesInHud(view, data, nextNode, container);
                            
                            // 5. Re-apply spotlight after movement settles
                            setTimeout(() => {
                                this.applySpotlight(view, nextNode);
                            }, 500); // 500ms allows the smooth zoom to finish
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
        setTimeout(() => {
            this.applySpotlight(newView, startNode);
        }, 400);
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
        setTimeout(() => {
            this.applySpotlight(view, frame.currentNode);
        }, 400);
    }

    removeSpotlight() {
        if (this.activeOverlay) {
            // Reset to full blur or hide it? Hiding it looks smoother for movement.
            this.activeOverlay.style.opacity = '0';
            this.activeOverlay.style.clipPath = 'none';
        }
    }

    applySpotlight(view: ItemView, node: CanvasNode) {
        if (!this.activeOverlay) return;

        // Find the DOM element to get its screen position
        const targetEl = view.contentEl.querySelector(`.canvas-node[data-id="${node.id}"]`);
        
        if (targetEl) {
            const rect = targetEl.getBoundingClientRect();
            
            // We need coordinates relative to the overlay (which is fixed to viewport/contentEl)
            // Since overlay is 100% width/height of contentEl, we can usually use rect directly 
            // if we account for the view's offset.
            
            // However, getBoundingClientRect is viewport-relative. 
            // The overlay is `position: absolute` inside `contentEl`.
            // We need to adjust for the contentEl's position on screen.
            const containerRect = view.contentEl.getBoundingClientRect();
            
            const top = rect.top - containerRect.top;
            const left = rect.left - containerRect.left;
            const right = left + rect.width;
            const bottom = top + rect.height;

            // Create the "Hole" using clip-path polygon
            // This draws a box around the screen, then cuts inward to trace the node
            // Note: px values must be appended
            const path = `polygon(
                0% 0%, 
                0% 100%, 
                100% 100%, 
                100% 0%, 
                0% 0%, 
                ${left}px ${top}px, 
                ${right}px ${top}px, 
                ${right}px ${bottom}px, 
                ${left}px ${bottom}px, 
                ${left}px ${top}px
            )`;

            this.activeOverlay.style.clipPath = path;
            this.activeOverlay.style.opacity = '1';
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
}

class CanvasPlayerSettingTab extends PluginSettingTab {
    plugin: CanvasPlayerPlugin;

    constructor(app: App, plugin: CanvasPlayerPlugin) {
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

        new Setting(containerEl)
            .setName('Show complexity score')
            .setDesc('Display the calculated complexity score in the canvas view header.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showComplexityScore)
                .onChange(async (value) => {
                    this.plugin.settings.showComplexityScore = value;
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

        containerEl.createEl('h2', { text: 'Complexity Score Weights' });
        containerEl.createEl('p', { text: 'Adjust how much each metric contributes to the complexity score.' });

        const weights = this.plugin.settings.complexityWeights;
        const weightKeys: (keyof ComplexityWeights)[] = [
            'nodeCount', 'edgeCount', 'cyclomaticComplexity', 
            'branchingFactor', 'logicDensity', 'variableCount', 'contentVolume'
        ];

        for (const key of weightKeys) {
             new Setting(containerEl)
                .setName(this.formatKey(key))
                .addSlider(slider => slider
                    .setLimits(0, 10, 0.1)
                    .setValue(weights[key])
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        weights[key] = value;
                        await this.plugin.saveSettings();
                    }));
        }
        
        new Setting(containerEl)
            .setName('Restore Default Weights')
            .addButton(btn => btn
                .setButtonText('Restore')
                .onClick(async () => {
                    this.plugin.settings.complexityWeights = Object.assign({}, DEFAULT_COMPLEXITY_WEIGHTS);
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }

    formatKey(key: string): string {
        // CamelCase to readable string
        return key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
    }
}

class CanvasPlayerModal extends Modal {
    canvasData: CanvasData;
    currentNode: CanvasNode;
    private history: CanvasNode[] = [];
    private plugin: CanvasPlayerPlugin;
    private canvasFile: TFile;
    private state: GameState = {};
    private stack: StackFrame[] = [];
    private modalTimer: NodeTimerController | null = null;
    private rootCanvasFile: TFile; // Track root canvas for resume saving

    constructor(plugin: CanvasPlayerPlugin, canvasFile: TFile, canvasData: CanvasData, startNode: CanvasNode, initialState?: GameState, initialStack?: StackFrame[], rootCanvasFile?: TFile) {
        super(plugin.app);
        this.plugin = plugin;
        this.canvasFile = canvasFile;
        this.canvasData = canvasData;
        this.currentNode = startNode;
        if (initialState) {
            this.state = { ...initialState };
        }
        if (initialStack) {
            this.stack = initialStack.map(frame => ({
                file: frame.file,
                data: frame.data,
                currentNode: frame.currentNode,
                state: { ...frame.state }
            }));
        }
        this.rootCanvasFile = rootCanvasFile || canvasFile;
    }

    onOpen() { this.renderScene(); }
    async onClose() { 
        // Save resume session before closing
        if (this.rootCanvasFile) {
            const resumeStack: ResumeStackFrame[] = this.stack.map(frame => ({
                filePath: frame.file.path,
                currentNodeId: frame.currentNode.id,
                state: { ...frame.state }
            }));

            const session: ResumeSession = {
                rootFilePath: this.rootCanvasFile.path,
                currentFilePath: this.canvasFile.path,
                currentNodeId: this.currentNode.id,
                currentSessionState: { ...this.state },
                stack: resumeStack
            };

            await this.plugin.saveResumeSession(this.rootCanvasFile.path, session);
        }

        // Abort timer on close (don't save)
        if (this.modalTimer) {
            this.modalTimer.abort();
            this.modalTimer = null;
        }
        this.contentEl.empty(); 
    }

    async renderScene() {
        const { contentEl } = this;
        contentEl.empty();
        const container = contentEl.createDiv({ cls: 'canvas-player-container' });
        const controls = container.createDiv({ cls: 'canvas-player-controls' });
        const textContainer = container.createDiv({ cls: 'canvas-player-text' });
        
        new ButtonComponent(controls)
            .setButtonText('Back')
            .setDisabled(this.history.length === 0)
            .onClick(async () => {
                // Abort timer on Back (don't save)
                if (this.modalTimer) {
                    this.modalTimer.abort();
                    this.modalTimer = null;
                }
                
                const previous = this.history.pop();
                if (previous) {
                    this.currentNode = previous;
                    await this.renderScene();
                }
            });

        new ButtonComponent(controls)
            .setButtonText('Edit')
            .onClick(() => {
                // Abort timer on Edit (don't save)
                if (this.modalTimer) {
                    this.modalTimer.abort();
                    this.modalTimer = null;
                }
                void this.openNodeForEditing();
            });
        
        // Timer display (top-right) - created after buttons so it appears on the right, only if enabled
        let timerEl: HTMLElement | null = null;
        if (this.plugin.settings.enableTimeboxing) {
            timerEl = controls.createDiv({ cls: 'canvas-player-timer' });
            timerEl.setText('--:--');
            // Start timer for current node
            await this.startTimerForNode(timerEl);
        }

        // Handle File Nodes (Display Content)
        if (this.currentNode.type === 'file' && this.currentNode.file) {
            const file = this.app.metadataCache.getFirstLinkpathDest(this.currentNode.file, this.canvasFile.path);
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
                    // Or we could just say "Nested Canvas: Name"
                    textContainer.createEl('h3', { text: `Nested Canvas: ${file.basename}` });
                }
            } else {
                textContainer.setText(`File not found: ${this.currentNode.file}`);
            }
        } else {
            await MarkdownRenderer.render(
                this.app,
                this.currentNode.text || "...",
                textContainer,
                "/",
                this as unknown as Component
            );
        }

        const rawChoices = this.canvasData.edges.filter(edge => edge.fromNode === this.currentNode.id);
        
        // 1. Pre-parse and check for missing variables
        const parsedChoices = rawChoices.map(edge => {
            const parsed = LogicEngine.parseLabel(edge.label || "Next");
            return { edge, parsed };
        });

        const missingVars = new Set<string>();
        parsedChoices.forEach(item => {
            const missing = LogicEngine.getMissingVariables(item.parsed, this.state);
            missing.forEach(v => missingVars.add(v));
        });

        const buttonContainer = container.createDiv({ cls: 'canvas-player-choices' });

        if (missingVars.size > 0) {
            const promptContainer = container.createDiv({ cls: 'canvas-player-prompt' });
            promptContainer.createEl('h3', { text: 'Set values for missing variables:' });

            missingVars.forEach(variable => {
                if (this.state[variable] === undefined) this.state[variable] = false;

                new Setting(promptContainer)
                    .setName(variable)
                    .addToggle(toggle => toggle
                        .setValue(this.state[variable])
                        .onChange(val => this.state[variable] = val)
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

        const validChoices = parsedChoices.filter(item => LogicEngine.checkConditions(item.parsed, this.state));

        if (validChoices.length === 0) {
            if (this.stack.length > 0) {
                new ButtonComponent(buttonContainer)
                    .setButtonText("Return to Parent Canvas")
                    .setCta()
                    .onClick(async () => {
                         await this.finishTimerForCurrentNode();
                         await this.returnToParent();
                    })
                    .buttonEl.addClass('mod-cta');
            } else {
                new ButtonComponent(buttonContainer).setButtonText("End of Path").onClick(async () => {
                    await this.finishTimerForCurrentNode();
                    this.close();
                });
            }
        } else {
            validChoices.forEach(choice => {
                const nextNode = this.canvasData.nodes.find(n => n.id === choice.edge.toNode);
                const lbl = choice.parsed.text || "Next";
                new ButtonComponent(buttonContainer).setButtonText(lbl).onClick(async () => {
                    if (nextNode) {
                        // Finish and save timer for current node
                        await this.finishTimerForCurrentNode();
                        
                        LogicEngine.updateState(choice.parsed, this.state);
                        
                        // Check if next node is a Canvas file
                        if (nextNode.type === 'file' && nextNode.file && nextNode.file.endsWith('.canvas')) {
                            await this.diveIntoCanvas(nextNode);
                            return;
                        }

                        this.history.push(this.currentNode);
                        this.currentNode = nextNode;
                        await this.renderScene();
                    }
                });
            });
        }
    }

    async startTimerForNode(timerEl: HTMLElement) {
        // Only start timer if timeboxing is enabled
        if (!this.plugin.settings.enableTimeboxing) {
            return;
        }

        // Abort any existing timer
        if (this.modalTimer) {
            this.modalTimer.abort();
            this.modalTimer = null;
        }

        // Load timing data for this node
        const timingData = await loadTimingForNode(this.app, this.canvasFile, this.currentNode, this.canvasData);
        const defaultMs = this.plugin.settings.defaultNodeDurationMinutes * 60 * 1000;
        const initialMs = timingData ? timingData.avgMs : defaultMs;

        // Create and start timer
        this.modalTimer = new NodeTimerController();
        this.modalTimer.start(initialMs, timerEl);
    }

    async finishTimerForCurrentNode(): Promise<void> {
        // Only finish timer if timeboxing is enabled
        if (!this.plugin.settings.enableTimeboxing || !this.modalTimer) {
            return;
        }

        const elapsedMs = this.modalTimer.finish();
        
        // Load existing timing or start fresh
        const existingTiming = await loadTimingForNode(
            this.app,
            this.canvasFile,
            this.currentNode,
            this.canvasData
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
            this.canvasFile,
            this.currentNode,
            this.canvasData,
            newTiming
        );

        // If canvas needs save (text nodes or fallback), write it
        if (canvasNeedsSave) {
            const content = JSON.stringify(this.canvasData, null, 2);
            await this.app.vault.modify(this.canvasFile, content);
        }

        this.modalTimer = null;
    }

    private async diveIntoCanvas(fileNode: CanvasNode) {
        // Finish and save timer for current file node before diving
        await this.finishTimerForCurrentNode();
        
        const filePath = fileNode.file;
        if (!filePath) return;

        const targetFile = this.app.metadataCache.getFirstLinkpathDest(filePath, this.canvasFile.path);
        
        if (!targetFile || targetFile.extension !== 'canvas') {
             new Notice(`Could not find canvas file: ${filePath}`);
             return;
        }

        // Push to stack
        this.stack.push({
            file: this.canvasFile,
            data: this.canvasData,
            currentNode: fileNode,
            state: Object.assign({}, this.state)
        });

        // Reset state for isolated scope
        this.state = {};

        // Load new file
        this.canvasFile = targetFile;
        const content = await this.app.vault.read(targetFile);
        this.canvasData = JSON.parse(content);
        
        const startNode = this.plugin.getStartNode(this.canvasData);

        if (startNode) {
            this.currentNode = startNode;
            // Clear history for the new canvas context (so back button doesn't jump across files weirdly)
            // Or we can keep it if we want to back out of the file? 
            // Current stack logic handles returning. So clearing history for this "session" is fine.
            this.history = []; 
            await this.renderScene();
        } else {
             new Notice(`Cannot start embedded canvas: Could not find a text card containing "${this.plugin.settings.startText}" that points to a playable node.`);
             await this.returnToParent();
        }
    }

    private async returnToParent() {
        // Finish and save timer before returning (Return to parent is a save action)
        await this.finishTimerForCurrentNode();
        
        const frame = this.stack.pop();
        if (!frame) {
            this.close();
            return;
        }

        this.canvasFile = frame.file;
        this.canvasData = frame.data;
        this.currentNode = frame.currentNode;
        this.state = frame.state;
        this.history = []; // Reset history or restore? frame doesn't have history. 
        
        await this.renderScene();
    }

    private async openNodeForEditing() {
        this.close();
        const leaf = this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf(true);
        if (!leaf) return;

        await leaf.openFile(this.canvasFile);
        const view = leaf.view;

        if (view instanceof ItemView && view.getViewType() === 'canvas') {
            this.plugin.zoomToNode(view, this.currentNode);
        }
    }
}

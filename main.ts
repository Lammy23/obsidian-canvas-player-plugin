import { App, Modal, Plugin, Notice, MarkdownRenderer, ButtonComponent, PluginSettingTab, Setting, ItemView, Component, TFile, Menu, debounce, WorkspaceLeaf, TAbstractFile } from 'obsidian';
import { LogicEngine, GameState } from './logic';
import { CanvasNode, CanvasData, StackFrame } from './types';
import { CanvasPlayerSettings, DEFAULT_SETTINGS } from './settings';
import { extractNodeInfo, transformNode, convertCardToGroup, convertGroupToCard } from './canvasTransforms';
import { NodeTimerController, TimingData } from './timeboxing';
import { loadTimingForNode, saveTimingForNode } from './timingStorage';
import { PluginData, ResumeSession, ResumeStackFrame, PersistedActiveSession, validateResumeSession, restoreStackFromResume } from './resumeStorage';
import { resetTimeboxingRecursive } from './timeboxingReset';
import { SharedCountdownTimer, formatRemainingTime } from './sharedCountdownTimer';
import { ActiveSession, createActiveSession, cloneActiveSession } from './playerSession';
import { CanvasPlayerMiniView, CANVAS_PLAYER_MINI_VIEW_TYPE } from './miniPlayerView';
import { getOrCreateDeviceId } from './deviceId';
import { updateRobustAverage } from './timingStats';
import { calculatePoints, getPointsMessage } from './rewardCurve';
import { EconomyData, DEFAULT_ECONOMY_DATA, calculateBalance, recordEarn } from './economy';
import { getShopItem } from './shopCatalog';

export class CanvasPlayerPlugin extends Plugin {
    settings: CanvasPlayerSettings;
    economy: EconomyData = { ...DEFAULT_ECONOMY_DATA };
    activeHud: HTMLElement | null = null;
    activeOverlay: HTMLElement | null = null;
    currentSessionState: GameState = {};
    stack: StackFrame[] = [];

    // Map to track reset stats button elements per view
    resetStatsElements: Map<ItemView, HTMLElement> = new Map();

    // Timer state for Camera Mode (legacy, deprecated - camera mode now uses activeSession and sharedTimer)
    // Kept for backward compatibility but no longer used in active code paths
    cameraTimer: NodeTimerController | null = null;
    currentCanvasFile: TFile | null = null;
    currentCanvasData: CanvasData | null = null;
    currentNodeForTimer: CanvasNode | null = null;

    // Resume session tracking
    private rootCanvasFile: TFile | null = null; // Track root canvas for saving resume position

    // Active session management (for minimize/restore)
    activeSession: ActiveSession | null = null;
    activeSessionMode: 'modal' | 'camera' | null = null;
    sharedTimer: SharedCountdownTimer = new SharedCountdownTimer();
    activeModal: CanvasPlayerModal | null = null; // Track if modal is open
    cameraModeView: ItemView | null = null; // Track active camera mode view for restore
    statusBarItem: HTMLElement | null = null; // Status bar timer item
    statusBarUnsubscribe: (() => void) | null = null; // Timer subscription for status bar
    cameraModeTimerUnsubscribe: (() => void) | null = null; // Timer subscription for camera mode HUD

    // Track currently focused node element for efficient blur transitions
    private currentFocusedNodeEl: HTMLElement | null = null;

    // Device ID for cross-device session ownership
    private deviceId: string = '';

    /**
     * Get the device ID (for economy transactions).
     */
    getDeviceId(): string {
        return this.deviceId;
    }

    /**
     * Get the TFile for the active session state in the vault root.
     * We use a vault file because creation/deletion syncs faster than data.json modification.
     */
    private getSessionStateFile(): TFile | null {
        const file = this.app.vault.getAbstractFileByPath("canvas-session-state.json");
        return file instanceof TFile ? file : null;
    }

    /**
     * Get the file used to store resume data in the vault.
     */
    private getResumeDataFile(): TFile | null {
        const file = this.app.vault.getAbstractFileByPath("canvas-player-resume-data.json");
        return file instanceof TFile ? file : null;
    }

    /**
     * Load all resume sessions from the vault file.
     */
    private async loadResumeDataFromVault(): Promise<Record<string, ResumeSession>> {
        const file = this.getResumeDataFile();
        if (!file) return {};
        try {
            const content = await this.app.vault.read(file);
            return JSON.parse(content);
        } catch (e) {
            console.error("Canvas Player: Failed to load resume data", e);
            return {};
        }
    }

    /**
     * Save all resume sessions to the vault file.
     */
    private async saveResumeDataToVault(data: Record<string, ResumeSession>): Promise<void> {
        const file = this.getResumeDataFile();
        const content = JSON.stringify(data, null, 2);
        
        try {
            if (file) {
                await this.app.vault.modify(file, content);
            } else {
                await this.app.vault.create("canvas-player-resume-data.json", content);
            }
        } catch (e) {
            console.error("Canvas Player: Failed to save resume data", e);
        }
    }

    // Track last applied activeSessionState timestamp to avoid redundant reloads
    private lastAppliedSessionStateTimestamp: number = 0;

    // Track whether we've ever seen a persisted session (so we can react when it gets cleared remotely)
    private lastSeenHadPersistedSession: boolean = false;
    private lastSeenPersistedOwnerDeviceId: string | null = null;

    // Debounced reload handler for reactive sync
    private debouncedReloadSessionState: ReturnType<typeof debounce<[], Promise<void>>> | null = null;

    private readonly actionableView = (view: ItemView): view is ItemView & {
        addAction(icon: string, title: string, callback: () => void): void;
    } => typeof (view as ItemView & { addAction?: unknown }).addAction === 'function';

    async onload() {
        // Initialize device ID (must be done before loadPluginData to check ownership)
        this.deviceId = getOrCreateDeviceId(this.manifest.id);

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

        this.app.workspace.onLayoutReady(async () => {
            // Restore active session state (timer persistence) if present
            if (this.settings.enableTimeboxing) {
                await this.restoreActiveSessionState();
            }
            this.refreshCanvasViewActions();

            // Set up reactive sync watcher
            this.setupReactiveSyncWatcher();
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

        this.addCommand({
            id: 'canvas-player-takeover',
            name: 'Take over session',
            checkCallback: (checking: boolean) => {
                if (this.activeSession) {
                    if (!checking) void this.takeOverSession();
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
        // Clean up shared timer
        this.sharedTimer.abort();

        // Unsubscribe status bar
        if (this.statusBarUnsubscribe) {
            this.statusBarUnsubscribe();
            this.statusBarUnsubscribe = null;
        }

        // Unsubscribe camera mode timer
        if (this.cameraModeTimerUnsubscribe) {
            this.cameraModeTimerUnsubscribe();
            this.cameraModeTimerUnsubscribe = null;
        }

        // Close active modal if any
        if (this.activeModal) {
            this.activeModal.close();
            this.activeModal = null;
        }

        // Clean up camera mode
        this.activeHud?.remove();
        this.activeOverlay?.remove();
        this.removeSpotlight();

        // Clear active session
        this.activeSession = null;
        this.cameraModeView = null;

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
        
        // Initialize default structure
        const pluginData: PluginData = rawData as PluginData || {
            settings: DEFAULT_SETTINGS,
            resumeSessions: {},
            economy: DEFAULT_ECONOMY_DATA
        };

        this.settings = Object.assign({}, DEFAULT_SETTINGS, pluginData.settings || {});
        this.economy = pluginData.economy || { ...DEFAULT_ECONOMY_DATA };
        
        // Clean up legacy settings
        if ('showComplexityScore' in this.settings) delete (this.settings as any).showComplexityScore;
        if ('complexityWeights' in this.settings) delete (this.settings as any).complexityWeights;
    }

    async savePluginData(): Promise<void> {
        const currentData = (await this.loadData()) as PluginData | null;
        const pluginData: PluginData = {
            settings: this.settings,
            resumeSessions: currentData?.resumeSessions || {},
            activeSessionState: currentData?.activeSessionState,
            economy: this.economy
        };
        await this.saveData(pluginData);

        // Refresh UI based on new settings
        this.refreshCanvasViewActions();
    }

    async saveResumeSession(rootFilePath: string, session: ResumeSession): Promise<void> {
        // Load latest from vault (to preserve other canvases' resume data)
        const currentSessions = await this.loadResumeDataFromVault();
        
        // Update specific session
        currentSessions[rootFilePath] = session;
        
        // Save back to vault
        await this.saveResumeDataToVault(currentSessions);
    }

    async getResumeSession(rootFilePath: string): Promise<ResumeSession | null> {
        // Read directly from vault file for freshest data
        const currentSessions = await this.loadResumeDataFromVault();
        return currentSessions[rootFilePath] || null;
    }

    async clearResumeSession(rootFilePath: string): Promise<void> {
        const currentSessions = await this.loadResumeDataFromVault();
        
        if (rootFilePath in currentSessions) {
            const { [rootFilePath]: _, ...remainingSessions } = currentSessions;
            await this.saveResumeDataToVault(remainingSessions);
        }
    }

    /**
     * Save the current active session state to a vault file.
     * Uses "Delete + Create" strategy to force instant syncing for every step.
     */
    private async saveActiveSessionState(forceOwnership: boolean = false): Promise<void> {
        // If timeboxing disabled or no session, ensure file is gone
        if (!this.settings.enableTimeboxing || !this.activeSession || !this.activeSessionMode) {
            await this.clearActiveSessionState();
            return;
        }

        const file = this.getSessionStateFile();
        let currentPersisted: PersistedActiveSession | null = null;
        
        // Read existing state to check ownership
        if (file) {
            try {
                const content = await this.app.vault.read(file);
                currentPersisted = JSON.parse(content);
            } catch (e) {
                // Ignore read errors
            }
        }

        // Check ownership
        if (currentPersisted && !forceOwnership) {
            if (!this.isOwnerOfPersistedSession(currentPersisted)) {
                console.log('Canvas Player: Cannot save session state - not the owner device');
                return;
            }
        }

        const now = Date.now();
        const persisted: PersistedActiveSession = {
            mode: this.activeSessionMode,
            rootFilePath: this.activeSession.rootCanvasFile.path,
            currentFilePath: this.activeSession.currentCanvasFile.path,
            currentNodeId: this.activeSession.currentNode.id,
            state: { ...this.activeSession.state },
            stack: this.activeSession.stack.map(frame => ({
                filePath: frame.file.path,
                currentNodeId: frame.currentNode.id,
                state: { ...frame.state }
            })),
            historyNodeIds: this.activeSession.history.map(n => n.id),
            timerStartTimeMs: this.activeSession.timerStartTimeMs ?? now,
            timerDurationMs: this.activeSession.timerDurationMs,
            ownerDeviceId: forceOwnership ? this.deviceId : (currentPersisted?.ownerDeviceId || this.deviceId),
            updatedAtMs: now,
            updatedByDeviceId: this.deviceId
        };

        const jsonContent = JSON.stringify(persisted, null, 2);

        // NUCLEAR SAVE: Delete then Create to force instant sync
        try {
            if (file) {
                await this.app.vault.delete(file);
            }
            // Create immediately recreates it
            await this.app.vault.create("canvas-session-state.json", jsonContent);
            
            this.lastAppliedSessionStateTimestamp = now;
        } catch (e) {
            console.error("Canvas Player: Failed to write session file", e);
        }
    }

    private async clearActiveSessionState(): Promise<void> {
        const file = this.getSessionStateFile();
        if (!file) return;

        try {
            // Check ownership before deleting
            const content = await this.app.vault.read(file);
            const currentPersisted = JSON.parse(content) as PersistedActiveSession;
            
            if (!this.isOwnerOfPersistedSession(currentPersisted)) {
                console.log('Canvas Player: Cannot clear session state - not the owner device');
                return;
            }
            
            // DELETE the file - this propagates instantly via Obsidian Sync
            await this.app.vault.delete(file);
        } catch (e) {
            console.warn("Canvas Player: Failed to clear session file", e);
        }
    }

    /**
     * Restore active session state from the vault file.
     * Restores timer as running while the app was closed and opens mini view.
     * Does not automatically open modal/HUD (treated as minimized by default).
     */
    private async restoreActiveSessionState(): Promise<boolean> {
        if (!this.settings.enableTimeboxing) return false;

        const file = this.getSessionStateFile();
        if (!file) return false;

        let persisted: PersistedActiveSession | null = null;
        try {
            const content = await this.app.vault.read(file);
            persisted = JSON.parse(content);
        } catch (e) {
            console.error("Canvas Player: Failed to read active session file", e);
            return false;
        }

        if (!persisted) return false;

        try {
            const rootFile = this.app.vault.getAbstractFileByPath(persisted.rootFilePath);
            if (!(rootFile instanceof TFile) || rootFile.extension !== 'canvas') {
                throw new Error(`Root canvas file not found: ${persisted.rootFilePath}`);
            }
            const currentFile = this.app.vault.getAbstractFileByPath(persisted.currentFilePath);
            if (!(currentFile instanceof TFile) || currentFile.extension !== 'canvas') {
                throw new Error(`Current canvas file not found: ${persisted.currentFilePath}`);
            }

            const content = await this.app.vault.read(currentFile);
            const canvasData: CanvasData = JSON.parse(content);
            const currentNode = canvasData.nodes.find(n => n.id === persisted.currentNodeId);
            if (!currentNode) {
                throw new Error(`Node not found: ${persisted.currentNodeId}`);
            }

            const stack = await restoreStackFromResume(this.app, persisted.stack);

            const history: CanvasNode[] = [];
            for (const nodeId of persisted.historyNodeIds) {
                const node = canvasData.nodes.find(n => n.id === nodeId);
                if (node) history.push(node);
            }

            this.activeSession = {
                rootCanvasFile: rootFile,
                currentCanvasFile: currentFile,
                currentCanvasData: canvasData,
                currentNode,
                state: { ...persisted.state },
                stack,
                history,
                timerDurationMs: persisted.timerDurationMs,
                timerStartTimeMs: persisted.timerStartTimeMs
            };
            this.activeSessionMode = persisted.mode;

            // Handle legacy ownership
            if (!persisted.ownerDeviceId) {
                 this.lastAppliedSessionStateTimestamp = Date.now();
            } else {
                this.lastAppliedSessionStateTimestamp = persisted.updatedAtMs || Date.now();
            }

            // Restore running timer
            const mode: 'countdown' | 'countup' = persisted.timerDurationMs > 0 ? 'countdown' : 'countup';
            this.sharedTimer.restoreFromPersisted(persisted.timerStartTimeMs, persisted.timerDurationMs, mode);

            this.updateStatusBar();
            await this.ensureMiniViewOpen();
            await this.updateAllUIs();

            return true;
        } catch (e) {
            console.error('Canvas Player: failed to restore active session state', e);
            new Notice('Canvas Player: Could not restore timer session.');
            return false;
        }
    }

    /**
     * Check if this device is the owner of a persisted session.
     * Handles backward compatibility: if ownership fields are missing, assume we're the owner.
     */
    private isOwnerOfPersistedSession(persisted: PersistedActiveSession): boolean {
        // Backward compatibility: if ownership fields are missing, treat as if we're the owner
        if (!persisted.ownerDeviceId) {
            return true;
        }
        return persisted.ownerDeviceId === this.deviceId;
    }

    /**
     * Public method to check if this device is the owner of the current session.
     * Used by UI components to decide whether to show "Take Over" button.
     */
    async isOwnerOfCurrentSession(): Promise<boolean> {
        if (!this.activeSession) return true; // No session = can be owner
        
        const file = this.getSessionStateFile();
        if (!file) return true; // No persisted state file = we can be owner (local only)

        try {
            const content = await this.app.vault.read(file);
            const persisted = JSON.parse(content) as PersistedActiveSession;
            return this.isOwnerOfPersistedSession(persisted);
        } catch (e) {
            console.error("Canvas Player: Failed to read session file for ownership check", e);
            return true; // Default to allowing control on error to prevent lockout
        }
    }

    /**
     * Check if this device can control the active session (is owner).
     * Shows a notice if not the owner.
     * Note: This is a synchronous check that uses cached data. For accurate checks, use async version.
     * @returns true if can control, false if readonly
     */
    private assertCanControlOrNotify(): boolean {
        if (!this.activeSession) return true; // No session = can control (will create new)

        // Try to get persisted state synchronously (may not be available)
        // We'll do a proper async check in saveActiveSessionState
        // This is just a quick guard for UI actions
        return true; // Let saveActiveSessionState handle the actual ownership check
    }

    /**
     * Async check if this device can control the active session (is owner).
     * @returns true if can control, false if readonly
     */
    private async assertCanControlAsync(): Promise<boolean> {
        if (!this.activeSession) return true; 

        const file = this.getSessionStateFile();
        if (file) {
            try {
                const content = await this.app.vault.read(file);
                const persisted = JSON.parse(content) as PersistedActiveSession;
                
                if (!this.isOwnerOfPersistedSession(persisted)) {
                    new Notice('Canvas Player: Session is read-only. Click "Take over" to control it.');
                    return false;
                }
            } catch (e) {
                // error reading
            }
        }
        return true;
    }

    /**
     * Take over the active session (become the owner).
     */
    async takeOverSession(): Promise<void> {
        if (!this.activeSession) {
            new Notice('Canvas Player: No active session to take over.');
            return;
        }

        // Force ownership by writing with forceOwnership=true
        await this.saveActiveSessionState(true);

        new Notice('Canvas Player: You now control this session.');

        // Refresh UI to update readonly/takeover button
        await this.updateAllUIs();
    }

    /**
     * Set up reactive sync watcher to detect when vault file changes via Obsidian Sync.
     */
    private setupReactiveSyncWatcher(): void {
        this.debouncedReloadSessionState = debounce(async () => {
            await this.reloadSessionStateIfNewer();
        }, 300, true);

        // Watch for changes to our specific session file
        const sessionFileName = "canvas-session-state.json";

        const handleFileChange = (file: TAbstractFile) => {
            if (file.path === sessionFileName) {
                if (this.debouncedReloadSessionState) this.debouncedReloadSessionState();
            }
        };

        this.registerEvent(this.app.vault.on('modify', handleFileChange));
        this.registerEvent(this.app.vault.on('delete', handleFileChange));
        this.registerEvent(this.app.vault.on('create', handleFileChange));

        // Keep polling as backup
        this.registerInterval(window.setInterval(async () => {
            if (!this.settings.enableTimeboxing) return;
            await this.reloadSessionStateIfNewer();
        }, 2000));
    }

    /**
     * Reload and apply session state if a newer version exists (or if file was deleted).
     */
    private async reloadSessionStateIfNewer(): Promise<void> {
        if (!this.settings.enableTimeboxing) return;

        let file = this.getSessionStateFile();
        
        // --- GRACE PERIOD LOGIC ---
        // If file is missing, wait 1s and check again. 
        // This handles the "Delete+Create" update strategy without killing the session.
        if (!file) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            file = this.getSessionStateFile(); // Check again
        }
        // ---------------------------

        let persisted: PersistedActiveSession | null = null;

        if (file) {
            try {
                const content = await this.app.vault.read(file);
                persisted = JSON.parse(content);
            } catch (e) {
                console.warn("Canvas Player: Error reading sync file", e);
                return;
            }
        }

        // Case 1: Remote Deletion (File is truly gone after grace period)
        if (!persisted) {
            const shouldClearLocal =
                this.lastSeenHadPersistedSession ||
                (this.activeSession && !await this.isOwnerOfCurrentSession());

            if (shouldClearLocal && this.activeSession) {
                console.log("Canvas Player: Session file deleted remotely. Stopping local session.");
                this.activeSession = null;
                this.activeSessionMode = null;
                this.sharedTimer.abort();
                this.updateStatusBar();
                await this.updateAllUIs();
            }

            this.lastSeenHadPersistedSession = false;
            this.lastSeenPersistedOwnerDeviceId = null;
            this.lastAppliedSessionStateTimestamp = 0;
            return;
        }

        // Case 2: Remote Update (File exists)
        this.lastSeenHadPersistedSession = true;
        this.lastSeenPersistedOwnerDeviceId = persisted.ownerDeviceId ?? null;

        if (persisted.updatedAtMs <= this.lastAppliedSessionStateTimestamp) {
            return; 
        }

        if (this.isOwnerOfPersistedSession(persisted)) {
            this.lastAppliedSessionStateTimestamp = persisted.updatedAtMs;
            return;
        }

        try {
            await this.restoreActiveSessionState();
            this.lastAppliedSessionStateTimestamp = persisted.updatedAtMs;
        } catch (e) {
            console.error('Canvas Player: Failed to reload session state from sync', e);
        }
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
                timerDurationMs = timingData && timingData.avgMs > 0 ? timingData.avgMs : 0;
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
            this.activeSessionMode = 'modal';

            // Start shared timer if timeboxing is enabled
            if (this.settings.enableTimeboxing) {
                await this.startTimerForActiveSession();
            }

            // Update status bar
            this.updateStatusBar();

            // Auto-open mini view
            await this.ensureMiniViewOpen();

            // Open modal
            const modal = new CanvasPlayerModal(this, canvasFile, canvasData, startNode, initialState, initialStack, rootFile);
            this.activeModal = modal;
            modal.open();
        } else {
            // For camera mode, create active session (similar to modal mode)
            const rootFile = this.rootCanvasFile ?? canvasFile;
            let timerDurationMs = 0;

            if (this.settings.enableTimeboxing) {
                const timingData = await loadTimingForNode(this.app, canvasFile, startNode, canvasData);
                timerDurationMs = timingData && timingData.avgMs > 0 ? timingData.avgMs : 0;
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
            this.activeSessionMode = 'camera';

            // Start shared timer if timeboxing is enabled
            if (this.settings.enableTimeboxing) {
                await this.startTimerForActiveSession();
            }

            // Update status bar
            this.updateStatusBar();

            // Auto-open mini view
            await this.ensureMiniViewOpen();

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

        // activeSession is created by playCanvasFromNode before calling this method
        if (!this.activeSession) {
            console.error('Canvas Player: activeSession not set before startCameraMode');
            return;
        }

        // Store view reference for restore
        this.cameraModeView = view;

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
            const remainingMs = this.sharedTimer.getRemainingMs();
            const mode = this.sharedTimer.getMode();
            timerEl.setText(formatRemainingTime(remainingMs, mode));

            // Subscribe to timer updates
            if (this.cameraModeTimerUnsubscribe) {
                this.cameraModeTimerUnsubscribe();
            }
            this.cameraModeTimerUnsubscribe = this.sharedTimer.subscribe((remainingMs) => {
                if (timerEl) {
                    const mode = this.sharedTimer.getMode();
                    const formatted = formatRemainingTime(remainingMs, mode);
                    timerEl.setText(formatted);
                    // Only show negative styling in countdown mode
                    if (mode === 'countdown' && remainingMs < 0) {
                        timerEl.addClass('canvas-player-timer-negative');
                    } else {
                        timerEl.removeClass('canvas-player-timer-negative');
                    }
                }
            });
        }

        // Minimize button
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

    /**
     * @deprecated Legacy timer method - camera mode now uses activeSession and sharedTimer.
     * Kept for backward compatibility but no longer used.
     */
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
        // Legacy method: use countdown if timing exists, otherwise use a default (5 min) for backward compatibility
        // Note: This is deprecated - new code uses startTimerForActiveSession
        const defaultMs = 5 * 60 * 1000; // 5 minutes fallback for legacy code
        const initialMs = timingData && timingData.avgMs > 0 ? timingData.avgMs : defaultMs;

        // Create and start timer
        this.cameraTimer = new NodeTimerController();
        this.cameraTimer.start(initialMs, timerEl);
    }

    /**
     * @deprecated Legacy timer method - camera mode now uses activeSession and sharedTimer.
     * Kept for backward compatibility but no longer used.
     */
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

        // Update timing using robust average (even in deprecated method for consistency)
        const newTiming = updateRobustAverage(existingTiming, elapsedMs);

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
        if (this.activeSession) {
            const resumeStack: ResumeStackFrame[] = this.activeSession.stack.map(frame => ({
                filePath: frame.file.path,
                currentNodeId: frame.currentNode.id,
                state: { ...frame.state }
            }));

            const session: ResumeSession = {
                rootFilePath: this.activeSession.rootCanvasFile.path,
                currentFilePath: this.activeSession.currentCanvasFile.path,
                currentNodeId: this.activeSession.currentNode.id,
                currentSessionState: { ...this.activeSession.state },
                stack: resumeStack
            };

            await this.saveResumeSession(this.activeSession.rootCanvasFile.path, session);
        }

        // Stopping should NOT affect node averages
        this.abortTimerForActiveSession();

        // Clean up timer subscription
        if (this.cameraModeTimerUnsubscribe) {
            this.cameraModeTimerUnsubscribe();
            this.cameraModeTimerUnsubscribe = null;
        }

        // Abort shared timer
        this.sharedTimer.abort();

        // Remove spotlight from all views
        this.removeSpotlight();

        this.activeHud?.remove();
        this.activeOverlay?.remove();
        this.activeHud = null;
        this.activeOverlay = null;
        this.cameraModeView = null;
        this.activeSession = null;
        this.activeSessionMode = null;

        // Clear persisted active session state
        await this.clearActiveSessionState();

        // Update UI
        this.updateStatusBar();

        // Refresh mini view to show empty state
        const miniLeaves = this.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        miniLeaves.forEach(leaf => {
            const miniView = leaf.view as CanvasPlayerMiniView;
            miniView.refresh();
        });
    }

    async renderChoicesInHud(view: ItemView, data: CanvasData, currentNode: CanvasNode, container: HTMLElement) {
        if (!this.activeSession) return;

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
            const missing = LogicEngine.getMissingVariables(item.parsed, this.activeSession!.state);
            missing.forEach(v => missingVars.add(v));
        });

        if (missingVars.size > 0) {
            container.createEl('div', { text: 'Please set values for new variables:', cls: 'canvas-player-prompt-header' });

            missingVars.forEach(variable => {
                // Default to false if not set
                if (this.activeSession!.state[variable] === undefined) {
                    this.activeSession!.state[variable] = false;
                }

                new Setting(container)
                    .setName(variable)
                    .addToggle(toggle => toggle
                        .setValue(this.activeSession!.state[variable])
                        .onChange(val => {
                            this.activeSession!.state[variable] = val;
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
        const validChoices = parsedChoices.filter(item => LogicEngine.checkConditions(item.parsed, this.activeSession!.state));

        if (validChoices.length === 0) {
            if (this.activeSession.stack.length > 0) {
                new ButtonComponent(container)
                    .setButtonText("Return to Parent Canvas")
                    .setCta()
                    .onClick(async () => {
                        // Finish and save timer before returning
                        await this.finishTimerForActiveSession();
                        await this.popStackAndReturn();
                    })
                    .buttonEl.addClass('mod-cta');
            } else {
                new ButtonComponent(container)
                    .setButtonText("End of Path")
                    .onClick(async () => {
                        // Finish and save timer before stopping
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
                            // Finish and save timer for current node
                            await this.finishTimerForActiveSession();

                            // Update state
                            LogicEngine.updateState(choice.parsed, this.activeSession!.state);

                            // Check if next node is a Canvas file
                            if (nextNode.type === 'file' && nextNode.file && nextNode.file.endsWith('.canvas')) {
                                await this.diveIntoCanvas(view, data, nextNode);
                                return;
                            }

                            // Update activeSession
                            this.activeSession!.currentNode = nextNode;

                            // Start timer for next node
                            if (this.settings.enableTimeboxing) {
                                await this.startTimerForActiveSession();
                            }

                            // 1. Move Camera (blur stays active, only focused node will change)
                            this.zoomToNode(view, nextNode);

                            // 2. Render next buttons immediately
                            this.renderChoicesInHud(view, data, nextNode, container);

                            // 3. Update spotlight to new node (smooth transition, no blur gap)
                            // Use requestAnimationFrame for smoother timing, then small delay for zoom to settle
                            requestAnimationFrame(() => {
                                setTimeout(async () => {
                                    await this.applySpotlight(view, nextNode);
                                }, 300); // Reduced delay - blur stays active, only focused node changes
                            });

                            // 4. Update mini view if open
                            await this.updateAllUIs();
                        }
                    })
                    .buttonEl.addClass('canvas-player-btn');
            });
        }
    }

    async diveIntoCanvas(view: ItemView, currentData: CanvasData, fileNode: CanvasNode) {
        if (!this.activeSession) return;

        // Finish and save timer for current file node before diving
        await this.finishTimerForActiveSession();

        const filePath = fileNode.file;
        if (!filePath) return;

        const targetFile = this.app.metadataCache.getFirstLinkpathDest(filePath, (view as any).file?.path || "");

        if (!targetFile || targetFile.extension !== 'canvas') {
            new Notice(`Could not find canvas file: ${filePath}`);
            return;
        }

        // 1. Push to stack
        // @ts-ignore
        const currentFile = view.file;
        if (!currentFile) return;

        this.activeSession.stack.push({
            file: currentFile,
            data: currentData,
            currentNode: fileNode,
            state: Object.assign({}, this.activeSession.state) // Clone state
        });

        // 2. Reset state for isolated scope
        this.activeSession.state = {};
        this.activeSession.history = [];

        // 3. Open the new file
        const leaf = view.leaf;
        await leaf.openFile(targetFile);

        // 4. Get new view and data
        const newView = leaf.view as ItemView;
        this.cameraModeView = newView;
        const content = await this.app.vault.read(targetFile);
        const newData: CanvasData = JSON.parse(content);
        const startNode = this.getStartNode(newData);

        if (!startNode) {
            new Notice(`Cannot start embedded canvas: Could not find a text card containing "${this.settings.startText}" that points to a playable node.`);
            await this.popStackAndReturn();
            return;
        }

        // 5. Update activeSession
        this.activeSession.currentCanvasFile = targetFile;
        this.activeSession.currentCanvasData = newData;
        this.activeSession.currentNode = startNode;

        // Start timer for new node
        if (this.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }

        // 6. Start playing in new context
        await this.createHud(newView, newData, startNode);
        this.zoomToNode(newView, startNode);
        // Clear previous focused node since we're in a new canvas
        this.currentFocusedNodeEl = null;
        requestAnimationFrame(() => {
            setTimeout(async () => {
                await this.applySpotlight(newView, startNode);
            }, 300); // Reduced delay - blur stays active
        });

        // Update mini view
        await this.updateAllUIs();
    }

    async popStackAndReturn() {
        if (!this.activeSession) return;

        // Finish and save timer for current node (if any) before returning
        await this.finishTimerForActiveSession();

        const frame = this.activeSession.stack.pop();
        if (!frame) {
            await this.stopCameraMode();
            return;
        }

        // Restore active file
        const leaf = this.app.workspace.getLeaf();
        if (!leaf) return;

        await leaf.openFile(frame.file);
        const view = leaf.view as ItemView;
        this.cameraModeView = view;

        // Restore state (Isolated means we discard current, restore parent)
        this.activeSession.state = frame.state;
        this.activeSession.currentCanvasFile = frame.file;
        this.activeSession.currentCanvasData = frame.data;
        this.activeSession.currentNode = frame.currentNode;
        this.activeSession.history = [];

        // Start timer for restored node
        if (this.settings.enableTimeboxing) {
            await this.startTimerForActiveSession();
        }

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

        // Update mini view
        await this.updateAllUIs();
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
        const mode = this.sharedTimer.getMode();
        const formatted = formatRemainingTime(remainingMs, mode);
        this.statusBarItem.setText(`Canvas Player: ${formatted}`);
    }

    /**
     * Minimize the player (close modal, open mini view).
     */
    async minimizePlayer() {
        if (!this.activeSession) return;

        // Close modal (but keep session active)
        if (this.activeModal) {
            // Set flag so close() actually closes the modal DOM element
            this.activeModal.isMinimizing = true;
            this.activeModal.close();
            this.activeModal = null;
        }

        // Ensure mini view is open
        await this.ensureMiniViewOpen();

        // Refresh mini view to show Restore button
        await this.updateAllUIs();
    }

    /**
     * Restore the player (reopen modal or camera mode HUD).
     */
    async restorePlayer() {
        if (!this.activeSession) return;

        const mode = this.activeSessionMode ?? this.settings.mode;

        // Check if we're in modal mode or camera mode
        if (mode === 'modal') {
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
        } else {
            // Camera mode restore
            if (this.cameraModeView) {
                await this.restoreCameraMode();
            } else {
                // Recreate a camera view and HUD (e.g. after restart)
                const leaf = this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf(true);
                if (!leaf) return;
                await leaf.openFile(this.activeSession.currentCanvasFile);
                this.app.workspace.revealLeaf(leaf);
                await this.startCameraMode(this.activeSession.currentCanvasData, this.activeSession.currentNode);
            }
        }

        // Refresh mini view to hide Restore button
        await this.updateAllUIs();
    }

    /**
     * Minimize camera mode (hide HUD, open mini view).
     */
    async minimizeCameraMode() {
        if (!this.activeSession || !this.cameraModeView) return;

        // Hide HUD (but keep session active)
        if (this.activeHud) {
            this.activeHud.hide();
        }

        // Ensure mini view is open
        await this.ensureMiniViewOpen();

        // Refresh mini view to show Restore button
        await this.updateAllUIs();
    }

    /**
     * Restore camera mode (show HUD, restore spotlight).
     */
    async restoreCameraMode() {
        if (!this.activeSession || !this.cameraModeView) return;

        // Show HUD again
        if (this.activeHud) {
            this.activeHud.show();
        } else {
            // Recreate HUD if it was removed
            await this.createHud(
                this.cameraModeView,
                this.activeSession.currentCanvasData,
                this.activeSession.currentNode
            );
        }

        // Restore spotlight on current node
        this.zoomToNode(this.cameraModeView, this.activeSession.currentNode);
        requestAnimationFrame(() => {
            setTimeout(async () => {
                await this.applySpotlight(this.cameraModeView!, this.activeSession!.currentNode);
            }, 300);
        });

        // Refresh mini view to hide Restore button
        await this.updateAllUIs();
    }

    /**
     * Check if the player is currently minimized.
     */
    isPlayerMinimized(): boolean {
        if (!this.activeSession) return false;

        const mode = this.activeSessionMode ?? this.settings.mode;

        // Reader mode: minimized if modal is closed
        if (mode === 'modal') {
            return this.activeModal === null;
        }

        // Camera mode: minimized if we don't currently have an active camera view,
        // or if the HUD exists but is hidden.
        if (mode === 'camera') {
            if (!this.cameraModeView) return true;
            if (!this.activeHud) return true;
            return this.activeHud.offsetParent === null;
        }

        return false;
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
     * Close the mini-player view.
     */
    async closeMiniView() {
        const leaves = this.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
        for (const leaf of leaves) {
            await leaf.setViewState({
                type: 'empty',
                active: false
            });
        }
    }

    /**
     * Stop the active session.
     */
    async stopActiveSession() {
        if (!this.activeSession) return;
        
        // Check ownership before stopping (but allow if we're owner)
        if (!(await this.assertCanControlAsync())) return;
        
        try {
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
            
            // Stopping should NOT affect node averages
            this.abortTimerForActiveSession();
            
            // Clean up camera mode if active
            if (this.cameraModeView) {
                // Unsubscribe camera mode timer
                if (this.cameraModeTimerUnsubscribe) {
                    this.cameraModeTimerUnsubscribe();
                    this.cameraModeTimerUnsubscribe = null;
                }
                // Remove HUD and spotlight
                this.activeHud?.remove();
                this.activeOverlay?.remove();
                this.removeSpotlight();
                this.cameraModeView = null;
            }
            
            // Clean up
            this.sharedTimer.abort();
            this.activeSession = null;
            this.activeSessionMode = null;
            this.activeModal = null;

            // Clear persisted active session state (Deletes the vault file for instant sync)
            await this.clearActiveSessionState();
            
            // Update UI
            this.updateStatusBar();
            
            // Refresh mini view to show empty state
            const miniLeaves = this.app.workspace.getLeavesOfType(CANVAS_PLAYER_MINI_VIEW_TYPE);
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

    /**
     * Navigate back in the session history.
     */
    async navigateBack() {
        if (!this.activeSession || this.activeSession.history.length === 0) return;

        // Check ownership before navigation
        if (!(await this.assertCanControlAsync())) return;

        const previousNode = this.activeSession.history.pop();
        if (!previousNode) return;

        // Going Back should NOT affect node averages
        this.abortTimerForActiveSession();

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

        // Check ownership before navigation
        if (!(await this.assertCanControlAsync())) return;

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

        // Check ownership before navigation
        if (!(await this.assertCanControlAsync())) return;

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
     * Uses countdown if node has learned average, count-up if it's the first completion.
     */
    private async startTimerForActiveSession() {
        if (!this.activeSession || !this.settings.enableTimeboxing) return;

        const timingData = await loadTimingForNode(
            this.app,
            this.activeSession.currentCanvasFile,
            this.activeSession.currentNode,
            this.activeSession.currentCanvasData
        );

        if (timingData && timingData.avgMs > 0) {
            // Node has learned average: countdown mode
            const durationMs = timingData.avgMs;
            this.activeSession.timerDurationMs = durationMs;
            this.activeSession.timerStartTimeMs = Date.now();
            this.sharedTimer.start(durationMs, 'countdown');
        } else {
            // First completion: count-up mode (calibration)
            this.activeSession.timerDurationMs = 0;
            this.activeSession.timerStartTimeMs = Date.now();
            this.sharedTimer.start(0, 'countup');
        }

        this.updateStatusBar();

        // Persist state after timer starts/restarts
        await this.saveActiveSessionState();
    }

    /**
     * Finish and save timer for current node in active session.
     * Awards points if this is not the first completion (calibration).
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

        // Update timing using robust average
        const newTiming = updateRobustAverage(existingTiming, elapsedMs);

        // Award points only if this is NOT the first completion (calibration)
        if (existingTiming && existingTiming.avgMs > 0) {
            const points = calculatePoints(elapsedMs, existingTiming.avgMs);
            if (points > 0) {
                const ratio = elapsedMs / existingTiming.avgMs;
                const message = getPointsMessage(points, ratio);
                recordEarn(this.economy, this.deviceId, points, {
                    nodeId: this.activeSession.currentNode.id
                });
                await this.savePluginData();
                new Notice(message);
            }
        } else {
            // First completion: calibration only, no points
            // (Silent - user just learned the baseline)
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
     * Abort the current node timer WITHOUT updating averages.
     * Used for actions like Stop or Back navigation where we don't want to count timing.
     */
    private abortTimerForActiveSession(): void {
        if (!this.settings.enableTimeboxing) return;
        if (!this.sharedTimer.isRunning()) return;
        this.sharedTimer.abort();
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
            .setDesc('Show a timer for each node. First completion counts up to learn the average; subsequent runs use countdown.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTimeboxing)
                .onChange(async (value) => {
                    this.plugin.settings.enableTimeboxing = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('p', {
            text: 'Averages are learned per node after the first completion. No default duration is needed.',
            cls: 'setting-item-description'
        });

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
    private shouldActuallyClose: boolean = false; // Flag to track if we should actually close (Stop button) vs minimize
    public isMinimizing: boolean = false; // Flag to prevent recursion when minimizePlayer calls close()

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
                    void this.plugin.minimizePlayer();
                }
            }, true); // Use capture phase to intercept before default handler
        }

        // Intercept X button clicks to minimize instead of close
        const closeButton = this.modalEl.querySelector('.modal-close-button');
        if (closeButton) {
            closeButton.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                void this.plugin.minimizePlayer();
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
            void this.plugin.minimizePlayer();
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

        // Stop button
        new ButtonComponent(controls)
            .setButtonText('Stop')
            .onClick(async () => {
                // Set flag to actually close
                this.shouldActuallyClose = true;
                await this.plugin.stopActiveSession();
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


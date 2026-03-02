import { registerCommands } from './commands';

import { CanvasPlayerSettingTab } from './ui/settingsTab';
import { ConfirmResetTimeboxingModal } from './ui/modals/confirmResetModal';
import { App, Plugin, Notice, ItemView, TFile, Menu, debounce, TAbstractFile } from 'obsidian';
import { CanvasNode, CanvasData, StackFrame } from './types';
import { CanvasPlayerSettings, DEFAULT_SETTINGS } from './settings';
import { extractNodeInfo, transformNode, convertCardToGroup, convertGroupToCard } from './core/canvasTransforms';
import { PluginData, ResumeSession, PersistedActiveSession, restoreStackFromResume } from './utils/resumeStorage';
import { SharedCountdownTimer } from './timeboxing/sharedCountdownTimer';
import { ActiveSession } from './core/playerSession';
import { CanvasPlayerMiniView, CANVAS_PLAYER_MINI_VIEW_TYPE } from './ui/views/miniPlayerView';
import { getOrCreateDeviceId } from './utils/deviceId';
import { EconomyData, DEFAULT_ECONOMY_DATA } from './economy/economy';
import { PlaybackManager } from './core/playbackManager';
import { CanvasPlayerModal } from './ui/modals/canvasPlayerModal';
import { GameState } from './core/logic';

export default class CanvasPlayerPlugin extends Plugin {
    settings: CanvasPlayerSettings;
    economy: EconomyData = { ...DEFAULT_ECONOMY_DATA };
    activeHud: HTMLElement | null = null;
    activeOverlay: HTMLElement | null = null;

    // Map to track reset stats button elements per view
    resetStatsElements: Map<ItemView, HTMLElement> = new Map();

    // Resume session tracking
    rootCanvasFile: TFile | null = null;

    // Active session management (for minimize/restore)
    activeSession: ActiveSession | null = null;
    activeSessionMode: 'modal' | 'camera' | null = null;
    sharedTimer: SharedCountdownTimer = new SharedCountdownTimer();
    activeModal: CanvasPlayerModal | null = null;
    cameraModeView: ItemView | null = null;
    statusBarItem: HTMLElement | null = null;
    statusBarUnsubscribe: (() => void) | null = null;

    // Device ID for cross-device session ownership
    deviceId: string = '';

    // Playback manager (handles playback, navigation, camera mode, timer, UI updates)
    playbackManager: PlaybackManager;

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

    // ─── LIFECYCLE ────────────────────────────────────────────────

    async onload() {
        // Initialize device ID (must be done before loadPluginData to check ownership)
        this.deviceId = getOrCreateDeviceId(this.manifest.id);

        // Initialize playback manager
        this.playbackManager = new PlaybackManager(this);

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
            void this.playbackManager.restorePlayer();
        });

        // Subscribe status bar to timer updates
        this.statusBarUnsubscribe = this.sharedTimer.subscribe(() => {
            this.playbackManager.updateStatusBar();
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

        registerCommands(this);

        this.addSettingTab(new CanvasPlayerSettingTab(this.app, this));

        // Register context menu for canvas nodes
        this.registerEvent(
            (this.app.workspace as any).on('canvas:node-menu', (menu: Menu, node: any) => {
                menu.addItem((item: any) => {
                    item
                        .setTitle('Play from here')
                        .setIcon('play-circle')
                        .onClick(async () => {
                            await this.playbackManager.playFromNode(node);
                        });
                });

                // Add transform menu items
                this.addTransformMenuItems(menu, node);
            })
        );

        // Also register for group-menu as a compatibility hook
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

        // Close active modal if any
        if (this.activeModal) {
            this.activeModal.close();
            this.activeModal = null;
        }

        // Clean up camera mode
        this.activeHud?.remove();
        this.activeOverlay?.remove();
        this.playbackManager.removeSpotlight();

        // Clear active session
        this.activeSession = null;
        this.cameraModeView = null;

        // Hide status bar
        if (this.statusBarItem) {
            this.statusBarItem.hide();
        }
    }

    // ─── DATA PERSISTENCE ─────────────────────────────────────────

    async loadPluginData(): Promise<void> {
        const rawData = await this.loadData();

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

    // Legacy methods for compatibility
    async loadSettings() {
        await this.loadPluginData();
    }

    async saveSettings() {
        await this.savePluginData();
    }

    getDeviceId(): string {
        return this.deviceId;
    }

    // ─── RESUME DATA ──────────────────────────────────────────────

    private getResumeDataFile(): TFile | null {
        const file = this.app.vault.getAbstractFileByPath("canvas-player-resume-data.json");
        return file instanceof TFile ? file : null;
    }

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

    async saveResumeSession(rootFilePath: string, session: ResumeSession): Promise<void> {
        const currentSessions = await this.loadResumeDataFromVault();
        currentSessions[rootFilePath] = session;
        await this.saveResumeDataToVault(currentSessions);
    }

    async getResumeSession(rootFilePath: string): Promise<ResumeSession | null> {
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

    // ─── SESSION STATE PERSISTENCE ────────────────────────────────

    private getSessionStateFile(): TFile | null {
        const file = this.app.vault.getAbstractFileByPath("canvas-session-state.json");
        return file instanceof TFile ? file : null;
    }

    /**
     * Save the current active session state to a vault file.
     * Uses "Delete + Create" strategy to force instant syncing for every step,
     * with a fallback to Modify if creation fails.
     */
    async saveActiveSessionState(forceOwnership: boolean = false): Promise<void> {
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
            await this.app.vault.create("canvas-session-state.json", jsonContent);

            this.lastAppliedSessionStateTimestamp = now;
        } catch (e) {
            console.warn("Canvas Player: Nuclear save failed (likely race condition). Attempting fallback modify.", e);
            const fallbackFile = this.getSessionStateFile();
            if (fallbackFile) {
                try {
                    await this.app.vault.modify(fallbackFile, jsonContent);
                    this.lastAppliedSessionStateTimestamp = now;
                } catch (modifyError) {
                    console.error("Canvas Player: Fallback save also failed.", modifyError);
                }
            }
        }
    }

    async clearActiveSessionState(): Promise<void> {
        const file = this.getSessionStateFile();
        if (!file) return;

        try {
            const content = await this.app.vault.read(file);
            const currentPersisted = JSON.parse(content) as PersistedActiveSession;

            if (!this.isOwnerOfPersistedSession(currentPersisted)) {
                console.log('Canvas Player: Cannot clear session state - not the owner device');
                return;
            }

            await this.app.vault.delete(file);
        } catch (e) {
            console.warn("Canvas Player: Failed to clear session file", e);
        }
    }

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

        const savedSession = persisted;

        try {
            const rootFile = this.app.vault.getAbstractFileByPath(savedSession.rootFilePath);
            if (!(rootFile instanceof TFile) || rootFile.extension !== 'canvas') {
                throw new Error(`Root canvas file not found: ${savedSession.rootFilePath}`);
            }
            const currentFile = this.app.vault.getAbstractFileByPath(savedSession.currentFilePath);
            if (!(currentFile instanceof TFile) || currentFile.extension !== 'canvas') {
                throw new Error(`Current canvas file not found: ${savedSession.currentFilePath}`);
            }

            const content = await this.app.vault.read(currentFile);
            const canvasData: CanvasData = JSON.parse(content);

            const currentNode = canvasData.nodes.find(n => n.id === savedSession.currentNodeId);
            if (!currentNode) {
                throw new Error(`Node not found: ${savedSession.currentNodeId}`);
            }

            const stack = await restoreStackFromResume(this.app, savedSession.stack);

            const history: CanvasNode[] = [];
            for (const nodeId of savedSession.historyNodeIds) {
                const node = canvasData.nodes.find(n => n.id === nodeId);
                if (node) history.push(node);
            }

            this.activeSession = {
                rootCanvasFile: rootFile,
                currentCanvasFile: currentFile,
                currentCanvasData: canvasData,
                currentNode,
                state: { ...savedSession.state },
                stack,
                history,
                timerDurationMs: savedSession.timerDurationMs,
                timerStartTimeMs: savedSession.timerStartTimeMs
            };
            this.activeSessionMode = savedSession.mode;

            // Handle legacy ownership
            if (!savedSession.ownerDeviceId) {
                this.lastAppliedSessionStateTimestamp = Date.now();
            } else {
                this.lastAppliedSessionStateTimestamp = savedSession.updatedAtMs || Date.now();
            }

            // Restore running timer
            const mode: 'countdown' | 'countup' = savedSession.timerDurationMs > 0 ? 'countdown' : 'countup';
            this.sharedTimer.restoreFromPersisted(savedSession.timerStartTimeMs, savedSession.timerDurationMs, mode);

            this.playbackManager.updateStatusBar();
            await this.playbackManager.ensureMiniViewOpen();
            await this.playbackManager.updateAllUIs();

            return true;
        } catch (e) {
            console.error('Canvas Player: failed to restore active session state', e);
            new Notice('Canvas Player: Could not restore timer session.');
            return false;
        }
    }

    // ─── OWNERSHIP ────────────────────────────────────────────────

    private isOwnerOfPersistedSession(persisted: PersistedActiveSession): boolean {
        if (!persisted.ownerDeviceId) {
            return true;
        }
        return persisted.ownerDeviceId === this.deviceId;
    }

    async isOwnerOfCurrentSession(): Promise<boolean> {
        if (!this.activeSession) return true;

        const file = this.getSessionStateFile();
        if (!file) return true;

        try {
            const content = await this.app.vault.read(file);
            const persisted = JSON.parse(content) as PersistedActiveSession;
            return this.isOwnerOfPersistedSession(persisted);
        } catch (e) {
            console.error("Canvas Player: Failed to read session file for ownership check", e);
            return true;
        }
    }

    async assertCanControlAsync(): Promise<boolean> {
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

    async takeOverSession(): Promise<void> {
        if (!this.activeSession) {
            new Notice('Canvas Player: No active session to take over.');
            return;
        }

        await this.saveActiveSessionState(true);
        new Notice('Canvas Player: You now control this session.');
        await this.playbackManager.updateAllUIs();
    }

    // ─── REACTIVE SYNC ───────────────────────────────────────────

    private setupReactiveSyncWatcher(): void {
        this.debouncedReloadSessionState = debounce(async () => {
            await this.reloadSessionStateIfNewer();
        }, 300, true);

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

    private async reloadSessionStateIfNewer(): Promise<void> {
        if (!this.settings.enableTimeboxing) return;

        let file = this.getSessionStateFile();

        // Grace period for delete+create strategy
        if (!file) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            file = this.getSessionStateFile();
        }

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

        // Case 1: Remote Deletion
        if (!persisted) {
            const shouldClearLocal =
                this.lastSeenHadPersistedSession ||
                (this.activeSession && !await this.isOwnerOfCurrentSession());

            if (shouldClearLocal && this.activeSession) {
                console.log("Canvas Player: Session file deleted remotely. Stopping local session.");
                this.activeSession = null;
                this.activeSessionMode = null;
                this.sharedTimer.abort();
                this.playbackManager.updateStatusBar();
                await this.playbackManager.updateAllUIs();
            }

            this.lastSeenHadPersistedSession = false;
            this.lastSeenPersistedOwnerDeviceId = null;
            this.lastAppliedSessionStateTimestamp = 0;
            return;
        }

        // Case 2: Remote Update
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

    // ─── UI REGISTRATION ──────────────────────────────────────────

    refreshCanvasViewActions() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== 'canvas') return;

            const view = leaf.view as ItemView;

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

            if (!headerEl) return;

            // Add Player buttons
            if (!this.actionableView(view)) return;
            if ((view as any)._hasCanvasPlayerButton) return;

            try {
                view.addAction("play", "Play from start", () => this.playbackManager.playActiveCanvas());
                view.addAction("play-circle", "Play from last", () => void this.playbackManager.playActiveCanvasFromLast());
                view.addAction("zoom-in", "Zoom to start", () => void this.playbackManager.zoomToStartOfActiveCanvas());
                (view as any)._hasCanvasPlayerButton = true;
            } catch (e) {
                console.warn("Canvas Player: failed to add canvas header actions", e);
            }
        });
    }

    addTransformMenuItems(menu: Menu, node: any) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo) {
            return;
        }

        const { id, type } = nodeInfo;

        menu.addSeparator();

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
}


import { App, Modal, Plugin, Notice, MarkdownRenderer, ButtonComponent, PluginSettingTab, Setting, ItemView, Component, TFile } from 'obsidian';

// --- Interfaces ---
interface CanvasNode {
    id: string;
    text?: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface CanvasEdge {
    id: string;
    fromNode: string;
    toNode: string;
    label?: string;
}

interface CanvasData {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
}

interface CanvasPlayerSettings {
    mode: 'modal' | 'camera';
    startText: string;
}

const DEFAULT_SETTINGS: CanvasPlayerSettings = {
    mode: 'modal',
    startText: 'canvas-start'
}

export default class CanvasPlayerPlugin extends Plugin {
    settings: CanvasPlayerSettings;
    activeHud: HTMLElement | null = null; 
    activeOverlay: HTMLElement | null = null;
    private readonly actionableView = (view: ItemView): view is ItemView & {
        addAction(icon: string, title: string, callback: () => void): void;
    } => typeof (view as ItemView & { addAction?: unknown }).addAction === 'function';

    async onload() {
        await this.loadSettings();

        this.app.workspace.onLayoutReady(() => {
            this.refreshCanvasViewActions();
        });

        this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
            this.refreshCanvasViewActions();
        }));

        this.addCommand({
            id: 'play-canvas-command',
            name: 'Play Current Canvas',
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
    }

    refreshCanvasViewActions() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() === 'canvas') {
                const view = leaf.view as ItemView;
                if (!this.actionableView(view)) return;
                if ((view as any)._hasCanvasPlayerButton) return;
                view.addAction('play', 'Play Canvas', () => {
                    this.playActiveCanvas();
                });
                view.addAction('zoom-in', 'Zoom to start', () => {
                    void this.zoomToStartOfActiveCanvas();
                });
                (view as any)._hasCanvasPlayerButton = true;
            }
        });
    }

    private getStartNode(data: CanvasData): CanvasNode | null {
        const startText = this.settings.startText?.toLowerCase().trim();
        if (startText) {
            const matchingNode = data.nodes.find(node =>
                node.type === 'text' &&
                typeof node.text === 'string' &&
                node.text.toLowerCase().includes(startText)
            );

            if (matchingNode) {
                return matchingNode;
            }
        }

        const nodeIdsWithIncoming = new Set(data.edges.map(e => e.toNode));
        const firstTextWithoutIncoming = data.nodes.find(
            n => n.type === 'text' && !nodeIdsWithIncoming.has(n.id)
        );

        return firstTextWithoutIncoming || data.nodes[0] || null;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async playActiveCanvas() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'canvas') {
            new Notice('Please open a Canvas file first.');
            return;
        }

        const content = await this.app.vault.read(activeFile);
        const canvasData: CanvasData = JSON.parse(content);

        const startNode = this.getStartNode(canvasData);

        if (!startNode) return;

        if (this.settings.mode === 'modal') {
            new CanvasPlayerModal(this, activeFile, canvasData, startNode).open();
        } else {
            this.startCameraMode(canvasData, startNode);
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
                new Notice('Could not find a start card in this canvas.');
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

        this.createHud(view, data, startNode);
        
        // Initial Move
        this.zoomToNode(view, startNode);
        
        // Wait for zoom to finish before applying blur (approx 400ms)
        setTimeout(() => {
            this.applySpotlight(view, startNode);
        }, 400);
    }

    createHud(view: ItemView, data: CanvasData, currentNode: CanvasNode) {
        if (this.activeHud) this.activeHud.remove();
        if (this.activeOverlay) this.activeOverlay.remove();

        // 1. Create the Blur Overlay
        const overlayEl = view.contentEl.createDiv({ cls: 'canvas-player-blur-overlay' });
        this.activeOverlay = overlayEl;

        // 2. Create HUD
        const hudEl = view.contentEl.createDiv({ cls: 'canvas-player-hud' });
        this.activeHud = hudEl;

        const closeBtn = hudEl.createEl('button', { text: 'Stop Playing', cls: 'canvas-hud-close' });
        closeBtn.onclick = () => {
           this.stopCameraMode();
        };

        const choicesContainer = hudEl.createDiv({ cls: 'canvas-hud-choices' });
        this.renderChoicesInHud(view, data, currentNode, choicesContainer);
    }

    stopCameraMode() {
         this.activeHud?.remove();
         this.activeOverlay?.remove();
         this.activeHud = null;
         this.activeOverlay = null;
    }

    renderChoicesInHud(view: ItemView, data: CanvasData, currentNode: CanvasNode, container: HTMLElement) {
        container.empty();

        const choices = data.edges.filter(edge => edge.fromNode === currentNode.id);

        if (choices.length === 0) {
            new ButtonComponent(container)
                .setButtonText("End of Path") 
                .onClick(() => {
                    this.stopCameraMode();
                })
                .buttonEl.addClass('mod-cta');
        } else {
            choices.forEach(edge => {
                const nextNode = data.nodes.find(n => n.id === edge.toNode);
                let label = edge.label || "Next";

                new ButtonComponent(container)
                    .setButtonText(label)
                    .onClick(() => {
                        if (nextNode) {
                            // 1. Remove spotlight (clear view for movement)
                            this.removeSpotlight();
                            
                            // 2. Move Camera
                            this.zoomToNode(view, nextNode);
                            
                            // 3. Render next buttons immediately
                            this.renderChoicesInHud(view, data, nextNode, container);
                            
                            // 4. Re-apply spotlight after movement settles
                            setTimeout(() => {
                                this.applySpotlight(view, nextNode);
                            }, 500); // 500ms allows the smooth zoom to finish
                        }
                    })
                    .buttonEl.addClass('canvas-player-btn');
            });
        }
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

// ... Keep your Settings and Modal Classes below unchanged ...
// ... (Include CanvasPlayerSettingTab and CanvasPlayerModal classes from previous step) ...
// START: CanvasPlayerSettingTab
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
            .setDesc('Reader mode and Zoom to start use the first text node whose content contains this string (case-insensitive).')
            .addText(text => text
                .setPlaceholder('canvas-start')
                .setValue(this.plugin.settings.startText)
                .onChange(async (value) => {
                    this.plugin.settings.startText = value;
                    await this.plugin.saveSettings();
                }));
    }
}
// END: CanvasPlayerSettingTab

// START: CanvasPlayerModal
class CanvasPlayerModal extends Modal {
    canvasData: CanvasData;
    currentNode: CanvasNode;
    private history: CanvasNode[] = [];
    private plugin: CanvasPlayerPlugin;
    private canvasFile: TFile;

    constructor(plugin: CanvasPlayerPlugin, canvasFile: TFile, canvasData: CanvasData, startNode: CanvasNode) {
        super(plugin.app);
        this.plugin = plugin;
        this.canvasFile = canvasFile;
        this.canvasData = canvasData;
        this.currentNode = startNode;
    }

    onOpen() { this.renderScene(); }
    onClose() { this.contentEl.empty(); }

    async renderScene() {
        const { contentEl } = this;
        contentEl.empty();
        const container = contentEl.createDiv({ cls: 'canvas-player-container' });
        const controls = container.createDiv({ cls: 'canvas-player-controls' });
        const textContainer = container.createDiv({ cls: 'canvas-player-text' });
        
        new ButtonComponent(controls)
            .setButtonText('Back')
            .setDisabled(this.history.length === 0)
            .onClick(() => {
                const previous = this.history.pop();
                if (previous) {
                    this.currentNode = previous;
                    this.renderScene();
                }
            });

        new ButtonComponent(controls)
            .setButtonText('Edit')
            .onClick(() => {
                void this.openNodeForEditing();
            });
        
        await MarkdownRenderer.render(
            this.app,
            this.currentNode.text || "...",
            textContainer,
            "/",
            this as unknown as Component
        );

        const choices = this.canvasData.edges.filter(edge => edge.fromNode === this.currentNode.id);
        const buttonContainer = container.createDiv({ cls: 'canvas-player-choices' });

        if (choices.length === 0) {
            new ButtonComponent(buttonContainer).setButtonText("End of Path").onClick(() => this.close());
        } else {
            choices.forEach(edge => {
                const nextNode = this.canvasData.nodes.find(n => n.id === edge.toNode);
                let lbl = edge.label || "Next";
                new ButtonComponent(buttonContainer).setButtonText(lbl).onClick(() => {
                    if (nextNode) {
                        this.history.push(this.currentNode);
                        this.currentNode = nextNode;
                        this.renderScene();
                    }
                });
            });
        }
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
// END: CanvasPlayerModal
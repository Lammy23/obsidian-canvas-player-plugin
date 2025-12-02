import { App, Modal, Plugin, Notice, MarkdownRenderer, ButtonComponent, PluginSettingTab, Setting, ItemView, Component, TFile, Menu, debounce } from 'obsidian';
import { LogicEngine, GameState } from './logic';
import { CanvasNode, CanvasData } from './types';
import { CanvasPlayerSettings, DEFAULT_SETTINGS, DEFAULT_COMPLEXITY_WEIGHTS, ComplexityWeights } from './settings';
import { ComplexityCalculator } from './complexity';

export default class CanvasPlayerPlugin extends Plugin {
    settings: CanvasPlayerSettings;
    activeHud: HTMLElement | null = null; 
    activeOverlay: HTMLElement | null = null;
    currentSessionState: GameState = {};
    
    // Map to track score elements per view
    scoreElements: Map<ItemView, HTMLElement> = new Map();

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
            })
        );
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
        // Ensure nested objects are merged correctly
        this.settings.complexityWeights = Object.assign({}, DEFAULT_COMPLEXITY_WEIGHTS, this.settings.complexityWeights);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // Refresh UI based on new settings
        this.refreshCanvasViewActions();
        
        // Refresh scores when settings change
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'canvas') {
            this.updateComplexityScore(activeFile);
        }
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

        await this.playCanvasFromNode(activeFile, canvasData, startNode);
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
            if (matchingNode.type !== 'text') {
                new Notice('Can only play from text cards.');
                return;
            }

            await this.playCanvasFromNode(activeFile, canvasData, matchingNode);
        } catch (error) {
            console.error('Canvas Player: failed to play from node', error);
            new Notice('Unable to play from the selected card.');
        }
    }

    async playCanvasFromNode(canvasFile: TFile, canvasData: CanvasData, startNode: CanvasNode) {
        if (this.settings.mode === 'modal') {
            new CanvasPlayerModal(this, canvasFile, canvasData, startNode).open();
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

        this.currentSessionState = {}; // Reset state for new session
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
            new ButtonComponent(container)
                .setButtonText("End of Path") 
                .onClick(() => {
                    this.stopCameraMode();
                })
                .buttonEl.addClass('mod-cta');
        } else {
            validChoices.forEach(choice => {
                const nextNode = data.nodes.find(n => n.id === choice.edge.toNode);
                const label = choice.parsed.text || "Next";

                new ButtonComponent(container)
                    .setButtonText(label)
                    .onClick(() => {
                        if (nextNode) {
                            // Update state
                            LogicEngine.updateState(choice.parsed, this.currentSessionState);

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

        new Setting(containerEl)
            .setName('Show complexity score')
            .setDesc('Display the calculated complexity score in the canvas view header.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showComplexityScore)
                .onChange(async (value) => {
                    this.plugin.settings.showComplexityScore = value;
                    await this.plugin.saveSettings();
                }));

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
            new ButtonComponent(buttonContainer).setButtonText("End of Path").onClick(() => this.close());
        } else {
            validChoices.forEach(choice => {
                const nextNode = this.canvasData.nodes.find(n => n.id === choice.edge.toNode);
                const lbl = choice.parsed.text || "Next";
                new ButtonComponent(buttonContainer).setButtonText(lbl).onClick(() => {
                    if (nextNode) {
                        LogicEngine.updateState(choice.parsed, this.state);
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

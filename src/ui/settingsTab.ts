import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import CanvasPlayerPlugin from '../main';

export class CanvasPlayerSettingTab extends PluginSettingTab {
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

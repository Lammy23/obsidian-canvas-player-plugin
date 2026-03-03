import { App, Modal, Setting, Notice, TFile, ButtonComponent } from 'obsidian';
import CanvasPlayerPlugin from '../../main';
import { resetTimeboxingRecursive } from '../../timeboxing/timeboxingReset';

export class ConfirmResetTimeboxingModal extends Modal {
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

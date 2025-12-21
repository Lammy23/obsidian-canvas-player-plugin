import { App, TFile } from 'obsidian';
import { CanvasNode, CanvasData } from './types';
import { TimingData } from './timeboxing';

const TIMING_COMMENT_REGEX = /<!--\s*canvas-player:timing\s*(\{[^}]+\})\s*-->/;

/**
 * Load timing data for a node.
 * Checks text node comments, markdown file comments, or node JSON property.
 */
export async function loadTimingForNode(
    app: App,
    canvasFile: TFile,
    node: CanvasNode,
    canvasData: CanvasData
): Promise<TimingData | null> {
    // 1. Text nodes: check for comment in node.text
    if (node.type === 'text' && node.text) {
        const timing = parseTimingFromText(node.text);
        if (timing) return timing;
    }

    // 2. File nodes linking to markdown: check linked file
    if (node.type === 'file' && node.file && !node.file.endsWith('.canvas')) {
        try {
            const linkedFile = app.metadataCache.getFirstLinkpathDest(node.file, canvasFile.path);
            if (linkedFile instanceof TFile) {
                const content = await app.vault.read(linkedFile);
                const timing = parseTimingFromText(content);
                if (timing) return timing;
            }
        } catch (e) {
            console.error('Failed to read linked file for timing', e);
        }
    }

    // 3. Fallback: check node JSON property (for groups, canvas links, non-markdown files)
    if ((node as any).canvasPlayerTiming) {
        const prop = (node as any).canvasPlayerTiming;
        if (typeof prop.avgMs === 'number' && typeof prop.samples === 'number') {
            return { avgMs: prop.avgMs, samples: prop.samples };
        }
    }

    return null;
}

/**
 * Save timing data for a node.
 * Updates text node comments, markdown file comments, or node JSON property.
 * Returns true if the canvas file needs to be saved.
 */
export async function saveTimingForNode(
    app: App,
    canvasFile: TFile,
    node: CanvasNode,
    canvasData: CanvasData,
    timing: TimingData
): Promise<boolean> {
    let canvasNeedsSave = false;

    // 1. Text nodes: update comment in node.text
    if (node.type === 'text' && node.text !== undefined) {
        const updatedText = updateTimingInText(node.text, timing);
        if (updatedText !== node.text) {
            node.text = updatedText;
            canvasNeedsSave = true;
        }
        return canvasNeedsSave;
    }

    // 2. File nodes linking to markdown: update linked file
    if (node.type === 'file' && node.file && !node.file.endsWith('.canvas')) {
        try {
            const linkedFile = app.metadataCache.getFirstLinkpathDest(node.file, canvasFile.path);
            if (linkedFile instanceof TFile) {
                const content = await app.vault.read(linkedFile);
                const updatedContent = updateTimingInText(content, timing);
                if (updatedContent !== content) {
                    await app.vault.modify(linkedFile, updatedContent);
                }
                return false; // Canvas doesn't need save, file was updated directly
            }
        } catch (e) {
            console.error('Failed to save timing to linked file', e);
        }
    }

    // 3. Fallback: store as node JSON property (for groups, canvas links, non-markdown files)
    (node as any).canvasPlayerTiming = timing;
    return true; // Canvas needs to be saved
}

/**
 * Parse timing data from text (HTML comment format).
 */
function parseTimingFromText(text: string): TimingData | null {
    const match = text.match(TIMING_COMMENT_REGEX);
    if (!match) return null;

    try {
        const data = JSON.parse(match[1]);
        if (typeof data.avgMs === 'number' && typeof data.samples === 'number') {
            return { avgMs: data.avgMs, samples: data.samples };
        }
    } catch (e) {
        console.error('Failed to parse timing comment', e);
    }

    return null;
}

/**
 * Update or insert timing comment in text.
 */
function updateTimingInText(text: string, timing: TimingData): string {
    const comment = `<!-- canvas-player:timing ${JSON.stringify(timing)} -->`;
    
    // Try to replace existing comment
    if (TIMING_COMMENT_REGEX.test(text)) {
        return text.replace(TIMING_COMMENT_REGEX, comment);
    }
    
    // Append new comment (at end, on new line if text doesn't end with newline)
    if (text.trim().length === 0) {
        return comment;
    }
    
    const trimmed = text.trimEnd();
    const needsNewline = !trimmed.endsWith('\n') && !trimmed.endsWith('\r');
    return trimmed + (needsNewline ? '\n' : '') + comment;
}


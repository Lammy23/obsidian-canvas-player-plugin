import { App, TFile, Notice } from 'obsidian';
import { CanvasData, CanvasNode } from './types';

const TIMING_COMMENT_REGEX = /<!--\s*canvas-player:timing\s*(\{[^}]+\})\s*-->/;

export interface ResetResult {
    canvasChanged: boolean;
    markdownFilesChanged: Set<string>;
}

/**
 * Strip timing comment from text, returning cleaned text and whether it changed.
 */
export function stripTimingComment(text: string): { text: string; changed: boolean } {
    if (!TIMING_COMMENT_REGEX.test(text)) {
        return { text, changed: false };
    }
    
    // Remove the comment and clean up extra whitespace
    const cleaned = text.replace(TIMING_COMMENT_REGEX, '').trimEnd();
    
    // Remove trailing newline if it was left behind
    const finalText = cleaned.endsWith('\n') && !cleaned.endsWith('\n\n') 
        ? cleaned.slice(0, -1) 
        : cleaned;
    
    return { text: finalText, changed: true };
}

/**
 * Reset timeboxing stats for a single canvas file.
 * Returns whether the canvas was changed and which markdown files were modified.
 */
export async function resetTimeboxingForCanvasFile(
    app: any,
    canvasFile: TFile
): Promise<ResetResult> {
    const result: ResetResult = {
        canvasChanged: false,
        markdownFilesChanged: new Set<string>()
    };
    
    try {
        const content = await app.vault.read(canvasFile);
        const canvasData: CanvasData = JSON.parse(content);
        let canvasNeedsSave = false;
        
        // Process each node
        for (const node of canvasData.nodes) {
            // 1. Text nodes: remove timing comment from node.text
            if (node.type === 'text' && node.text !== undefined) {
                const { text: cleanedText, changed } = stripTimingComment(node.text);
                if (changed) {
                    node.text = cleanedText;
                    canvasNeedsSave = true;
                }
            }
            
            // 2. File nodes linking to markdown: remove timing comment from linked file
            if (node.type === 'file' && node.file && !node.file.endsWith('.canvas')) {
                try {
                    const linkedFile = app.metadataCache.getFirstLinkpathDest(
                        node.file, 
                        canvasFile.path
                    );
                    
                    if (linkedFile instanceof TFile) {
                        const fileContent = await app.vault.read(linkedFile);
                        const { text: cleanedContent, changed } = stripTimingComment(fileContent);
                        
                        if (changed) {
                            await app.vault.modify(linkedFile, cleanedContent);
                            result.markdownFilesChanged.add(linkedFile.path);
                        }
                    }
                } catch (e) {
                    console.warn(`Failed to reset timing for linked file: ${node.file}`, e);
                }
            }
            
            // 3. Remove canvasPlayerTiming property from node (for groups, canvas links, etc.)
            if ((node as any).canvasPlayerTiming !== undefined) {
                delete (node as any).canvasPlayerTiming;
                canvasNeedsSave = true;
            }
        }
        
        // Save canvas if it was modified
        if (canvasNeedsSave) {
            const updatedContent = JSON.stringify(canvasData, null, 2);
            await app.vault.modify(canvasFile, updatedContent);
            result.canvasChanged = true;
        }
    } catch (e) {
        console.error(`Failed to reset timeboxing for canvas: ${canvasFile.path}`, e);
        throw e;
    }
    
    return result;
}

/**
 * Reset timeboxing stats for a single canvas (non-recursive).
 * Does not affect nested canvas files - those must be reset manually.
 */
export async function resetTimeboxingRecursive(
    app: any,
    canvasFile: TFile
): Promise<{ canvasCount: number; markdownFileCount: number }> {
    // Only reset the current canvas, not nested canvases
    const result = await resetTimeboxingForCanvasFile(app, canvasFile);
    
    return {
        canvasCount: result.canvasChanged ? 1 : 0,
        markdownFileCount: result.markdownFilesChanged.size
    };
}


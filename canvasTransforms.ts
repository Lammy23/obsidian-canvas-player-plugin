import { App, Notice, TFile } from 'obsidian';
import { CanvasData, CanvasNode } from './types';

/**
 * Extracts node ID and type from the context menu node object.
 * Handles various Obsidian internal structures.
 */
export function extractNodeInfo(node: any): { id: string; type: string } | null {
    // Try various ways to get the node data
    let nodeData = node?.getData?.() || node?.node?.getData?.() || node;
    
    const id = nodeData?.id || node?.id;
    const type = nodeData?.type || node?.type;
    
    if (!id || !type) {
        return null;
    }
    
    return { id, type };
}

/**
 * Converts a card (text or file node) to a group node.
 * Blocks conversion if the card has any edges connected to it.
 */
export async function convertCardToGroup(
    app: App,
    canvasFile: TFile,
    nodeId: string,
    data: CanvasData
): Promise<boolean> {
    const node = data.nodes.find(n => n.id === nodeId);
    if (!node) {
        new Notice('Could not find the selected card.');
        return false;
    }
    
    // Validate it's a card node
    if (node.type !== 'text' && node.type !== 'file') {
        new Notice('Can only convert text or file cards to groups.');
        return false;
    }
    
    // Check for edges - block if any exist
    const hasEdges = data.edges.some(edge => 
        edge.fromNode === nodeId || edge.toNode === nodeId
    );
    
    if (hasEdges) {
        new Notice('Can\'t convert: this card has connections. Remove edges first.');
        return false;
    }
    
    // Compute group label
    let label = 'Group';
    if (node.type === 'text' && node.text) {
        // Use first non-empty line
        const lines = node.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length > 0) {
            label = lines[0];
        }
    } else if (node.type === 'file' && node.file) {
        // Use file basename
        const parts = node.file.split('/');
        label = parts[parts.length - 1] || 'Group';
    }
    
    // Transform node in-place
    node.type = 'group';
    node.label = label;
    // Remove card-specific fields
    delete node.text;
    delete node.file;
    
    // Write back to file
    const jsonContent = JSON.stringify(data, null, 2);
    await app.vault.modify(canvasFile, jsonContent);
    
    new Notice('Converted to group.');
    return true;
}

/**
 * Converts a group node to a text card.
 */
export async function convertGroupToCard(
    app: App,
    canvasFile: TFile,
    nodeId: string,
    data: CanvasData
): Promise<boolean> {
    const node = data.nodes.find(n => n.id === nodeId);
    if (!node) {
        new Notice('Could not find the selected group.');
        return false;
    }
    
    // Validate it's a group node
    if (node.type !== 'group') {
        new Notice('Can only convert groups to cards.');
        return false;
    }
    
    // Transform node in-place
    node.type = 'text';
    node.text = (node.label ?? '').trim() || 'Card';
    // Remove group-specific fields
    delete node.label;
    
    // Write back to file
    const jsonContent = JSON.stringify(data, null, 2);
    await app.vault.modify(canvasFile, jsonContent);
    
    new Notice('Converted to card.');
    return true;
}

/**
 * Helper to load canvas data and perform a transformation.
 */
export async function transformNode(
    app: App,
    nodeId: string,
    nodeType: string,
    transformFn: (app: App, file: TFile, nodeId: string, data: CanvasData) => Promise<boolean>
): Promise<void> {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== 'canvas') {
        new Notice('Please open a Canvas file first.');
        return;
    }
    
    try {
        const content = await app.vault.read(activeFile);
        const canvasData: CanvasData = JSON.parse(content);

        const didTransform = await transformFn(app, activeFile, nodeId, canvasData);
        if (didTransform) {
            // Force refresh so the Canvas updates immediately without needing to navigate away/back.
            // rebuildView() isn't in the official types, so we guard access.
            try {
                (app.workspace.activeLeaf as any)?.rebuildView?.();
            } catch (e) {
                console.warn('Canvas transform: failed to rebuild view', e);
            }
        }
    } catch (error) {
        console.error('Canvas transform error:', error);
        new Notice('Failed to transform node. Check console for details.');
    }
}


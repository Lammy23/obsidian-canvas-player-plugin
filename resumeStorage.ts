import { App, TFile } from 'obsidian';
import type { CanvasNode, CanvasData, StackFrame } from './types';
import type { GameState } from './logic';

/**
 * Resume session snapshot for a canvas playback session.
 * Stores file paths and node IDs, not full data blobs.
 */
export interface ResumeSession {
    /** Root canvas file path (the canvas that was initially opened) */
    rootFilePath: string;
    /** Current canvas file path (may differ if nested) */
    currentFilePath: string;
    /** Current node ID in currentFilePath */
    currentNodeId: string;
    /** Variable state at time of stop */
    currentSessionState: GameState;
    /** Stack of nested canvas frames (if any) */
    stack: ResumeStackFrame[];
}

/**
 * Stack frame for nested canvas navigation (serialized form).
 */
export interface ResumeStackFrame {
    /** Canvas file path */
    filePath: string;
    /** Node ID that triggered the nested canvas */
    currentNodeId: string;
    /** Variable state at time of diving */
    state: GameState;
}

/**
 * Plugin data structure containing both settings and resume sessions.
 */
export interface PluginData {
    settings?: any; // CanvasPlayerSettings - using any to avoid circular import
    resumeSessions?: Record<string, ResumeSession>; // Keyed by rootFilePath
}

/**
 * Validate that a resume session can be restored.
 * Returns null if valid, or an error message if invalid.
 */
export async function validateResumeSession(
    app: App,
    session: ResumeSession
): Promise<string | null> {
    // Check if root file exists
    const rootFile = app.vault.getAbstractFileByPath(session.rootFilePath);
    if (!(rootFile instanceof TFile) || rootFile.extension !== 'canvas') {
        return `Root canvas file not found: ${session.rootFilePath}`;
    }

    // Check if current file exists
    const currentFile = app.vault.getAbstractFileByPath(session.currentFilePath);
    if (!(currentFile instanceof TFile) || currentFile.extension !== 'canvas') {
        return `Current canvas file not found: ${session.currentFilePath}`;
    }

    // Load current canvas and check if node exists
    try {
        const content = await app.vault.read(currentFile);
        const data: CanvasData = JSON.parse(content);
        const node = data.nodes.find(n => n.id === session.currentNodeId);
        if (!node) {
            return `Node ${session.currentNodeId} not found in ${session.currentFilePath}`;
        }
    } catch (e) {
        return `Failed to read canvas file: ${session.currentFilePath}`;
    }

    // Validate stack frames
    for (const frame of session.stack) {
        const frameFile = app.vault.getAbstractFileByPath(frame.filePath);
        if (!(frameFile instanceof TFile) || frameFile.extension !== 'canvas') {
            return `Stack frame canvas file not found: ${frame.filePath}`;
        }
        try {
            const content = await app.vault.read(frameFile);
            const data: CanvasData = JSON.parse(content);
            const node = data.nodes.find(n => n.id === frame.currentNodeId);
            if (!node) {
                return `Stack frame node ${frame.currentNodeId} not found in ${frame.filePath}`;
            }
        } catch (e) {
            return `Failed to read stack frame canvas: ${frame.filePath}`;
        }
    }

    return null; // Valid
}

/**
 * Restore StackFrame[] from ResumeStackFrame[] by loading actual files and nodes.
 */
export async function restoreStackFromResume(
    app: App,
    resumeStack: ResumeStackFrame[]
): Promise<StackFrame[]> {
    const stack: StackFrame[] = [];

    for (const resumeFrame of resumeStack) {
        const file = app.vault.getAbstractFileByPath(resumeFrame.filePath);
        if (!(file instanceof TFile)) {
            throw new Error(`Stack frame file not found: ${resumeFrame.filePath}`);
        }

        const content = await app.vault.read(file);
        const data: CanvasData = JSON.parse(content);
        const node = data.nodes.find(n => n.id === resumeFrame.currentNodeId);
        if (!node) {
            throw new Error(`Stack frame node not found: ${resumeFrame.currentNodeId}`);
        }

        stack.push({
            file,
            data,
            currentNode: node,
            state: { ...resumeFrame.state }
        });
    }

    return stack;
}


import { TFile } from 'obsidian';
import { CanvasNode, CanvasData, StackFrame } from './types';
import { GameState } from './logic';

/**
 * Represents an active canvas player session that persists independently of UI.
 */
export interface ActiveSession {
    rootCanvasFile: TFile;
    currentCanvasFile: TFile;
    currentCanvasData: CanvasData;
    currentNode: CanvasNode;
    state: GameState;
    stack: StackFrame[];
    history: CanvasNode[]; // For Back navigation in modal mode
    timerDurationMs: number; // The initial duration when timer was started for current node
    timerStartTimeMs: number | null; // When the timer was started for current node
}

/**
 * Create a new active session.
 */
export function createActiveSession(
    rootCanvasFile: TFile,
    currentCanvasFile: TFile,
    currentCanvasData: CanvasData,
    currentNode: CanvasNode,
    initialState?: GameState,
    initialStack?: StackFrame[],
    timerDurationMs: number = 0
): ActiveSession {
    return {
        rootCanvasFile,
        currentCanvasFile,
        currentCanvasData,
        currentNode,
        state: initialState ? { ...initialState } : {},
        stack: initialStack ? initialStack.map(frame => ({
            file: frame.file,
            data: frame.data,
            currentNode: frame.currentNode,
            state: { ...frame.state }
        })) : [],
        history: [],
        timerDurationMs,
        timerStartTimeMs: Date.now()
    };
}

/**
 * Clone an active session (for safe updates).
 */
export function cloneActiveSession(session: ActiveSession): ActiveSession {
    return {
        ...session,
        state: { ...session.state },
        stack: session.stack.map(frame => ({
            file: frame.file,
            data: frame.data,
            currentNode: frame.currentNode,
            state: { ...frame.state }
        })),
        history: [...session.history],
        currentCanvasData: { ...session.currentCanvasData } // Shallow clone, but nodes/edges are arrays that will be shared
    };
}


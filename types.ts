import { TFile } from 'obsidian';
import type { GameState } from './logic';

export type { GameState } from './logic';

export interface CanvasNode {
    id: string;
    text?: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    file?: string; // For file nodes
    label?: string; // For group nodes
}

export interface CanvasEdge {
    id: string;
    fromNode: string;
    toNode: string;
    label?: string;
}

export interface CanvasData {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
}

export interface StackFrame {
    file: TFile;
    data: CanvasData;
    currentNode: CanvasNode;
    state: GameState; 
}

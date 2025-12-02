export interface CanvasNode {
    id: string;
    text?: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
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


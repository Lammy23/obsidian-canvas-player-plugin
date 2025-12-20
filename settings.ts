
export interface ComplexityWeights {
    nodeCount: number;
    edgeCount: number;
    cyclomaticComplexity: number;
    branchingFactor: number;
    logicDensity: number;
    variableCount: number;
    contentVolume: number;
}

export interface CanvasPlayerSettings {
    mode: 'modal' | 'camera';
    startText: string;
    showComplexityScore: boolean;
    complexityWeights: ComplexityWeights;
    enableTimeboxing: boolean;
    defaultNodeDurationMinutes: number;
}

export const DEFAULT_COMPLEXITY_WEIGHTS: ComplexityWeights = {
    nodeCount: 4.0,
    edgeCount: 3.1,
    cyclomaticComplexity: 1.5,
    branchingFactor: 1.0,
    logicDensity: 2.0,
    variableCount: 3.5,
    contentVolume: 0.10, // Assuming char count, this needs to be small
};

export const DEFAULT_SETTINGS: CanvasPlayerSettings = {
    mode: 'modal',
    startText: 'canvas-start',
    showComplexityScore: true,
    complexityWeights: DEFAULT_COMPLEXITY_WEIGHTS,
    enableTimeboxing: true,
    defaultNodeDurationMinutes: 5,
};

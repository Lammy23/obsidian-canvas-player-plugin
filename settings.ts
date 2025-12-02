
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
    complexityWeights: ComplexityWeights;
}

export const DEFAULT_COMPLEXITY_WEIGHTS: ComplexityWeights = {
    nodeCount: 0.1,
    edgeCount: 0.1,
    cyclomaticComplexity: 1.5,
    branchingFactor: 1.0,
    logicDensity: 2.0,
    variableCount: 0.5,
    contentVolume: 0.01, // Assuming char count, this needs to be small
};

export const DEFAULT_SETTINGS: CanvasPlayerSettings = {
    mode: 'modal',
    startText: 'canvas-start',
    complexityWeights: DEFAULT_COMPLEXITY_WEIGHTS,
};


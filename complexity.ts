import { CanvasData } from './types';
import { ComplexityWeights } from './settings';
import { LogicEngine } from './logic';

export interface ComplexityMetrics {
    nodeCount: number;
    edgeCount: number;
    cyclomaticComplexity: number;
    branchingFactor: number;
    logicDensity: number;
    variableCount: number;
    contentVolume: number;
}

export class ComplexityCalculator {
    static calculate(data: CanvasData): ComplexityMetrics {
        const nodeCount = data.nodes.length;
        const edgeCount = data.edges.length;
        
        // Cyclomatic Complexity = E - N + 2P (assuming P=1 connected component for simplicity)
        const cyclomaticComplexity = Math.max(1, edgeCount - nodeCount + 2);

        // Branching Factor = E / N
        const branchingFactor = nodeCount > 0 ? edgeCount / nodeCount : 0;

        // Logic Density and Variable Count
        let logicEdgeCount = 0;
        const variables = new Set<string>();
        let contentVolume = 0;

        // Process Edges for Logic
        for (const edge of data.edges) {
            const label = edge.label || '';
            if (label.includes('{if:') || label.includes('{set:')) {
                logicEdgeCount++;
            }
            
            // Use LogicEngine to extract variables if possible, or simple regex
            // Using LogicEngine's static methods if available or duplicating regex logic
            // LogicEngine.parseLabel is available based on logic.ts
            const parsed = LogicEngine.parseLabel(label);
            
            parsed.sets.forEach(s => variables.add(s.variable));
            parsed.conditions.forEach(c => variables.add(c.variable));
        }

        const logicDensity = edgeCount > 0 ? logicEdgeCount / edgeCount : 0;

        // Process Nodes for Content Volume
        for (const node of data.nodes) {
            if (node.text) {
                contentVolume += node.text.length;
            }
        }

        return {
            nodeCount,
            edgeCount,
            cyclomaticComplexity,
            branchingFactor,
            logicDensity,
            variableCount: variables.size,
            contentVolume
        };
    }

    static computeScore(metrics: ComplexityMetrics, weights: ComplexityWeights): number {
        let score = 0;
        score += metrics.nodeCount * weights.nodeCount;
        score += metrics.edgeCount * weights.edgeCount;
        score += metrics.cyclomaticComplexity * weights.cyclomaticComplexity;
        score += metrics.branchingFactor * weights.branchingFactor;
        // Logic density is a percentage, so we might want to scale it up or treat it as a multiplier?
        // Plan implies weighted average/sum.
        // logicDensity is 0-1. If weight is e.g. 2.0, it adds at most 2.0 to score.
        // This seems fine as a component.
        score += metrics.logicDensity * 100 * weights.logicDensity; // Multiply by 100 to treat as percentage points? Or just raw? 
        // Let's treat it as a raw factor scaled by 100 to be comparable to counts
        
        score += metrics.variableCount * weights.variableCount;
        score += metrics.contentVolume * weights.contentVolume;

        return Math.round(score);
    }
}


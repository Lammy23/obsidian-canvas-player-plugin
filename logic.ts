export interface GameState {
    [key: string]: boolean;
}

export interface ParsedLabel {
    text: string;
    sets: { variable: string; value: boolean }[];
    conditions: { variable: string; value: boolean }[];
}

export class LogicEngine {
    /**
     * Parses a label string to extract {set:...} and {if:...} tags.
     * Supported syntax:
     * - {set:var=true} or {set:var=false}
     * - {if:var=true} or {if:var=false}
     * - {if:var} (implies true)
     * - {if:!var} (implies false)
     */
    static parseLabel(label: string): ParsedLabel {
        const sets: { variable: string; value: boolean }[] = [];
        const conditions: { variable: string; value: boolean }[] = [];
        let text = label;

        // Regex for {set:name=value}
        // Matches {set:variableName=true} or {set:variableName=false}
        const setRegex = /\{set:([a-zA-Z0-9_]+)=(true|false)\}/g;
        let match;
        while ((match = setRegex.exec(text)) !== null) {
            sets.push({ variable: match[1], value: match[2] === 'true' });
        }
        text = text.replace(setRegex, '').trim();

        // Regex for {if:name=value}
        const ifRegex = /\{if:([a-zA-Z0-9_]+)=(true|false)\}/g;
        while ((match = ifRegex.exec(text)) !== null) {
            conditions.push({ variable: match[1], value: match[2] === 'true' });
        }
        text = text.replace(ifRegex, '').trim();

        // Regex for {if:name} (implicit true) and {if:!name} (implicit false)
        const ifImplicitRegex = /\{if:(!?)([a-zA-Z0-9_]+)\}/g;
        while ((match = ifImplicitRegex.exec(text)) !== null) {
            const isNegated = match[1] === '!';
            conditions.push({ variable: match[2], value: !isNegated });
        }
        text = text.replace(ifImplicitRegex, '').trim();

        return { text, sets, conditions };
    }

    /**
     * Checks if all conditions in the parsed label are met by the current state.
     * Variables not in state are assumed false (undefined -> false).
     */
    static checkConditions(parsed: ParsedLabel, state: GameState): boolean {
        for (const condition of parsed.conditions) {
            const currentValue = !!state[condition.variable]; // undefined becomes false
            if (currentValue !== condition.value) {
                return false;
            }
        }
        return true;
    }

    /**
     * Updates the state based on the sets in the parsed label.
     */
    static updateState(parsed: ParsedLabel, state: GameState): void {
        for (const setOp of parsed.sets) {
            state[setOp.variable] = setOp.value;
        }
    }

    /**
     * Returns a list of variable names referenced in conditions that are not defined in the state.
     */
    static getMissingVariables(parsed: ParsedLabel, state: GameState): string[] {
        const missing: string[] = [];
        for (const condition of parsed.conditions) {
            if (state[condition.variable] === undefined) {
                if (!missing.includes(condition.variable)) {
                    missing.push(condition.variable);
                }
            }
        }
        return missing;
    }
}


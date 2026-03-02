export interface GameState {
    [key: string]: boolean;
}

export interface ParsedLabel {
    text: string;
    sets: { variable: string; value: boolean }[];
    expression: string | null;
    dependencies: string[];
}

export class LogicEngine {
    /**
     * Parses a label string to extract {set:...} and {if:...} tags.
     * Supported syntax:
     * - {set:var=true} or {set:var=false}
     * - {if:expression} where expression can use & (AND), | (OR), ! (NOT), and parens ()
     *   Example: {if:!A&(B|C)}
     *   Also supports legacy: {if:var=true}, {if:var=false} inside the expression.
     */
    static parseLabel(label: string): ParsedLabel {
        const sets: { variable: string; value: boolean }[] = [];
        const expressionParts: string[] = [];
        let text = label;

        // Regex for {set:name=value}
        // Matches {set:variableName=true} or {set:variableName=false}
        const setRegex = /\{set:([a-zA-Z0-9_]+)=(true|false)\}/g;
        let match;
        while ((match = setRegex.exec(text)) !== null) {
            sets.push({ variable: match[1], value: match[2] === 'true' });
        }
        text = text.replace(setRegex, '').trim();

        // Regex for {if:expression}
        // Capture everything inside {if:...}
        const ifRegex = /\{if:([^}]+)\}/g;
        while ((match = ifRegex.exec(text)) !== null) {
            expressionParts.push(`(${match[1]})`);
        }
        text = text.replace(ifRegex, '').trim();

        const expression = expressionParts.length > 0 ? expressionParts.join(' & ') : null;
        const dependencies = expression ? ExpressionParser.extractVariables(expression) : [];

        return { text, sets, expression, dependencies };
    }

    /**
     * Checks if the boolean expression in the parsed label evaluates to true.
     * Variables not in state are assumed false (undefined -> false).
     */
    static checkConditions(parsed: ParsedLabel, state: GameState): boolean {
        if (!parsed.expression) return true;
        return ExpressionParser.evaluate(parsed.expression, state);
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
        for (const variable of parsed.dependencies) {
            if (state[variable] === undefined) {
                if (!missing.includes(variable)) {
                    missing.push(variable);
                }
            }
        }
        return missing;
    }
}

class ExpressionParser {
    static evaluate(expr: string, state: GameState): boolean {
        const tokens = this.tokenize(expr);
        return this.parseExpression(tokens, state);
    }

    static extractVariables(expr: string): string[] {
        const tokens = this.tokenize(expr);
        const vars = new Set<string>();
        for (const token of tokens) {
            if (token.type === 'IDENTIFIER' || token.type === 'IDENTIFIER_FALSE') {
                vars.add(token.value);
            }
        }
        return Array.from(vars);
    }

    private static tokenize(expr: string) {
        const tokens: { type: string, value: string }[] = [];
        let i = 0;
        while (i < expr.length) {
            const char = expr[i];
            
            if (/\s/.test(char)) {
                i++;
                continue;
            }
            
            if (['&', '|', '!', '(', ')'].includes(char)) {
                tokens.push({ type: char, value: char });
                i++;
                continue;
            }
            
            // Identifier (potentially var=true/false)
            // Allowed chars: alphanumeric + underscore
            const identMatch = /^[a-zA-Z0-9_]+(?:=(?:true|false))?/.exec(expr.substring(i));
            if (identMatch) {
                const raw = identMatch[0];
                if (raw.endsWith('=true')) {
                    tokens.push({ type: 'IDENTIFIER', value: raw.replace('=true', '') });
                } else if (raw.endsWith('=false')) {
                    tokens.push({ type: 'IDENTIFIER_FALSE', value: raw.replace('=false', '') });
                } else {
                    tokens.push({ type: 'IDENTIFIER', value: raw });
                }
                i += raw.length;
                continue;
            }
            
            // Skip unknown characters to avoid infinite loops
            i++;
        }
        return tokens;
    }

    private static parseExpression(tokens: any[], state: GameState): boolean {
        let pos = 0;

        // E -> T { | T }
        function parseE(): boolean {
            let left = parseT();
            while (pos < tokens.length && tokens[pos].type === '|') {
                pos++;
                const right = parseT();
                left = left || right;
            }
            return left;
        }

        // T -> F { & F }
        function parseT(): boolean {
            let left = parseF();
            while (pos < tokens.length && tokens[pos].type === '&') {
                pos++;
                const right = parseF();
                left = left && right;
            }
            return left;
        }

        // F -> !F | (E) | Atom
        function parseF(): boolean {
            if (pos >= tokens.length) return true; // Should not happen in valid expr

            const token = tokens[pos];
            
            if (token.type === '!') {
                pos++;
                return !parseF();
            }
            
            if (token.type === '(') {
                pos++;
                const val = parseE();
                if (pos < tokens.length && tokens[pos].type === ')') {
                    pos++;
                }
                return val;
            }
            
            if (token.type === 'IDENTIFIER') {
                pos++;
                // undefined is false
                return !!state[token.value];
            }
            
            if (token.type === 'IDENTIFIER_FALSE') {
                pos++;
                // var=false means "if var is false"
                return !state[token.value];
            }
            
            // Fallback
            pos++;
            return false; 
        }

        return parseE();
    }
}

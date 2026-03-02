
export interface CanvasPlayerSettings {
    mode: 'modal' | 'camera';
    startText: string;
    enableTimeboxing: boolean;
}

export const DEFAULT_SETTINGS: CanvasPlayerSettings = {
    mode: 'modal',
    startText: 'canvas-start',
    enableTimeboxing: true,
};

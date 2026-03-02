import CanvasPlayerPlugin from '../main';

export function registerCommands(plugin: CanvasPlayerPlugin) {
        plugin.addCommand({
            id: 'play-canvas-command',
            name: 'Play current canvas (from start)',
            checkCallback: (checking: boolean) => {
                const activeFile = plugin.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'canvas') {
                    if (!checking) plugin.playbackManager.playActiveCanvas();
                    return true;
                }
                return false;
            }
        });

        plugin.addCommand({
            id: 'play-canvas-command-last',
            name: 'Play current canvas (from last)',
            checkCallback: (checking: boolean) => {
                const activeFile = plugin.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'canvas') {
                    if (!checking) void plugin.playbackManager.playActiveCanvasFromLast();
                    return true;
                }
                return false;
            }
        });

        plugin.addCommand({
            id: 'zoom-canvas-to-start',
            name: 'Zoom Canvas to Start',
            checkCallback: (checking: boolean) => {
                const activeFile = plugin.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'canvas') {
                    if (!checking) void plugin.playbackManager.zoomToStartOfActiveCanvas();
                    return true;
                }
                return false;
            }
        });

        // Commands for minimized player
        plugin.addCommand({
            id: 'canvas-player-restore',
            name: 'Restore Canvas Player',
            checkCallback: (checking: boolean) => {
                if (plugin.activeSession) {
                    if (!checking) void plugin.playbackManager.restorePlayer();
                    return true;
                }
                return false;
            }
        });

        plugin.addCommand({
            id: 'canvas-player-stop',
            name: 'Stop Canvas Player',
            checkCallback: (checking: boolean) => {
                if (plugin.activeSession) {
                    if (!checking) void plugin.playbackManager.stopActiveSession();
                    return true;
                }
                return false;
            }
        });

        plugin.addCommand({
            id: 'canvas-player-minimize',
            name: 'Minimize Canvas Player',
            checkCallback: (checking: boolean) => {
                if (plugin.activeModal) {
                    if (!checking) void plugin.playbackManager.minimizePlayer();
                    return true;
                }
                return false;
            }
        });

        plugin.addCommand({
            id: 'canvas-player-takeover',
            name: 'Take over session',
            checkCallback: (checking: boolean) => {
                if (plugin.activeSession) {
                    if (!checking) void plugin.takeOverSession();
                    return true;
                }
                return false;
            }
        });

}

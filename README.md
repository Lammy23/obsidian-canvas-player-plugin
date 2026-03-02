# Obsidian Canvas Player

A plugin for [Obsidian](https://obsidian.md) that allows you to "play" your Canvas files as interactive text adventures or presentations. Supports timeboxing, economy rewards, and seamless cross-device syncing.

## Features

-   **Play Mode**: Navigate through your canvas node by node.
-   **Cross-Device Sync**: Start playing on your PC, pause, and resume exactly where you left off on your mobile device.
-   **Timeboxing & Economy**: 
    -   **Timers**: Track how long you spend on each node.
    -   **Rewards**: Earn points by completing nodes faster than your average time.
    -   **Shop**: Spend your earned points on custom rewards (configurable in settings).
-   **Two Viewing Modes**:
    -   **Reader Mode (Modal)**: Displays text in a focused popup window, similar to a text adventure game.
    -   **Camera Mode**: Smoothly pans and zooms the canvas view to the active node, dimming the surroundings (Spotlight effect).
-   **Variable State Management**: Create complex, branching narratives by tracking choices and variables.
-   **Resume Playback**: The plugin remembers your position, variable state, and nested canvas stack.
-   **Start Anywhere**: Play from the beginning, resume from your last position, or right-click any card to "Play from here".

## Syncing Setup (Important!)

To enable **Cross-Device Syncing** (playing on one device and resuming on another), you must ensure your sync solution includes the plugin's data files.

1.  Open **Settings** > **Sync** (or your third-party sync settings).
2.  Enable **"Sync all other types"** (ensure `.json` files are synced).
3.  The plugin creates two files in your vault root to ensure fast, conflict-free syncing:
    -   `canvas-session-state.json`: Tracks the currently running session (created when playing, deleted when stopped).
    -   `canvas-player-resume-data.json`: Stores your save history for "Play from last".

*Note: If you do not enable this, your play sessions will be local to each device.*

## Usage

1.  Open a Canvas file.
2.  Choose how to start:
    -   **Play from start**: Run the command **"Play current canvas (from start)"** or click the "Play from start" button in the canvas header.
    -   **Play from last**: Run the command **"Play current canvas (from last)"**. This restores your position, variables, and nested stack.
    -   **Play from here**: Right-click any card and select "Play from here".
3.  **During Play**:
    -   Follow the path! Click buttons to choose your next step.
    -   **Take Over**: If you left a session running on another device, click "Take Over" in the mini-player view to claim control.
4.  **Stopping**: Click "Stop Playing". Your session file is deleted, and your history is saved to the resume file.

## Variable State Syntax

You can add logic to your **connection labels** to set variables or show/hide paths based on previous choices.

### Setting Variables
Use `{set:variableName=value}` to update the game state when a user takes a path.
-   **Example**: `{set:hasKey=true} Pick up the key`

### Checking Conditions
Use `{if:variableName}` or `{if:!variableName}` to only show a path if a condition is met.
-   **Example**: `{if:hasKey} Unlock the door`

## Installation

1.  Download the latest release.
2.  Extract `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/obsidian-canvas-player` folder.
3.  Reload Obsidian and enable the plugin.

## Development

1.  Clone this repository.
2.  Run `npm install` to install dependencies.
3.  Run `npm run dev` to start compilation in watch mode.
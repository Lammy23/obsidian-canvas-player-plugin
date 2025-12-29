# Obsidian Canvas Player

A plugin for [Obsidian](https://obsidian.md) that allows you to "play" your Canvas files as interactive text adventures or presentations.

## Features

-   **Play Mode**: Navigate through your canvas node by node.
-   **Two Viewing Modes**:
    -   **Reader Mode (Modal)**: Displays text in a focused popup window, similar to a text adventure game.
    -   **Camera Mode**: Smoothly pans and zooms the canvas view to the active node, dimming the surroundings.
-   **Variable State Management**: Create complex, branching narratives by tracking choices and variables.
-   **Resume Playback**: The plugin remembers where you stopped and allows you to resume exactly where you left off, including variable state and nested canvas navigation.
-   **Start Anywhere**: Play from the beginning, resume from your last position, or right-click any card to "Play from here".

## Usage

1.  Open a Canvas file.
2.  Choose how to start:
    -   **Play from start**: Run the command **"Play current canvas (from start)"** or click the "Play from start" button in the canvas header. This starts from the beginning of the canvas.
    -   **Play from last**: Run the command **"Play current canvas (from last)"** or click the "Play from last" button in the canvas header. This resumes from where you last stopped, restoring your position, variable state, and nested canvas stack.
    -   **Play from here**: Right-click any card and select "Play from here" to start playback from that specific node.
3.  Follow the path! Click the buttons to choose your next step.
4.  When you're done, click "Stop Playing" or close the modal. Your position is automatically saved, so you can resume later using "Play from last".

## Variable State Syntax

You can add logic to your **connection labels** to set variables or show/hide paths based on previous choices. The syntax is hidden from the player during gameplay.

### Setting Variables
Use `{set:variableName=value}` to update the game state when a user takes a path.

-   **Example**: `{set:hasKey=true} Pick up the key`
    -   *Effect*: Sets the variable `hasKey` to `true` when clicked.
    -   *Display*: The button will just say "Pick up the key".

### Checking Conditions
Use `{if:variableName}` or `{if:!variableName}` to only show a path if a condition is met.

-   **Example 1**: `{if:hasKey} Unlock the door`
    -   *Effect*: This option only appears if `hasKey` is true.
-   **Example 2**: `{if:!visitedRoom} Enter the dark cave`
    -   *Effect*: This option only appears if `visitedRoom` is false (or undefined).

### Explicit Values
You can also check for explicit boolean values:
-   `{if:status=true}`
-   `{if:status=false}`

## Installation

1.  Download the latest release.
2.  Extract the `main.js`, `manifest.json`, and `styles.css` files into your vault's `.obsidian/plugins/obsidian-canvas-player` folder.
3.  Reload Obsidian and enable the plugin in Settings.

## Development

1.  Clone this repository.
2.  Run `npm install` to install dependencies.
3.  Run `npm run dev` to start compilation in watch mode.

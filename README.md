# Obsidian Canvas Player

A plugin for [Obsidian](https://obsidian.md) that allows you to "play" your Canvas files as interactive text adventures or presentations.

## Features

-   **Play Mode**: Navigate through your canvas node by node.
-   **Two Viewing Modes**:
    -   **Reader Mode (Modal)**: Displays text in a focused popup window, similar to a text adventure game.
    -   **Camera Mode**: Smoothly pans and zooms the canvas view to the active node, dimming the surroundings.
-   **Variable State Management**: Create complex, branching narratives by tracking choices and variables.
-   **Start Anywhere**: Play from the beginning or right-click any card to "Play from here".

## Usage

1.  Open a Canvas file.
2.  Run the command **"Play Current Canvas"** (or click the "Play" button in the canvas header).
3.  Follow the path! Click the buttons to choose your next step.

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

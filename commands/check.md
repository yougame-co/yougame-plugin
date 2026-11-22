---
description: Run YouGame's pre-upload checks on a build folder
argument-hint: "[build folder, e.g. dist]"
---

Run YouGame's pre-upload checks on the build folder given with this command (if none is given,
the built game folder in this project).

List every file in that folder with its size, read `index.html` and the `.html`/`.css`/`.js`
files under 2 MB, and call the `yougame` MCP tool `check_build` with all of it. Show me the
verdict and the items it lists, then fix the failures and re-run until the verdict is
`ready`. Do not zip or upload anything unless I ask.

A game that uses the SDK but never reads `YouGame.ui` or a `--yg-ui-` variable gets this hint (it is listed in the report and does not change the verdict):
"This game does not read YouGame's reserved screen areas. Keep 192 x 60 px at the bottom right and 72 x 72 px at the top left clear, or use YouGame.ui.onChange (sdk.md, Reserved screen areas)."

The verdict covers static packaging and SDK references only. Runtime behavior is not tested.
Do not claim working multiplayer, Friends, or ranked results from this check. List the hosted
button/lifecycle tests still needed separately.

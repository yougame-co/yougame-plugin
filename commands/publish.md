---
description: Make this game YouGame-ready, check it, and publish it (signed in to the YouGame MCP or with YOUGAME_API_KEY set, upload it, fill in the listing and publish; otherwise zip it for the upload page)
argument-hint: "[build folder, e.g. dist]"
---

Publish the game in this project on YouGame, following the `publish-to-yougame` skill.

Build folder: the one given with this command (if none is given, work out which folder is the built game, or build it
first, and say which one you picked).

Do all of it: make the build static and self-contained, add the leaderboard with the SDK,
and run `check_build` and fix everything it reports until the verdict is `ready`. If the YouGame
MCP connection is signed in (get a bearer token from its `upload_token` tool) or `YOUGAME_API_KEY`
is set, upload the build, fill in every listing field (skill step 6), ask me about anything you
cannot decide (the thumbnail above all), and publish it with `publish_game`
(`creator_approved: true`: this command is my go-ahead to publish), then give me the game's
link. If I said I want to look at the listing first, call `prepare_submission` instead and give
me the review link; I press Publish there. Only when neither a sign-in nor a key is available,
zip the folder's contents, tell me where the zip is and what to do on the upload page, and tell
me that connecting the MCP (`/mcp` → yougame → Authenticate) or making a key would let you do
it all.

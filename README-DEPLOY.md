# Discord Prometheus Deobfuscator Bot

This bot wraps the included Prometheus deobfuscator. It accepts `.lua` and `.txt` attachments, remembers the latest supported upload per user/channel for 15 minutes, and processes it when that user sends `.deobf`. It does not execute uploaded scripts.

## 1. Create the Discord bot

1. Open https://discord.com/developers/applications and create an application.
2. Under **Bot**, add a bot and reset/copy its token.
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
4. Under **OAuth2 → URL Generator**, select `bot` and permissions `View Channels`, `Send Messages`, `Read Message History`, and `Attach Files`; invite it to your server.
5. Keep the token private. Do not paste it into chat, source code, GitHub, or screenshots.

## 2. Upload to GitHub

Create a private GitHub repository. Upload the contents of this folder (including `deobfuscator/`, `bot.js`, `package.json`, and `render.yaml`). Do not upload `.env` or any real token.

## 3. Deploy on Render

1. In Render, choose **New → Blueprint** and connect the GitHub repository, or create a **Background Worker** with Node.
2. Build command: `npm install`
3. Start command: `npm start`
4. Add environment variable `DISCORD_TOKEN` with the bot token.
5. Optional: set `ALLOWED_USER_IDS` to your Discord user ID(s), comma-separated, to restrict who can run it.
6. Deploy and check the worker logs for `Logged in as ...`.

For continuous 24/7 operation, use a Render Background Worker on a plan that supports always-on workers. A free web service or UptimeRobot ping is not a reliable substitute for an always-on worker. UptimeRobot cannot wake a background worker or guarantee uptime.

## 4. Use it

1. Upload `example.lua` or `example.txt` in a channel the bot can read.
2. Send `.deobf` in the same channel.
3. The bot replies with a `.deobfuscated.lua` attachment.

The included deobfuscator targets Prometheus-obfuscated Lua. It will not successfully reverse every obfuscator or custom virtual-machine format.

## Safety notes

- Do not use the bot to access code you do not have permission to inspect.
- Uploaded scripts are treated as text and are never executed.
- Set `ALLOWED_USER_IDS` if this is a private tool.
- The bot uses temporary files and removes them after each job. Recent upload metadata is memory-only and resets if the worker restarts.

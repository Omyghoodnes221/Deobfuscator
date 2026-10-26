const {
  Client, GatewayIntentBits, Partials, AttachmentBuilder
} = require("discord.js");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { deobfuscate, NotPrometheusError } = require("./deobfuscator/src/index");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.COMMAND_PREFIX || ".";
const MAX_BYTES = Number(process.env.MAX_FILE_BYTES || 7 * 1024 * 1024);
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES || 7 * 1024 * 1024);
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Latest uploaded source per user and channel. This is memory-only and resets on restart.
const recentUploads = new Map();
const keyFor = (message) => `${message.guildId || "dm"}:${message.channelId}:${message.author.id}`;
const isAllowed = (message) =>
  ALLOWED_USER_IDS.length === 0 || ALLOWED_USER_IDS.includes(message.author.id);

function safeName(name) {
  const base = path.basename(name || "script.lua").replace(/[^\w.\-]/g, "_");
  return base.slice(0, 100) || "script.lua";
}

async function downloadAttachment(attachment) {
  if (attachment.size > MAX_BYTES) throw new Error(`File is too large. Limit: ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.`);
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`Couldn't download attachment (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error("Downloaded file exceeded the size limit.");
  return bytes;
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const attachments = [...message.attachments.values()];
  if (attachments.length) {
    const supported = attachments.find(a => /\.(lua|txt)$/i.test(a.name || ""));
    if (supported) {
      recentUploads.set(keyFor(message), {
        attachment: {
          url: supported.url,
          name: safeName(supported.name),
          size: supported.size
        },
        at: Date.now()
      });
      await message.reply(`Saved **${safeName(supported.name)}**. Send \`${PREFIX}deobf\` to process it.`);
    } else {
      await message.reply("Please upload a `.lua` or `.txt` file.");
    }
    return;
  }

  if (!message.content.trim().toLowerCase().startsWith(`${PREFIX}deobf`)) return;
  if (!isAllowed(message)) {
    await message.reply("You are not allowed to use this bot.");
    return;
  }

  const key = keyFor(message);
  const saved = recentUploads.get(key);
  if (!saved) {
    await message.reply(`Upload a \`.lua\` or \`.txt\` file first, then send \`${PREFIX}deobf\` in this channel.`);
    return;
  }
  if (Date.now() - saved.at > 15 * 60 * 1000) {
    recentUploads.delete(key);
    await message.reply("That upload expired. Upload the file again and retry.");
    return;
  }
  if (saved.attachment.size > MAX_BYTES) {
    recentUploads.delete(key);
    await message.reply(`File is too large. Limit: ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.`);
    return;
  }

  const status = await message.reply("Processing the script…");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdeobf-"));
  try {
    const inputPath = path.join(tempDir, saved.attachment.name);
    const bytes = await downloadAttachment(saved.attachment);
    await fs.writeFile(inputPath, bytes);

    // This runs the deobfuscator only; uploaded Lua is never executed.
    const source = bytes.toString("latin1");
    let result;
    try {
      result = deobfuscate(source, { name: saved.attachment.name });
    } catch (err) {
      if (err instanceof NotPrometheusError) {
        await status.edit("This file was not recognized as a supported Prometheus-obfuscated script. No output was produced.");
        return;
      }
      throw err;
    }

    const output = Buffer.from(result.code, "latin1");
    if (output.length > MAX_OUTPUT_BYTES) {
      await status.edit("The deobfuscated output is too large to send as a Discord attachment.");
      return;
    }
    const outputName = `${path.parse(saved.attachment.name).name}.deobfuscated.lua`;
    const file = new AttachmentBuilder(output, { name: outputName });
    await status.edit({ content: `Finished **${saved.attachment.name}**. Review the output before running it.`, files: [file] });
    recentUploads.delete(key);
  } catch (err) {
    console.error("Deobfuscation failed:", err);
    await status.edit("Couldn't process that file. It may be malformed, unsupported, or too large.");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

client.login(TOKEN);

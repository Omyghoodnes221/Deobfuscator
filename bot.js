
const {
  Client,
  GatewayIntentBits,
  Partials,
  AttachmentBuilder
} = require("discord.js");

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  deobfuscate,
  NotPrometheusError,
  parse,
  unparse
} = require("./deobfuscator/src/index");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.COMMAND_PREFIX || ".";
const MAX_BYTES = Number(
  process.env.MAX_FILE_BYTES || 7 * 1024 * 1024
);
const MAX_OUTPUT_BYTES = Number(
  process.env.MAX_OUTPUT_BYTES || 7 * 1024 * 1024
);

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

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

// Recent uploads are kept in memory and reset on restart.
const recentUploads = new Map();

const keyFor = message =>
  `${message.guildId || "dm"}:${message.channelId}:${message.author.id}`;

const isAllowed = message =>
  ALLOWED_USER_IDS.length === 0 ||
  ALLOWED_USER_IDS.includes(message.author.id);

function safeName(name) {
  const base = path.basename(name || "script.lua")
    .replace(/[^\w.\-]/g, "_");

  return base.slice(0, 100) || "script.lua";
}

async function downloadAttachment(attachment) {
  if (attachment.size > MAX_BYTES) {
    throw new Error(
      `File is too large. Limit: ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.`
    );
  }

  const response = await fetch(attachment.url);

  if (!response.ok) {
    throw new Error(
      `Couldn't download attachment (HTTP ${response.status}).`
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length > MAX_BYTES) {
    throw new Error("Downloaded file exceeded the size limit.");
  }

  return bytes;
}

/*
 * Recovery strategy:
 * 1. Run the normal Prometheus-aware pipeline.
 * 2. If that fails, run the pipeline without Prometheus detection.
 * 3. If transformations fail, try parsing and formatting.
 * 4. If parsing fails, preserve the original source.
 *
 * Uploaded Lua is never executed.
 */
function recoverSource(source, name) {
  let firstError;

  try {
    const result = deobfuscate(source, { name });

    return {
      ...result,
      recoveryMode: "Prometheus pipeline"
    };
  } catch (error) {
    firstError = error;
  }

  try {
    const result = deobfuscate(source, {
      name,
      detect: false
    });

    return {
      ...result,
      recoveryMode: firstError instanceof NotPrometheusError
        ? "General recovery attempt"
        : "Fallback recovery attempt"
    };
  } catch (error) {
    console.warn("General recovery failed:", error.message);
  }

  try {
    const ast = parse(source, { name });
    const formatted = unparse(ast);

    return {
      code: formatted,
      warnings: [
        "Advanced recovery failed; output was formatted only."
      ],
      recoveryMode: "Format-only fallback"
    };
  } catch (error) {
    console.warn("Formatting fallback failed:", error.message);

    return {
      code: source,
      warnings: [
        "Automatic recovery and parsing failed. Original source preserved."
      ],
      recoveryMode: "Original-source fallback"
    };
  }
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;

  const attachments = [...message.attachments.values()];

  // Save a Lua or TXT upload for the next .deobf command.
  if (attachments.length) {
    if (!isAllowed(message)) {
      await message.reply("You are not allowed to use this bot.");
      return;
    }

    const supported = attachments.find(a =>
      /\.(lua|txt)$/i.test(a.name || "")
    );

    if (supported) {
      recentUploads.set(keyFor(message), {
        attachment: {
          url: supported.url,
          name: safeName(supported.name),
          size: supported.size
        },
        at: Date.now()
      });

      await message.reply(
        `Saved **${safeName(supported.name)}**. ` +
        `Send \`${PREFIX}deobf\` to process it.`
      );
    } else {
      await message.reply("Please upload a `.lua` or `.txt` file.");
    }

    return;
  }

  if (
    !message.content.trim().toLowerCase()
      .startsWith(`${PREFIX}deobf`)
  ) {
    return;
  }

  if (!isAllowed(message)) {
    await message.reply("You are not allowed to use this bot.");
    return;
  }

  const key = keyFor(message);
  const saved = recentUploads.get(key);

  if (!saved) {
    await message.reply(
      `Upload a \`.lua\` or \`.txt\` file first, then send ` +
      `\`${PREFIX}deobf\` in this channel.`
    );
    return;
  }

  if (Date.now() - saved.at > 15 * 60 * 1000) {
    recentUploads.delete(key);

    await message.reply(
      "That upload expired. Upload the file again and retry."
    );
    return;
  }

  if (saved.attachment.size > MAX_BYTES) {
    recentUploads.delete(key);

    await message.reply(
      `File is too large. Limit: ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.`
    );
    return;
  }

  const status = await message.reply(
    "Processing the script and trying available recovery methods..."
  );

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pdeobf-")
  );

  try {
    const bytes = await downloadAttachment(saved.attachment);
    const inputPath = path.join(tempDir, saved.attachment.name);

    await fs.writeFile(inputPath, bytes);

    // Decode source as the existing project expects.
    const source = bytes.toString("latin1");

    const result = recoverSource(
      source,
      saved.attachment.name
    );

    const output = Buffer.from(result.code, "latin1");

    if (output.length > MAX_OUTPUT_BYTES) {
      await status.edit(
        "The recovered output is too large to send as a Discord attachment."
      );
      return;
    }

    const outputName =
      `${path.parse(saved.attachment.name).name}.deobfuscated.lua`;

    const file = new AttachmentBuilder(output, {
      name: outputName
    });

    const warnings = Array.isArray(result.warnings)
      ? result.warnings
          .map(w => typeof w === "string" ? w : JSON.stringify(w))
          .slice(0, 3)
      : [];

    let description =
      `Finished **${saved.attachment.name}**.\n` +
      `Method: **${result.recoveryMode}**.\n` +
      "Review the output before running it.";

    if (warnings.length) {
      description += "\n\nNotes:\n" +
        warnings.join("\n").slice(0, 700);
    }

    await status.edit({
      content: description,
      files: [file]
    });

    recentUploads.delete(key);
  } catch (error) {
    console.error("Deobfuscation failed:", error);

    await status.edit(
      "Couldn't process or send this file. " +
      "Check the file format, size limits, and server logs."
    );
  } finally {
    await fs.rm(tempDir, {
      recursive: true,
      force: true
    }).catch(() => {});
  }
});

client.login(TOKEN);

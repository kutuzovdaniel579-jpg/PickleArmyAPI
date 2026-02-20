import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: ["CHANNEL"]
});

const token = process.env.DISCORD_TOKEN;

if (token) {
  client.login(token).catch(console.error);
} else {
  console.warn("DISCORD_TOKEN not set – Discord codes will be skipped.");
}

export async function sendSecurityCode(discordId, code) {
  if (!client.isReady()) return;
  try {
    const user = await client.users.fetch(discordId);
    await user.send(`Jouw PickleBank beveiligingscode is: **${code}**`);
  } catch (e) {
    console.error("Failed to send Discord code:", e);
  }
}

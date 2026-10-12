// Registers the Discord commands for Peak Vault (run once, or after changing commands).
//
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs
//
// Or run the "Register Discord commands" GitHub Action (uses repo secrets).

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!appId || !token) {
  console.error("Set DISCORD_APP_ID and DISCORD_BOT_TOKEN.");
  process.exit(1);
}

// integration_types: 0 = server install, 1 = user install (this is what makes it work in DMs)
// contexts: 0 = servers, 1 = DMs with the bot, 2 = DMs & group DMs between users
const everywhere = { integration_types: [0, 1], contexts: [0, 1, 2] };

const commands = [
  { name: "Save to Vault", type: 3, ...everywhere },                                 // right-click a message → Apps
  { name: "vault", type: 1, description: "Get the link to the vault", ...everywhere }, // /vault
];

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});

const body = await res.text();
if (!res.ok) {
  console.error(`Discord said ${res.status}: ${body}`);
  process.exit(1);
}
console.log("Registered:", JSON.parse(body).map((c) => c.name).join(", "));

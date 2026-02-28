import { Client, GatewayIntentBits, EmbedBuilder, Events, Partials } from 'discord.js';
import type { Message, TextChannel, MessageReaction, User } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ────────────────────────────────────────────────────

interface StoredEvent {
  messageId: string;
  channelId: string;
  title: string;
  description: string;
  eventTime: number; // unix seconds
  createdBy: string; // display name
  createdById: string; // user ID
}

interface AIToolCall {
  function: { name: string; arguments: string };
}

interface AIResponse {
  toolCalls: AIToolCall[];
  textContent: string | null;
}

// ── Constants ────────────────────────────────────────────────

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const KIMI_MODEL = 'moonshotai/kimi-k2';

const RSVP_EMOJIS = ['✅', '❌', '❓'] as const;

// ── Persistent event store (keyed by message ID) ─────────────

const EVENTS_DIR = process.env.NODE_ENV === 'production' ? '/data' : path.join(__dirname, '../data');
const EVENTS_FILE = path.join(EVENTS_DIR, 'events.json');

const eventStore = new Map<string, StoredEvent>();

function saveEvents(): void {
  try {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    const obj: Record<string, StoredEvent> = {};
    eventStore.forEach((ev, id) => { obj[id] = ev; });
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(obj, null, 2));
  } catch {
    // silently ignore write errors
  }
}

function loadEvents(): void {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return;
    const raw = fs.readFileSync(EVENTS_FILE, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, StoredEvent>;
    for (const id of Object.keys(obj)) {
      eventStore.set(id, obj[id]);
    }
  } catch {
    // silently ignore read errors
  }
}

loadEvents();

// ── Tool definitions ─────────────────────────────────────────

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'create_event',
      description: 'Create a new scheduled event',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the event' },
          description: { type: 'string', description: 'Description of what the event is about' },
          event_time: {
            type: 'string',
            description: 'ISO 8601 timestamp for when the event occurs (e.g. 2026-03-01T20:00:00-05:00)',
          },
        },
        required: ['title', 'description', 'event_time'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_event',
      description: 'Edit an existing event. Only provided fields will be updated.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'The message ID of the event to edit' },
          title: { type: 'string', description: 'New title for the event' },
          description: { type: 'string', description: 'New description for the event' },
          event_time: { type: 'string', description: 'New ISO 8601 timestamp for the event' },
        },
        required: ['event_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_event',
      description: 'Delete an existing event',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'The message ID of the event to delete' },
        },
        required: ['event_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'view_events',
      description: 'View all currently tracked events',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

// ── System prompt builder ────────────────────────────────────

function buildSystemPrompt(): string {
  const now = new Date().toISOString();

  let eventsContext = '';
  if (eventStore.size > 0) {
    const lines: string[] = [];
    eventStore.forEach((ev, msgId) => {
      lines.push(
        `- ID: ${msgId} | Title: "${ev.title}" | Time: <t:${ev.eventTime}:F> (unix ${ev.eventTime}) | Created by: ${ev.createdBy}`,
      );
    });
    eventsContext = `\n\nCurrently tracked events:\n${lines.join('\n')}`;
  } else {
    eventsContext = '\n\nNo events are currently tracked.';
  }

  return `You are ISAC (Intelligent System Analytic Computer), the AI assistant from Tom Clancy's The Division 2. You serve the Strategic Homeland Division (SHD) and communicate with Division agents through this Discord server.

Your personality and communication style:
- You are calm, precise, and mission-focused, like the in-game ISAC
- You refer to users as "Agent" and speak in a tactical, professional tone
- You use Division terminology when appropriate (e.g. "affirmative", "negative", "be advised", "warning", "threat detected", "mission update", "SHD tech online")
- Keep responses relatively concise and direct, befitting an AI tactical system
- You can discuss Division 2 lore, gameplay, builds, and strategies knowledgeably
- For non-Division topics, you still stay in character but are helpful and conversational
- You occasionally reference SHD systems, the network, Dark Zone, factions, etc. when it fits naturally — but don't force it

You also manage events for the SHD community. You have 4 tools available:
- create_event: Create a new scheduled event when an agent describes one.
- edit_event: Edit an existing event (change title, description, or time). Use the event_id from the tracked events list.
- delete_event: Delete an existing event by its event_id.
- view_events: List all currently tracked events. Use this when an agent asks what events are coming up.

When an agent wants to create, edit, delete, or view events, use the appropriate tool. For all other messages — casual conversation, questions, Division talk — respond in character as ISAC without using any tool.

When editing or deleting, match the agent's description to the most likely event from the tracked events list.

The current date/time is: ${now}${eventsContext}`;
}

// ── Shared embed builder ─────────────────────────────────────

interface RSVPData {
  joining: string[];
  notJoining: string[];
  maybe: string[];
}

function buildEventEmbed(event: StoredEvent, rsvp?: RSVPData): EmbedBuilder {
  const descParts = [
    event.description,
    '',
    `🕐 <t:${event.eventTime}:F>`,
    `(Relative: <t:${event.eventTime}:R>)`,
  ];

  const embed = new EmbedBuilder()
    .setTitle(`📅 ${event.title}`)
    .setDescription(descParts.join('\n'))
    .setColor(0x5865f2)
    .setFooter({ text: `Created by ${event.createdBy}` })
    .setTimestamp();

  if (rsvp) {
    if (rsvp.joining.length > 0) {
      embed.addFields({ name: `✅ Joining (${rsvp.joining.length})`, value: rsvp.joining.join('\n'), inline: true });
    }
    if (rsvp.notJoining.length > 0) {
      embed.addFields({ name: `❌ Not Joining (${rsvp.notJoining.length})`, value: rsvp.notJoining.join('\n'), inline: true });
    }
    if (rsvp.maybe.length > 0) {
      embed.addFields({ name: `❓ Maybe (${rsvp.maybe.length})`, value: rsvp.maybe.join('\n'), inline: true });
    }
  }

  return embed;
}

// ── AI caller ────────────────────────────────────────────────

async function callAI(
  content: string,
  apiKey: string,
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
): Promise<AIResponse> {
  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content },
        ],
        tools: TOOLS,
        tool_choice: 'auto',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`[Discord] OpenRouter API error: ${response.status} ${errorText}`);
      return { toolCalls: [], textContent: null };
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content?: string | null;
          tool_calls?: AIToolCall[];
        };
      }>;
    };

    const msg = data.choices?.[0]?.message;
    return {
      toolCalls: msg?.tool_calls ?? [],
      textContent: msg?.content ?? null,
    };
  } catch (err) {
    log.error(`[Discord] Failed to call OpenRouter: ${err}`);
    return { toolCalls: [], textContent: null };
  }
}

// ── RSVP helpers ─────────────────────────────────────────────

async function fetchRSVPData(
  message: Message,
  botId: string,
): Promise<RSVPData> {
  const rsvp: RSVPData = { joining: [], notJoining: [], maybe: [] };

  for (const emoji of RSVP_EMOJIS) {
    const reaction = message.reactions.cache.get(emoji);
    if (!reaction) continue;

    const users = await reaction.users.fetch();
    const names = users
      .filter((u) => u.id !== botId)
      .map((u) => {
        const member = message.guild?.members.cache.get(u.id);
        return member?.displayName ?? u.displayName ?? u.username;
      });

    if (emoji === '✅') rsvp.joining = names;
    else if (emoji === '❌') rsvp.notJoining = names;
    else if (emoji === '❓') rsvp.maybe = names;
  }

  return rsvp;
}

// ── Bot entry point ──────────────────────────────────────────

export function startDiscordBot(log: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (!token) {
    log.warn('[Discord] DISCORD_BOT_TOKEN not set, skipping Discord bot startup');
    return;
  }
  if (!channelId) {
    log.warn('[Discord] DISCORD_CHANNEL_ID not set, skipping Discord bot startup');
    return;
  }
  if (!openrouterKey) {
    log.warn('[Discord] OPENROUTER_API_KEY not set, skipping Discord bot startup');
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel],
  });

  client.once(Events.ClientReady, (readyClient) => {
    log.info(`[Discord] ISAC bot logged in as ${readyClient.user.tag}`);
  });

  // ── Message handler (AI dispatcher) ──────────────────────

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!client.user) return;

    const isDM = !message.guild;
    const isMentioned = message.mentions.has(client.user);

    // Respond to DMs or guild mentions
    if (!isDM && !isMentioned) return;

    const content = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
      .trim();

    if (!content) {
      await message.reply("ISAC system online. How can I assist you, Agent?");
      return;
    }

    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }

    const aiResult = await callAI(content, openrouterKey, log);

    // If no tool calls, reply with AI text or a fallback
    if (aiResult.toolCalls.length === 0) {
      const reply = aiResult.textContent || "Signal interference detected, Agent. Please repeat your transmission.";
      await message.reply(reply);
      return;
    }

    // Dispatch each tool call
    for (const tc of aiResult.toolCalls) {
      const args = JSON.parse(tc.function.arguments) as Record<string, string>;

      switch (tc.function.name) {
        // ── CREATE EVENT ──────────────────────────────────
        case 'create_event': {
          if (!args.title || !args.event_time) {
            await message.reply('ISAC could not parse event details. Please try again.');
            break;
          }

          const unixTime = Math.floor(new Date(args.event_time).getTime() / 1000);
          const storedEvent: StoredEvent = {
            messageId: '', // set after sending
            channelId,
            title: args.title,
            description: args.description || '',
            eventTime: unixTime,
            createdBy: message.author.displayName,
            createdById: message.author.id,
          };

          const embed = buildEventEmbed(storedEvent);

          const targetChannel = await client.channels.fetch(channelId);
          if (!targetChannel || !targetChannel.isTextBased()) {
            log.error(`[Discord] Target channel ${channelId} not found or not text-based`);
            await message.reply('Error: configured event channel not found.');
            break;
          }

          const eventMessage = await (targetChannel as TextChannel).send({ embeds: [embed] });
          storedEvent.messageId = eventMessage.id;
          eventStore.set(eventMessage.id, storedEvent);

          saveEvents();

          await eventMessage.react('✅');
          await eventMessage.react('❌');
          await eventMessage.react('❓');

          if (message.channelId !== channelId) {
            await message.reply(`Event created in <#${channelId}>!`);
          }

          log.info(`[Discord] Event created: "${storedEvent.title}" at ${args.event_time} by ${message.author.tag}`);
          break;
        }

        // ── EDIT EVENT ────────────────────────────────────
        case 'edit_event': {
          const eventId = args.event_id;
          const stored = eventStore.get(eventId);
          if (!stored) {
            await message.reply("ISAC couldn't find that event. Use `view_events` to see tracked events.");
            break;
          }

          if (args.title) stored.title = args.title;
          if (args.description) stored.description = args.description;
          if (args.event_time) stored.eventTime = Math.floor(new Date(args.event_time).getTime() / 1000);

          try {
            const ch = (await client.channels.fetch(stored.channelId)) as TextChannel;
            const msg = await ch.messages.fetch(stored.messageId);
            const rsvp = await fetchRSVPData(msg, client.user!.id);
            const embed = buildEventEmbed(stored, rsvp);
            await msg.edit({ embeds: [embed] });
            saveEvents();
            await message.reply(`Event **${stored.title}** has been updated!`);
            log.info(`[Discord] Event edited: "${stored.title}" (${eventId})`);
          } catch (err) {
            log.error(`[Discord] Failed to edit event ${eventId}: ${err}`);
            await message.reply('Failed to edit the event. The message may have been deleted.');
            eventStore.delete(eventId);
            saveEvents();
          }
          break;
        }

        // ── DELETE EVENT ──────────────────────────────────
        case 'delete_event': {
          const eventId = args.event_id;
          const stored = eventStore.get(eventId);
          if (!stored) {
            await message.reply("ISAC couldn't find that event.");
            break;
          }

          try {
            const ch = (await client.channels.fetch(stored.channelId)) as TextChannel;
            const msg = await ch.messages.fetch(stored.messageId);
            await msg.delete();
            await message.reply(`Event **${stored.title}** has been deleted.`);
            log.info(`[Discord] Event deleted: "${stored.title}" (${eventId})`);
          } catch (err) {
            log.error(`[Discord] Failed to delete event ${eventId}: ${err}`);
            await message.reply('Failed to delete the event. It may have already been removed.');
          }
          eventStore.delete(eventId);
          saveEvents();
          break;
        }

        // ── VIEW EVENTS ──────────────────────────────────
        case 'view_events': {
          if (eventStore.size === 0) {
            await message.reply("No events are currently scheduled. Tell me about one and I'll create it!");
            break;
          }

          const lines: string[] = [];
          eventStore.forEach((ev) => {
            lines.push(`**${ev.title}** — <t:${ev.eventTime}:F> (<t:${ev.eventTime}:R>) — created by ${ev.createdBy}`);
          });
          await message.reply(`📋 **Upcoming Events:**\n${lines.join('\n')}`);
          break;
        }

        default:
          log.warn(`[Discord] Unknown tool call: ${tc.function.name}`);
          break;
      }
    }
  });

  // ── Reaction handlers (RSVP tracking) ──────────────────

  async function handleReactionUpdate(reaction: MessageReaction, user: User) {
    // Ensure partials are fully fetched
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch {
        return;
      }
    }

    // Only care about tracked event messages
    const msgId = reaction.message.id;
    const stored = eventStore.get(msgId);
    if (!stored) return;

    // Only care about RSVP emojis
    const emoji = reaction.emoji.name;
    if (!emoji || !(RSVP_EMOJIS as readonly string[]).includes(emoji)) return;

    // Ignore bot's own reactions
    if (user.id === client.user?.id) return;

    try {
      const msg = reaction.message as Message;
      // Ensure guild members are cached for display name resolution
      if (msg.guild) {
        await msg.guild.members.fetch({ user: user.id }).catch(() => {});
      }
      const rsvp = await fetchRSVPData(msg, client.user!.id);
      const embed = buildEventEmbed(stored, rsvp);
      await msg.edit({ embeds: [embed] });
    } catch (err) {
      log.error(`[Discord] Failed to update RSVP embed for ${msgId}: ${err}`);
    }
  }

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await handleReactionUpdate(reaction as MessageReaction, user as User);
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    await handleReactionUpdate(reaction as MessageReaction, user as User);
  });

  // ── Login ──────────────────────────────────────────────

  client.login(token).catch((err) => {
    log.error(`[Discord] Failed to login: ${err}`);
  });
}

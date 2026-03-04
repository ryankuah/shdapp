import {
  Client,
  GatewayIntentBits,
  Events,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
} from 'discord.js';
import type { Message, GuildScheduledEvent } from 'discord.js';

// ── Types ────────────────────────────────────────────────────

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
          duration_hours: {
            type: 'number',
            description: 'Duration of the event in hours (default: 1)',
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
          event_id: { type: 'string', description: 'The Discord scheduled event ID' },
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
          event_id: { type: 'string', description: 'The Discord scheduled event ID' },
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

function buildSystemPrompt(events: GuildScheduledEvent[]): string {
  const now = new Date().toISOString();

  let eventsContext = '';
  if (events.length > 0) {
    const lines = events.map((e) => {
      const unix = Math.floor(e.scheduledStartTimestamp! / 1000);
      return `- ID: ${e.id} | Title: "${e.name}" | Time: <t:${unix}:F> (unix ${unix})`;
    });
    eventsContext = `\n\nCurrently scheduled events:\n${lines.join('\n')}`;
  } else {
    eventsContext = '\n\nNo events are currently scheduled.';
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
- edit_event: Edit an existing event (change title, description, or time). Use the event_id from the scheduled events list.
- delete_event: Delete an existing event by its event_id.
- view_events: List all currently scheduled events. Use this when an agent asks what events are coming up.

When an agent wants to create, edit, delete, or view events, use the appropriate tool. For all other messages — casual conversation, questions, Division talk — respond in character as ISAC without using any tool.

When editing or deleting, match the agent's description to the most likely event from the scheduled events list.

The current date/time is: ${now}${eventsContext}`;
}

// ── AI caller ────────────────────────────────────────────────

async function callAI(
  content: string,
  apiKey: string,
  events: GuildScheduledEvent[],
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
          { role: 'system', content: buildSystemPrompt(events) },
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

// ── Bot entry point ──────────────────────────────────────────

export function startDiscordBot(log: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (!token) {
    log.warn('[Discord] DISCORD_BOT_TOKEN not set, skipping Discord bot startup');
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
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildScheduledEvents,
    ],
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

    // Pre-fetch guild scheduled events for context
    let guildEvents: GuildScheduledEvent[] = [];
    if (message.guild) {
      try {
        const fetched = await message.guild.scheduledEvents.fetch();
        guildEvents = [...fetched.filter((e) => e.isScheduled()).values()];
      } catch {
        // ignore fetch errors — events context will just be empty
      }
    }

    const aiResult = await callAI(content, openrouterKey, guildEvents, log);

    // If no tool calls, reply with AI text or a fallback
    if (aiResult.toolCalls.length === 0) {
      const reply = aiResult.textContent || "Signal interference detected, Agent. Please repeat your transmission.";
      await message.reply(reply);
      return;
    }

    // Dispatch each tool call
    for (const tc of aiResult.toolCalls) {
      const args = JSON.parse(tc.function.arguments) as Record<string, string>;

      // Guild-only guard for all event tools
      if (!message.guild) {
        await message.reply('Events can only be managed from a server channel.');
        continue;
      }

      switch (tc.function.name) {
        // ── CREATE EVENT ──────────────────────────────────
        case 'create_event': {
          if (!args.title || !args.event_time) {
            await message.reply('ISAC could not parse event details. Please try again.');
            break;
          }

          try {
            const startTime = new Date(args.event_time);
            const endTime = new Date(startTime.getTime() + (Number(args.duration_hours) || 1) * 3600000);
            const event = await message.guild.scheduledEvents.create({
              name: args.title,
              description: args.description || '',
              scheduledStartTime: startTime,
              scheduledEndTime: endTime,
              privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
              entityType: GuildScheduledEventEntityType.External,
              entityMetadata: { location: 'In-game' },
            });
            await message.reply(`Event **${event.name}** created! Check the server events tab.`);
            log.info(`[Discord] Event created: "${event.name}" at ${args.event_time} by ${message.author.tag}`);
          } catch (err) {
            log.error(`[Discord] Failed to create event: ${err}`);
            await message.reply('Failed to create the event. Please try again.');
          }
          break;
        }

        // ── EDIT EVENT ────────────────────────────────────
        case 'edit_event': {
          try {
            const event = await message.guild.scheduledEvents.fetch(args.event_id);
            const updates: Record<string, unknown> = {};
            if (args.title) updates.name = args.title;
            if (args.description) updates.description = args.description;
            if (args.event_time) {
              updates.scheduledStartTime = new Date(args.event_time);
              updates.scheduledEndTime = new Date(new Date(args.event_time).getTime() + 3600000);
            }
            await event.edit(updates);
            await message.reply(`Event **${event.name}** updated!`);
            log.info(`[Discord] Event edited: "${event.name}" (${args.event_id})`);
          } catch (err) {
            log.error(`[Discord] Failed to edit event ${args.event_id}: ${err}`);
            await message.reply("ISAC couldn't find or update that event. It may no longer exist.");
          }
          break;
        }

        // ── DELETE EVENT ──────────────────────────────────
        case 'delete_event': {
          try {
            const event = await message.guild.scheduledEvents.fetch(args.event_id);
            const name = event.name;
            await event.delete();
            await message.reply(`Event **${name}** deleted.`);
            log.info(`[Discord] Event deleted: "${name}" (${args.event_id})`);
          } catch (err) {
            log.error(`[Discord] Failed to delete event ${args.event_id}: ${err}`);
            await message.reply("ISAC couldn't find that event. It may have already been removed.");
          }
          break;
        }

        // ── VIEW EVENTS ──────────────────────────────────
        case 'view_events': {
          try {
            const events = await message.guild.scheduledEvents.fetch();
            const upcoming = events.filter((e) => e.isScheduled());

            if (upcoming.size === 0) {
              await message.reply("No events are currently scheduled. Tell me about one and I'll create it!");
              break;
            }

            const lines = upcoming.map((e) => {
              const unix = Math.floor(e.scheduledStartTimestamp! / 1000);
              return `**${e.name}** — <t:${unix}:F> (<t:${unix}:R>)`;
            });
            await message.reply(`📋 **Upcoming Events:**\n${[...lines.values()].join('\n')}`);
          } catch (err) {
            log.error(`[Discord] Failed to fetch events: ${err}`);
            await message.reply('Failed to retrieve events. Please try again.');
          }
          break;
        }

        default:
          log.warn(`[Discord] Unknown tool call: ${tc.function.name}`);
          break;
      }
    }
  });

  // ── Login ──────────────────────────────────────────────

  client.login(token).catch((err) => {
    log.error(`[Discord] Failed to login: ${err}`);
  });
}

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, Partials } from 'discord.js'
import { SimpleShardingStrategy } from '@discordjs/ws'
import type { ChannelTransport } from '../proxy'
import type { RESTOptions } from 'discord.js'
import type { ChannelAdapter, InterventionRequest, RemoteMessage } from '../types'

export class DiscordChannel implements ChannelAdapter {
  private client: Client
  constructor(readonly id: string, readonly destination: string, readonly allowedUsers: string[], private readonly token: string, transport?: ChannelTransport) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel],
      rest: transport ? { makeRequest: transport.nodeRequest as unknown as RESTOptions['makeRequest'] } : undefined,
      ws: transport ? { buildStrategy: manager => {
        // patches/@discordjs+ws+1.2.3.patch forwards this per-manager agent to every
        // handshake, including resumed sessions. No global WebSocket mutation.
        Object.assign(manager.options, { islandAgent: transport.agent })
        return new SimpleShardingStrategy(manager)
      } } : undefined
    })
  }
  async start(receive: (message: RemoteMessage) => Promise<string>): Promise<void> {
    this.client.on('error', () => {})
    this.client.on('messageCreate', message => {
      if (message.author.bot) return
      void receive({ eventId: message.id, sender: message.author.id, chat: message.channelId, text: message.content, replyTo: message.reference?.messageId })
        .then(async reply => { if (reply) for (const chunk of chunks(reply)) await message.reply({ content: chunk, allowedMentions: { parse: [], repliedUser: false } }) }).catch(() => {})
    })
    this.client.on('interactionCreate', interaction => {
      if (!interaction.isButton()) return
      void (async () => {
        if (interaction.channelId !== this.destination || !this.allowedUsers.includes(interaction.user.id)) return
        await interaction.deferReply({ flags: 64 })
        const [requestId, revision, action] = interaction.customId.split(':')
        const reply = await receive({ eventId: interaction.id, sender: interaction.user.id, chat: interaction.channelId!, action: { requestId, revision: Number(revision), decision: { action: action as 'approve' } } })
        await interaction.editReply({ content: reply || '未处理', allowedMentions: { parse: [] } })
      })().catch(() => {})
    })
    await this.client.login(this.token)
  }
  private async channel() {
    const channel = await this.client.channels.fetch(this.destination)
    if (!channel?.isSendable()) throw new Error('Discord 目标频道不可发送消息')
    return channel
  }
  async send(text: string, request?: InterventionRequest): Promise<string> {
    const channel = await this.channel()
    const message = await channel.send({ content: text.slice(0, 1900), components: buttons(request), allowedMentions: { parse: [] } })
    return message.id
  }
  async update(messageId: string, text: string, request: InterventionRequest): Promise<void> {
    const channel = await this.channel()
    await channel.messages.edit(messageId, { content: text.slice(0, 1900), components: buttons(request), allowedMentions: { parse: [] } })
  }
  close(): void { void this.client.destroy() }
}
function buttons(r?: InterventionRequest): ActionRowBuilder<ButtonBuilder>[] {
  if (!r || r.status !== 'pending') return []
  const actions = r.actions.filter(a => a !== 'answer')
  return actions.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(actions.map(action => new ButtonBuilder()
    .setCustomId(`${r.id}:${r.revision}:${action}`).setLabel({ approve: '批准一次', deny: '拒绝', cancel: '取消', ack: '知道了', resume: '继续会话' }[action]).setStyle(ButtonStyle.Secondary)))] : []
}
export function chunks(text: string, size = 1800): string[] {
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size))
}

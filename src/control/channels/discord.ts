import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, Partials } from 'discord.js'
import { SimpleShardingStrategy } from '@discordjs/ws'
import type { ChannelTransport } from '../proxy'
import type { RESTOptions } from 'discord.js'
import type { ChannelAdapter, ControlSession, InterventionRequest, RemoteMessage } from '../types'
import { ACTION_LABEL, redact, textChunks } from '../notification'
import { discordRequest } from './request-format'

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
        .then(async reply => { if (reply) for (const chunk of chunks(redact(reply))) await message.reply({ content: chunk, allowedMentions: { parse: [], repliedUser: false } }) }).catch(() => {})
    })
    this.client.on('interactionCreate', interaction => {
      if (!interaction.isButton()) return
      void (async () => {
        if (interaction.channelId !== this.destination || !this.allowedUsers.includes(interaction.user.id)) return
        await interaction.deferReply({ flags: 64 })
        const [requestId, revision, action] = interaction.customId.split(':')
        const reply = await receive({ eventId: interaction.id, sender: interaction.user.id, chat: interaction.channelId!,
          ...(action === 'detail' ? { text: `/detail ${requestId}` } : { action: { requestId, revision: Number(revision), decision: { action: action as 'approve' } } }) })
        const pages = chunks(redact(reply || '未处理'))
        await interaction.editReply({ content: pages[0], allowedMentions: { parse: [] } })
        for (const content of pages.slice(1)) await interaction.followUp({ content, flags: 64, allowedMentions: { parse: [] } })
      })().catch(() => {})
    })
    await this.client.login(this.token)
  }
  private async channel() {
    const channel = await this.client.channels.fetch(this.destination)
    if (!channel?.isSendable()) throw new Error('Discord 目标频道不可发送消息')
    return channel
  }
  async send(text: string, request?: InterventionRequest, session?: ControlSession): Promise<string> {
    const channel = await this.channel()
    if (request) {
      const message = await channel.send({ embeds: [discordRequest(request, session)], components: buttons(request), allowedMentions: { parse: [] } })
      return message.id
    }
    let id = ''
    for (const content of chunks(redact(text))) {
      const message = await channel.send({ content, allowedMentions: { parse: [] } })
      id ||= message.id
    }
    return id
  }
  async update(messageId: string, _text: string, request: InterventionRequest, session?: ControlSession): Promise<void> {
    const channel = await this.channel()
    await channel.messages.edit(messageId, { content: '', embeds: [discordRequest(request, session)], components: buttons(request), allowedMentions: { parse: [] } })
  }
  close(): void { void this.client.destroy() }
}
function buttons(r?: InterventionRequest): ActionRowBuilder<ButtonBuilder>[] {
  if (!r) return []
  const actions = r.status === 'pending' ? r.actions.filter(a => a !== 'answer') : []
  return [...(actions.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(actions.map(action => new ButtonBuilder()
    .setCustomId(`${r.id}:${r.revision}:${action}`).setLabel(ACTION_LABEL[action])
    .setStyle(['approve', 'resume'].includes(action) ? ButtonStyle.Primary : action === 'deny' ? ButtonStyle.Danger : ButtonStyle.Secondary)))] : []),
    new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${r.id}:${r.revision}:detail`).setLabel('查看详情').setStyle(ButtonStyle.Secondary))]
}
export function chunks(text: string, size = 1800): string[] {
  return textChunks(text, size)
}

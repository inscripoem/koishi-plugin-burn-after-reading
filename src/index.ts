import { Context, Schema, Session, Bot } from 'koishi'
import {} from 'koishi-plugin-adapter-onebot';

export const name = 'burn-after-reading'
export const inject = ['database']

export interface Config {
  recallDelay: number
  maxDuration: number
  maxUsers: number
  batchRecallInterval: number
}

export const Config: Schema<Config> = Schema.object({
  recallDelay: Schema.number()
    .default(5)
    .min(1)
    .description('关闭阅后即焚后，延迟多少秒开始批量撤回'),
  maxDuration: Schema.number()
    .default(3600)
    .min(1)
    .description('阅后即焚模式的最大持续时长（秒）'),
  maxUsers: Schema.number()
    .default(10)
    .min(1)
    .description('同时开启阅后即焚的最大用户数'),
  batchRecallInterval: Schema.number()
    .default(1)
    .min(0.1)
    .description('批量撤回时每条消息之间的间隔（秒）'),
})

// 数据库表声明
declare module 'koishi' {
  interface Tables {
    burn_after_reading_users: BurnAfterReadingUser
    burn_after_reading_messages: BurnAfterReadingMessage
  }
}

export interface BurnAfterReadingUser {
  id: number
  userId: string
  guildId: string
  channelId: string
  enabledAt: Date
  expiresAt: Date
}

export interface BurnAfterReadingMessage {
  id: number
  messageId: string
  userId: string
  guildId: string
  channelId: string
  sentAt: Date
}

enum GroupRole {
  member = 'member',
  admin = 'admin',
  owner = 'owner',
}



export function apply(ctx: Context, config: Config) {
  // 扩展数据库表
  ctx.model.extend('burn_after_reading_users', {
    id: 'unsigned',
    userId: 'string',
    guildId: 'string',
    channelId: 'string',
    enabledAt: 'timestamp',
    expiresAt: 'timestamp',
  }, {
    autoInc: true,
  })

  ctx.model.extend('burn_after_reading_messages', {
    id: 'unsigned',
    messageId: 'string',
    userId: 'string',
    guildId: 'string',
    channelId: 'string',
    sentAt: 'timestamp',
  }, {
    autoInc: true,
  })

  // 检查 bot 是否具有管理员权限的辅助函数
  async function checkBotPermission(session: Session): Promise<boolean> {
    if (!session.guildId) return false

    try {
      // 尝试获取 bot 的群成员信息以验证其存在于群组中
      const botRole = (await session.onebot.getGroupMemberInfo(session.guildId, session.bot.selfId)).role
      if (botRole === GroupRole.member) {
        return false
      }
      return true 
    } catch (error) {
      ctx.logger.warn('检查 bot 权限失败:', error)
      return false
    }
  }

  async function checkUserRole(session: Session): Promise<boolean> {
    if (!session.guildId) return false

    try {
      // 尝试获取用户的群成员信息以验证其角色
      const userRole = (await session.onebot.getGroupMemberInfo(session.guildId, session.userId)).role
      const botRole = (await session.onebot.getGroupMemberInfo(session.guildId, session.bot.selfId)).role
      if (userRole === GroupRole.owner || (userRole === GroupRole.admin && botRole !== GroupRole.owner)) {
        return false
      }
      return true
    } catch (error) {
      ctx.logger.warn('检查用户角色失败:', error)
      return false
    }
  }
  

  // 存储消息以便稍后批量撤回的辅助函数
  function storeMessageForRecall(session: Session, messageId: string, userId: string) {
    // 仅存储到数据库，不设置定时器
    ctx.database.create('burn_after_reading_messages', {
      messageId,
      userId,
      guildId: session.guildId,
      channelId: session.channelId,
      sentAt: new Date(),
    }).catch(err => ctx.logger.warn('存储消息信息失败:', err))
  }

  async function burnAfterReading(userId: string, guildId: string, channelId: string, bot: Bot) {
    try {
      // 从数据库中删除用户
      await ctx.database.remove('burn_after_reading_users', {
        userId,
        guildId,
      })
      // 从数据库中删除消息
      await batchRecallMessages(userId, guildId, channelId, bot)
    } catch (error) {
      ctx.logger.error('批量撤回过程中出错:', error)
    }
  }

  // 批量撤回用户所有消息的辅助函数
  async function batchRecallMessages(userId: string, guildId: string, channelId: string, bot: Bot) {
    try {
      // 查询该用户的所有消息
      const messages = await ctx.database.get('burn_after_reading_messages', {
        userId,
        guildId,
      })

      if (messages.length === 0) {
        ctx.logger.info(`用户 ${userId} 在群组 ${guildId} 中没有需要撤回的消息`)
        return
      }

      ctx.logger.info(`开始批量撤回用户 ${userId} 的 ${messages.length} 条消息`)

      // 等待 recallDelay 秒后开始批量撤回
      await new Promise(resolve => setTimeout(resolve, config.recallDelay * 1000))

      // 按间隔撤回每条消息
      for (const msg of messages) {
        try {
          await bot.deleteMessage(msg.channelId, msg.messageId)
          ctx.logger.info(`已撤回消息 ${msg.messageId}`)

          // 撤回成功后从数据库中删除
          await ctx.database.remove('burn_after_reading_messages', { id: msg.id })
        } catch (error) {
          ctx.logger.warn(`撤回消息 ${msg.messageId} 失败:`, error)
          // 即使一条消息失败也继续撤回其他消息
        }

        // 等待后再撤回下一条消息（将秒转换为毫秒）
        if (messages.indexOf(msg) < messages.length - 1) {
          await new Promise(resolve => setTimeout(resolve, config.batchRecallInterval * 1000))
        }
      }
      bot.sendMessage(channelId, `感谢使用阅后即焚`)
      ctx.logger.info(`用户 ${userId} 的批量撤回已完成`)
    } catch (error) {
      ctx.logger.error('批量撤回过程中出错:', error)
    }
  }

  // 安排用户过期的辅助函数
  function scheduleExpiration(userId: string, guildId: string, channelId: string, expiresAt: Date, bot: Bot) {
    const delay = expiresAt.getTime() - Date.now()

    if (delay <= 0) return

    // 设置自动过期定时器，无需存储引用
    ctx.setTimeout(async () => {
      try {
        ctx.logger.info(`用户 ${userId} 在群组 ${guildId} 的阅后即焚模式已过期`)

        // Send expiration notification and store the message ID for later recall
        const expireNotificationMsg = await bot.sendMessage(channelId, `用户 ${userId} 的阅后即焚已过期，消息将在 ${config.recallDelay} 秒后销毁`)

        // Store the expiration notification message for recall
        if (expireNotificationMsg && expireNotificationMsg.length > 0) {
          await ctx.database.create('burn_after_reading_messages', {
            messageId: expireNotificationMsg[0],
            userId: userId,
            guildId: guildId,
            channelId: channelId,
            sentAt: new Date(),
          }).catch(err => ctx.logger.warn('存储过期通知消息失败:', err))
        }

        // 触发批量撤回所有消息
        await burnAfterReading(userId, guildId, channelId, bot)
      } catch (error) {
        ctx.logger.warn('处理用户过期失败:', error)
      }
    }, delay)
  }

  ctx.command('阅后即焚', '销毁你未来的消息')

  // 命令：开启阅后即焚模式
  ctx.command('阅后即焚.开启', '开启阅后即焚模式，也可以直接使用“开启阅后即焚”')
    .alias('开启阅后即焚')
    .action(async ({ session }) => {
      if (!session.guildId) {
        return '此命令只能在群组中使用。'
      }

      // 检查 bot 权限
      const hasPermission = await checkBotPermission(session)
      if (!hasPermission) {
        return 'bot没有管理员权限来撤回消息。'
      }

      // 检查用户角色
      const hasRole = await checkUserRole(session)
      if (!hasRole) {
        return '用户管理级别等于或大于bot，无法开启'
      }

      // 检查用户是否在全局范围内已经开启了阅后即焚（不限定群组）
      const userGlobalStatus = await ctx.database.get('burn_after_reading_users', {
        userId: session.userId,
      })

      if (userGlobalStatus.length > 0) {
        const existingRecord = userGlobalStatus[0]

        // 如果在当前群组已经开启
        if (existingRecord.guildId === session.guildId) {
          return '您已经在当前群组开启了阅后即焚模式，请勿重复开启'
        }

        // 如果在其他群组已经开启
        let guildInfo = existingRecord.guildId
        try {
          // 尝试获取群组名称
          const guild = await session.bot.getGuild(existingRecord.guildId)
          if (guild && guild.name) {
            guildInfo = `${guild.name}（${existingRecord.guildId}）`
          }
        } catch (error) {
          // 如果获取失败，只显示群组 ID
          ctx.logger.debug('获取群组信息失败:', error)
        }

        return `您已在群组 ${guildInfo} 中开启了阅后即焚模式，一个用户同时只能在一个群组中使用此功能。请先在该群组关闭后再试。`
      }

      // 检查当前群组的用户数量限制
      const activeUsers = await ctx.database.get('burn_after_reading_users', {
        guildId: session.guildId,
      })

      if (activeUsers.length >= config.maxUsers) {
        return `当前群组已达到最大用户数限制（${config.maxUsers}人），请稍后再试。`
      }

      // 开启阅后即焚模式
      const now = new Date()
      const expiresAt = new Date(now.getTime() + config.maxDuration * 1000)

      await ctx.database.create('burn_after_reading_users', {
        userId: session.userId,
        guildId: session.guildId,
        channelId: session.channelId,
        enabledAt: now,
        expiresAt,
      })

      // 添加本条命令消息
      await ctx.database.create('burn_after_reading_messages', {
        messageId: session.messageId,
        userId: session.userId,
        guildId: session.guildId,
        channelId: session.channelId,
        sentAt: now,
      })

      // 安排过期
      scheduleExpiration(session.userId, session.guildId, session.channelId, expiresAt, session.bot)

      // Send notification and store the message ID for later recall
      const notificationMsg = await session.send(`阅后即焚模式已开启。在关闭前或 ${config.maxDuration} 秒内发送的消息都将延迟 ${config.recallDelay} 秒批量撤回。`)

      // Store the notification message for recall
      if (notificationMsg && notificationMsg.length > 0) {
        await ctx.database.create('burn_after_reading_messages', {
          messageId: notificationMsg[0],
          userId: session.userId,
          guildId: session.guildId,
          channelId: session.channelId,
          sentAt: now,
        }).catch(err => ctx.logger.warn('存储通知消息失败:', err))
      }
    })

  // 命令：关闭阅后即焚模式
  ctx.command('阅后即焚.关闭', '关闭阅后即焚模式，也可以直接使用“关闭阅后即焚”')
    .alias('关闭阅后即焚')
    .action(async ({ session }) => {
      if (!session.guildId) {
        return '此命令只能在群组中使用。'
      }

      // 检查用户在当前群组是否开启了阅后即焚
      const currentGuildStatus = await ctx.database.get('burn_after_reading_users', {
        userId: session.userId,
        guildId: session.guildId,
      })

      if (currentGuildStatus.length === 0) {
        // 检查用户是否在其他群组开启了阅后即焚
        const otherGuildStatus = await ctx.database.get('burn_after_reading_users', {
          userId: session.userId,
        })

        if (otherGuildStatus.length > 0) {
          const existingRecord = otherGuildStatus[0]
          let guildInfo = existingRecord.guildId

          try {
            // 尝试获取群组名称
            const guild = await session.bot.getGuild(existingRecord.guildId)
            if (guild && guild.name) {
              guildInfo = `${guild.name}（${existingRecord.guildId}）`
            }
          } catch (error) {
            // 如果获取失败，只显示群组 ID
            ctx.logger.debug('获取群组信息失败:', error)
          }

          return `您在当前群组没有开启阅后即焚模式。您的阅后即焚模式在群组 ${guildInfo} 中开启，请在该群组执行关闭命令。`
        }

        return '您在当前群组没有开启阅后即焚模式。'
      }

      // Send notification and store the message ID for later recall
      const closeNotificationMsg = await session.send(`阅后即焚模式已关闭。消息将在 ${config.recallDelay} 秒后被销毁`)

      // Store the notification message for recall
      if (closeNotificationMsg && closeNotificationMsg.length > 0) {
        await ctx.database.create('burn_after_reading_messages', {
          messageId: closeNotificationMsg[0],
          userId: session.userId,
          guildId: session.guildId,
          channelId: session.channelId,
          sentAt: new Date(),
        }).catch(err => ctx.logger.warn('存储关闭通知消息失败:', err))
      }

      // 异步触发批量撤回（不等待完成）
      burnAfterReading(session.userId, session.guildId, session.channelId, session.bot)
        .catch(err => ctx.logger.error('阅后即焚出错:', err))
    })

  // 监听消息并存储以便稍后批量撤回
  ctx.on('message', async (session) => {
    if (!session.guildId || !session.messageId) return

    // 检查用户是否开启了阅后即焚模式
    const users = await ctx.database.get('burn_after_reading_users', {
      userId: session.userId,
      guildId: session.guildId,
    })

    if (users.length === 0) return

    // 存储消息以便稍后批量撤回
    storeMessageForRecall(session, session.messageId, session.userId)
  })

  // 插件初始化
  ctx.on('ready', async () => {
    try {
      // 仅恢复用户过期定时器
      const activeUsers = await ctx.database.get('burn_after_reading_users', {})
      for (const user of activeUsers) {
        if (new Date(user.expiresAt) > new Date()) {
          // 获取 bot 实例以传递给 scheduleExpiration
          const bot = ctx.bots[Object.keys(ctx.bots)[0]]
          if (bot) {
            scheduleExpiration(user.userId, user.guildId, user.channelId, new Date(user.expiresAt), bot)
          }
        } else {
          // 获取 bot 实例用于批量撤回
          const bot = ctx.bots[Object.keys(ctx.bots)[0]]
          if (bot) {
            await burnAfterReading(user.userId, user.guildId, user.channelId, bot)
          }
        }
      }

      ctx.logger.info('阅后即焚插件加载成功')
    } catch (error) {
      ctx.logger.error('插件初始化失败:', error)
    }
  })
}

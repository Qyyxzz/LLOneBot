import { Context } from 'cordis'
import { OB11MessageData, OB11MessageDataType, OB11MessageNode } from '../types'
import { Msg, Media } from '@/ntqqapi/proto'
import { ProtoField, ProtoMessage } from '@saltify/typeproto'
import { handleOb11RichMedia, message2List } from './createMessage'
import { selfInfo } from '@/common/globalVars'
import { ElementType, Peer, RichMediaUploadCompleteNotify } from '@/ntqqapi/types'
import { deflateSync } from 'node:zlib'
import faceConfig from '@/ntqqapi/helper/face_config.json'
import { InferProtoModelInput } from '@saltify/typeproto'
import { stat } from 'node:fs/promises'

// 最大嵌套深度
const MAX_FORWARD_DEPTH = 3

export class MessageEncoder {
  static support = ['text', 'face', 'image', 'markdown', 'forward', 'node']
  results: InferProtoModelInput<typeof Msg.Message>[]
  children: InferProtoModelInput<typeof Msg.Elem>[]
  deleteAfterSentFiles: string[]
  isGroup: boolean
  seq: number
  tsum: number
  preview: string
  news: { text: string }[]
  name?: string
  uin?: number
  depth: number = 0

  constructor(private ctx: Context, private peer: Peer, depth: number = 0) {
    this.results = []
    this.children = []
    this.deleteAfterSentFiles = []
    this.isGroup = peer.chatType === 2
    this.seq = Math.trunc(Math.random() * 65430)
    this.tsum = 0
    this.preview = ''
    this.news = []
    this.depth = depth
  }

  async flush() {
    if (this.children.length === 0) return

    const nick = this.name || selfInfo.nick || 'QQ用户'

    if (this.news.length < 4) {
      this.news.push({
        text: `${nick}: ${this.preview}`
      })
    }

    this.results.push({
      routingHead: {
        fromUin: this.uin ?? +selfInfo.uin, // 或 1094950020
        c2c: this.isGroup ? undefined : {
          friendName: nick
        },
        group: this.isGroup ? {
          groupCode: 284840486,
          groupCard: nick
        } : undefined
      },
      contentHead: {
        msgType: this.isGroup ? 82 : 9,
        random: Math.floor(Math.random() * 4294967290),
        msgSeq: this.seq,
        msgTime: Math.trunc(Date.now() / 1000),
        pkgNum: 1,
        pkgIndex: 0,
        divSeq: 0,
        forward: {
          field1: 0,
          field2: 0,
          field3: 0,
          field4: '',
          avatar: ''
        }
      },
      body: {
        richText: {
          elems: this.children
        }
      }
    })

    this.seq++
    this.tsum++
    this.children = []
    this.preview = ''
  }

  async packImage(data: RichMediaUploadCompleteNotify, busiType: number) {
    const imageSize = await this.ctx.ntFileApi.getImageSize(data.filePath)
    return {
      commonElem: {
        serviceType: 48,
        pbElem: Media.MsgInfo.encode({
          msgInfoBody: [{
            index: {
              info: {
                fileSize: +data.commonFileInfo.fileSize,
                md5HexStr: data.commonFileInfo.md5,
                sha1HexStr: data.commonFileInfo.sha,
                fileName: data.commonFileInfo.fileName,
                fileType: {
                  type: 1,
                  picFormat: imageSize.type === 'gif' ? 2000 : 1000
                },
                width: imageSize.width,
                height: imageSize.height,
                time: 0,
                original: 1
              },
              fileUuid: data.fileId,
              storeID: 1,
              expire: this.isGroup ? 2678400 : 157680000
            },
            pic: {
              urlPath: `/download?appid=${this.isGroup ? 1407 : 1406}&fileid=${data.fileId}`,
              ext: {
                originalParam: '&spec=0',
                bigParam: '&spec=720',
                thumbParam: '&spec=198'
              },
              domain: 'multimedia.nt.qq.com.cn'
            },
            fileExist: true
          }],
          extBizInfo: {
            pic: {
              bizType: 0,
              summary: '',
              fromScene: this.isGroup ? 2 : 1, // 怀旧版 PCQQ 私聊收图需要
              toScene: this.isGroup ? 2 : 1, // 怀旧版 PCQQ 私聊收图需要
              oldFileId: this.isGroup ? 574859779 : undefined // 怀旧版 PCQQ 群聊收图需要
            },
            busiType
          }
        }),
        businessType: this.isGroup ? 20 : 10
      }
    }
  }

  packForwardMessage(resid: string, options?: { source?: string; news?: { text: string }[]; summary?: string; prompt?: string }) {
    const uuid = crypto.randomUUID()
    const prompt = options?.prompt ?? '[聊天记录]'
    const content = JSON.stringify({
      app: 'com.tencent.multimsg',
      config: {
        autosize: 1,
        forward: 1,
        round: 1,
        type: 'normal',
        width: 300
      },
      desc: prompt,
      extra: JSON.stringify({
        filename: uuid,
        tsum: 0,
      }),
      meta: {
        detail: {
          news: options?.news ?? [{
            text: '查看转发消息'
          }],
          resid,
          source: options?.source ?? '聊天记录',
          summary: options?.summary ?? '查看转发消息',
          uniseq: uuid,
        }
      },
      prompt,
      ver: '0.0.0.5',
      view: 'contact'
    })
    return {
      lightApp: {
        data: Buffer.concat([Buffer.from([1]), deflateSync(Buffer.from(content, 'utf-8'))])
      }
    }
  }

  async visit(segment: OB11MessageData) {
    const { type, data } = segment
    if (type === OB11MessageDataType.Node) {
      const nodeData = data as OB11MessageNode['data']
      const content = nodeData.content ? message2List(nodeData.content) : []

      // 检查 content 中是否包含嵌套的 node 节点
      const hasNestedNodes = content.some(e => e.type === OB11MessageDataType.Node)

      if (hasNestedNodes) {
        // 递归处理嵌套的合并转发
        if (this.depth >= MAX_FORWARD_DEPTH) {
          this.ctx.logger.warn(`合并转发嵌套深度超过 ${MAX_FORWARD_DEPTH} 层，将停止解析`)
          return
        }

        const innerNodes = content.filter(e => e.type === OB11MessageDataType.Node) as OB11MessageNode[]

        // 从 nodeData 中读取自定义外显参数
        const nestedOptions = {
          source: (nodeData as any).source,
          news: (nodeData as any).news,
          summary: (nodeData as any).summary,
          prompt: (nodeData as any).prompt,
        }

        // 自动生成默认的 news
        if (!nestedOptions.news || nestedOptions.news.length === 0) {
          nestedOptions.news = innerNodes.slice(0, 4).map(node => {
            const nickname = node.data.name || node.data.nickname || 'QQ用户'

            // 尝试获取内容类型
            let contentType = '消息'
            const nodeContent = node.data.content ? message2List(node.data.content) : []
            if (nodeContent.length > 0) {
              const firstItem = nodeContent[0]

              // 使用 switch 语句覆盖所有消息类型
              switch (firstItem.type) {
                case OB11MessageDataType.Text:
                  contentType = firstItem.data.text || '文本消息'
                  break
                case OB11MessageDataType.Image:
                  contentType = firstItem.data.summary || '[图片]'
                  break
                case OB11MessageDataType.Face:
                  contentType = '[表情]'
                  break
                case OB11MessageDataType.Mface:
                  contentType = '[商城表情]'
                  break
                case OB11MessageDataType.Video:
                  contentType = '[视频]'
                  break
                case OB11MessageDataType.Record:
                  contentType = '[语音]'
                  break
                case OB11MessageDataType.File:
                  contentType = firstItem.data.name ? `[文件]${firstItem.data.name}` : '[文件]'
                  break
                case OB11MessageDataType.FlashFile:
                  contentType = firstItem.data.title ? `[闪传]${firstItem.data.title}` : '[闪传]'
                  break
                case OB11MessageDataType.At:
                  contentType = firstItem.data.qq === 'all' ? '[@全体成员]' : `[@${firstItem.data.name || firstItem.data.qq}]`
                  break
                case OB11MessageDataType.Reply:
                  contentType = '[回复]'
                  break
                case OB11MessageDataType.Forward:
                  contentType = '[转发消息]'
                  break
                case OB11MessageDataType.Node:
                  contentType = '[聊天记录]'
                  break
                case OB11MessageDataType.Markdown:
                  contentType = `[Markdown消息 ${firstItem.data.content || ''}]`
                  break
                case OB11MessageDataType.Json:
                  contentType = '[JSON消息]'
                  break
                case OB11MessageDataType.Music:
                  contentType = '[音乐]'
                  break
                case OB11MessageDataType.Poke:
                  contentType = '[戳一戳]'
                  break
                case OB11MessageDataType.Dice:
                  contentType = `[骰子${firstItem.data.result ? ':' + firstItem.data.result : ''}]`
                  break
                case OB11MessageDataType.Rps:
                  contentType = `[猜拳${firstItem.data.result ? ':' + firstItem.data.result : ''}]`
                  break
                case OB11MessageDataType.Contact:
                  contentType = firstItem.data.type === 'qq' ? '[推荐好友]' : '[推荐群]'
                  break
                case OB11MessageDataType.Shake:
                  contentType = '[窗口抖动]'
                  break
                case OB11MessageDataType.Keyboard:
                  contentType = '[按钮]'
                  break
                default:
                  contentType = '[消息]'
              }
            }

            return { text: `${nickname}: ${contentType}` }
          })
        }

        // 自动生成默认的 summary
        if (!nestedOptions.summary) {
          nestedOptions.summary = `查看${innerNodes.length}条转发消息`
        }

        // 自动生成默认的 prompt
        if (!nestedOptions.prompt) {
          nestedOptions.prompt = '[聊天记录]'
        }

        // 递归生成内层合并转发
        const innerEncoder = new MessageEncoder(this.ctx, this.peer, this.depth + 1)
        const innerRaw = await innerEncoder.generate(innerNodes, nestedOptions)

        // 上传内层合并转发，获取 resid
        const resid = await this.ctx.app.pmhq.uploadForward(this.peer, innerRaw.multiMsgItems)

        // 合并内层的待删除文件
        this.deleteAfterSentFiles.push(...innerEncoder.deleteAfterSentFiles)

        // 将内层合并转发作为当前节点的内容
        this.children.push(this.packForwardMessage(resid, nestedOptions))
        this.preview += '[聊天记录]'
      } else {
        // 普通节点，直接渲染内容
        await this.render(content)
      }

      const id = nodeData.uin ?? nodeData.user_id
      this.uin = id ? +id : undefined
      this.name = nodeData.name ?? nodeData.nickname
      await this.flush()
    } else if (type === OB11MessageDataType.Text) {
      this.children.push({
        text: {
          str: data.text
        }
      })
      this.preview += data.text
    } else if (type === OB11MessageDataType.Face) {
      this.children.push({
        face: {
          index: +data.id
        }
      })
      const face = faceConfig.sysface.find(e => e.QSid === String(data.id))
      if (face) {
        this.preview += face.QDes
      }
    } else if (type === OB11MessageDataType.Image) {
      const busiType = Number(segment.data.subType) ?? 0
      const { path: picPath } = await handleOb11RichMedia(this.ctx, segment, this.deleteAfterSentFiles)
      const fileSize = (await stat(picPath)).size
      if (fileSize === 0) {
        throw new Error(`文件异常，大小为 0: ${picPath}`)
      }
      const { path } = await this.ctx.ntFileApi.uploadFile(picPath, ElementType.Pic, busiType)
      const data = await this.ctx.ntFileApi.uploadRMFileWithoutMsg(path, this.isGroup ? 4 : 3, this.isGroup ? this.peer.peerUid : selfInfo.uid)
      this.children.push(await this.packImage(data, busiType))
      this.preview += busiType === 1 ? '[动画表情]' : '[图片]'
      this.deleteAfterSentFiles.push(path)
    } else if (type === OB11MessageDataType.Markdown) {
      const MarkdownElem = ProtoMessage.of({
        content: ProtoField(1, 'string')
      })
      this.children.push({
        commonElem: {
          serviceType: 45,
          pbElem: MarkdownElem.encode({ content: data.content }),
          businessType: 1
        }
      })
      const snippet = data.content.replace(/[\r\n]/g, ' ')
      this.preview += `[Markdown消息 ${snippet}]`
    } else if (type === OB11MessageDataType.Forward) {
      // 处理 forward 类型：支持 id（已有 resid）或 content（嵌套节点）
      const forwardData = data as { id?: string; content?: OB11MessageData[]; source?: string; news?: { text: string }[]; summary?: string; prompt?: string }

      if (forwardData.id) {
        this.children.push(this.packForwardMessage(forwardData.id, forwardData))
      } else if (forwardData.content) {
        if (this.depth >= MAX_FORWARD_DEPTH) {
          this.ctx.logger.warn(`合并转发嵌套深度超过 ${MAX_FORWARD_DEPTH} 层，将停止解析`)
          return
        }

        const nestedContent = message2List(forwardData.content)
        const innerEncoder = new MessageEncoder(this.ctx, this.peer, this.depth + 1)
        const innerNodes = nestedContent.filter(e => e.type === OB11MessageDataType.Node) as OB11MessageNode[]

        if (innerNodes.length === 0) {
          this.ctx.logger.warn('forward content 中没有有效的 node 节点')
          return
        }

        const innerRaw = await innerEncoder.generate(innerNodes, {
          source: forwardData.source,
          news: forwardData.news,
          summary: forwardData.summary,
          prompt: forwardData.prompt,
        })

        const resid = await this.ctx.app.pmhq.uploadForward(this.peer, innerRaw.multiMsgItems)
        this.deleteAfterSentFiles.push(...innerEncoder.deleteAfterSentFiles)
        this.children.push(this.packForwardMessage(resid, forwardData))
      }
      this.preview += '[聊天记录]'
    }
  }

  async render(segments: OB11MessageData[]) {
    for (const segment of segments) {
      await this.visit(segment)
    }
  }

  async generate(content: OB11MessageData[], options?: {
    source?: string
    news?: { text: string }[]
    summary?: string
    prompt?: string
  }) {
    await this.render(content)
    return {
      multiMsgItems: [{
        fileName: 'MultiMsg',
        buffer: {
          msg: this.results
        }
      }],
      tsum: this.tsum,
      source: options?.source ?? (this.isGroup ? '群聊的聊天记录' : '聊天记录'),
      summary: options?.summary ?? `查看${this.tsum}条转发消息`,
      news: (options?.news && options.news.length > 0) ? options.news : this.news,
      prompt: options?.prompt ?? '[聊天记录]'
    }
  }
}

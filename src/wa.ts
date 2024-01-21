import type { Boom } from '@hapi/boom';
import { PrismaClient } from '@prisma/client';
import makeWASocket, {
  BaileysEventMap,
  Browsers,
  ConnectionState,
  DisconnectReason,
  isJidBroadcast,
  makeCacheableSignalKeyStore,
  proto,
  SocketConfig,
} from '@whiskeysockets/baileys';
import type { Response } from 'express';
import { promises as fsPromises } from 'fs';
import pino from 'pino';
import ProxyAgent from 'proxy-agent';
import { toDataURL } from 'qrcode';
import type { WebSocket } from 'ws';
import { useSession } from './session';
import { useLogger, usePrisma } from './shared';
import { initStore, Store } from './store';
import { delay, downloadMessage, pick, sendWebhook } from './utils';

const sessions = new Map<string, Session>();
const retries = new Map<string, number>();
const QRGenerations = new Map<string, number>();
const prisma = new PrismaClient();
// initialize logger
// make sure logs/wa.log exists
const logFilePath = `${__dirname}/logs/wa.log`;
fsPromises.mkdir(`${__dirname}/logs`, { recursive: true });
fsPromises.writeFile(logFilePath, '');

const RECONNECT_INTERVAL = Number(process.env.RECONNECT_INTERVAL || 0);
const MAX_RECONNECT_RETRIES = Number(process.env.MAX_RECONNECT_RETRIES || 5);
const MAX_QR_GENERATION = Number(process.env.MAX_QR_GENERATION || 5);
export const SESSION_CONFIG_ID = 'session-config';

export async function init() {
  const loggerTransport = pino.transport({
    targets: [
      {
        target: 'pino/file',
        options: { destination: logFilePath },
      },
      {
        target: 'pino-pretty',
      },
    ],
  });

  initStore({
    prisma, // Prisma client instance
    logger: pino(
      {
        level: process.env.LOG_LEVEL || 'debug',
      },
      loggerTransport
    ) as any, // Pino logger (Optional)
  });

  const sessions = await usePrisma().session.findMany({
    select: { sessionId: true, data: true },
    where: { id: { startsWith: SESSION_CONFIG_ID } },
  });

  for (const { sessionId, data } of sessions) {
    const { readIncomingMessages, proxy, webhook, ...socketConfig } = JSON.parse(data);

    Session.create({ sessionId, readIncomingMessages, proxy, webhook, socketConfig });
  }
}

function shouldReconnect(sessionId: string) {
  let attempts = retries.get(sessionId) ?? 0;

  if (attempts < MAX_RECONNECT_RETRIES) {
    attempts += 1;
    retries.set(sessionId, attempts);
    return true;
  }
  return false;
}

type SessionOptions = {
  sessionId: string;
  res?: Response;
  SSE?: boolean;
  readIncomingMessages?: boolean;
  proxy?: string;
  webhook?: {
    enabled: boolean;
    url: string | string[] | null;
    events: 'all' | (keyof BaileysEventMap)[];
  };
  socketConfig?: SocketConfig;
};

export class Session {
  private connectionState: Partial<ConnectionState> = { connection: 'close' };
  private lastGeneratedQR: string | null = null;
  public readonly socket: ReturnType<typeof makeWASocket>;
  public readonly store: Store;

  constructor(
    private readonly sessionState: Awaited<ReturnType<typeof useSession>>,
    private readonly options: SessionOptions
  ) {
    const { sessionId, socketConfig, proxy } = options;
    this.socket = makeWASocket({
      printQRInTerminal: true,
      browser: Browsers.ubuntu('Chrome'),
      generateHighQualityLinkPreview: true,
      ...socketConfig,
      logger: useLogger(),
      agent: proxy ? new ProxyAgent() : undefined,
      auth: {
        creds: sessionState.state.creds,
        keys: makeCacheableSignalKeyStore(sessionState.state.keys, useLogger()),
      },
      shouldIgnoreJid: (jid) => isJidBroadcast(jid),
      getMessage: async (key) => {
        const data = await usePrisma().message.findFirst({
          where: { remoteJid: key.remoteJid!, id: key.id!, sessionId },
        });
        return (data?.message || undefined) as proto.IMessage | undefined;
      },
    });

    this.bindEvents();
    this.store = new Store(sessionId, this.socket.ev);
    sessions.set(sessionId, this);
  }

  public static async create(options: SessionOptions) {
    const { sessionId, readIncomingMessages = false, proxy, webhook, socketConfig } = options;
    const configID = `${SESSION_CONFIG_ID}-${sessionId}`;
    const data = JSON.stringify({
      readIncomingMessages,
      proxy,
      webhook,
      ...socketConfig,
    });

    const [sessionState] = await Promise.all([
      useSession(sessionId),
      usePrisma().session.upsert({
        create: {
          id: configID,
          sessionId,
          data,
        },
        update: { data },
        where: { sessionId_id: { id: configID, sessionId } },
      }),
    ]);
    return new Session(sessionState, options);
  }

  public static list() {
    return Array.from(sessions.entries()).map(([id, session]) => ({
      id,
      status: session.status(),
    }));
  }

  public static get(sessionId: string) {
    return sessions.get(sessionId) ?? null;
  }

  public static async delete(sessionId: string) {
    await Session.get(sessionId)?.destroy();
  }

  public static exists(sessionId: string) {
    return sessions.has(sessionId);
  }

  public QR() {
    return this.lastGeneratedQR;
  }

  public status() {
    const state = ['CONNECTING', 'CONNECTED', 'DISCONNECTING', 'DISCONNECTED'];
    let status = state[(this.socket.ws as WebSocket).readyState];
    status = this.socket.user ? 'AUTHENTICATED' : status;
    return status;
  }

  public async jidExists(jid: string, type: 'group' | 'number' = 'number') {
    try {
      if (type === 'number') {
        const [result] = await this.socket.onWhatsApp(jid);
        return !!result?.exists;
      }

      const groupMetadata = await this.socket.groupMetadata(jid);
      return !!groupMetadata.id;
    } catch (e) {
      return Promise.reject(e);
    }
  }

  public async destroy(logout = true) {
    const { sessionId } = this.options;
    const ws = this.socket.ws;
    try {
      await Promise.all([
        logout &&
          ws.readyState !== ws.CLOSING &&
          ws.readyState !== ws.CLOSED &&
          this.socket.logout(),
        usePrisma().chat.deleteMany({ where: { sessionId } }),
        usePrisma().contact.deleteMany({ where: { sessionId } }),
        usePrisma().message.deleteMany({ where: { sessionId } }),
        usePrisma().session.deleteMany({ where: { sessionId } }),
      ]);
    } catch (e) {
      useLogger().error(e, 'An error occured during session destroy');
    } finally {
      sessions.delete(sessionId);
      retries.delete(sessionId);
      QRGenerations.delete(sessionId);
    }
  }

  private bindEvents() {
    const { sessionId, readIncomingMessages, webhook } = this.options;
    this.socket.ev.on('creds.update', this.sessionState.saveCreds);
    this.socket.ev.on('connection.update', (update) => {
      this.connectionState = update;
      const { connection } = update;

      if (connection === 'open') {
        this.lastGeneratedQR = null;
        retries.delete(sessionId);
        QRGenerations.delete(sessionId);
      } else if (connection === 'close') this.handleConnectionClose();
      this.handleConnectionUpdate();
    });

    if (readIncomingMessages) {
      this.socket.ev.on('messages.upsert', async (messageEvent) => {
        const message = messageEvent.messages[0];

        if (message.key.fromMe || messageEvent.type !== 'notify') return;

        await delay(1000);
        await this.socket.readMessages([message.key]);
      });
    }

    if (webhook.enabled) {
      const { url: webhookUrls, events } = webhook;

      const url = webhookUrls ?? process.env.WEBHOOK_URL ?? null;

      if (!url?.length) {
        useLogger().warn('No webhook url provided');
        return;
      }

      this.socket.ev.process(async (socketEvents) => {
        let eventData = events === 'all' ? socketEvents : pick(socketEvents, events);

        if (Object.keys(eventData).length <= 0) return;

        const data = {
          ...eventData,
          session: sessionId,
        };

        const messageEvent = data['messages.upsert'];

        // check if the data is a message upsert event
        messageEvent?.messages?.map(async (messageObj: proto.IWebMessageInfo, index) => {
          if (!messageObj.message) return;

          const messageType = Object.keys(messageObj.message)[0] ?? null;

          if (
            typeof messageType === null ||
            ['protocolMessage', 'senderKeyDistributionMessage'].includes(messageType)
          )
            return;

          if (messageType === 'conversation') {
            data['messages.upsert'][index]['text'] = messageEvent;
          }

          switch (messageType) {
            case 'imageMessage':
              data['messages.upsert'][index]['messageContents'] = await downloadMessage(
                messageObj.message.imageMessage,
                'image'
              );
              break;
            case 'videoMessage':
              data['messages.upsert'][index]['messageContents'] = await downloadMessage(
                messageObj.message.videoMessage,
                'video'
              );
              break;
            case 'audioMessage':
              data['messages.upsert'][index]['messageContents'] = await downloadMessage(
                messageObj.message.audioMessage,
                'audio'
              );
              break;
            default:
              data['messages.upsert'][index]['messageContents'] = messageEvent;
              break;
          }
        });

        try {
          await Promise.any(
            (typeof url === 'string' ? [url] : url).map((url) => sendWebhook(url, data))
          );
        } catch (e) {
          useLogger().error(e, 'An error occured during webhook request');
        }
      });
    }
  }

  private async handleConnectionUpdate() {
    const { sessionId, res, SSE } = this.options;
    const { qr } = this.connectionState;
    let generatedQR: string | null = null;
    const currentQRGenerations = QRGenerations.get(sessionId) ?? -1;

    if (qr) {
      try {
        generatedQR = await toDataURL(qr);
        this.lastGeneratedQR = generatedQR;
        QRGenerations.set(sessionId, currentQRGenerations + 1);
      } catch (e) {
        useLogger().error(e, 'An error occured during QR generation');
      }
    }

    const limitReached = currentQRGenerations >= MAX_QR_GENERATION;
    if (limitReached) this.destroy();

    if (!res || res.writableEnded) return;
    if (SSE) {
      res.write(
        `data: ${JSON.stringify(
          limitReached
            ? { error: 'QR max generation attempts reached' }
            : { ...this.connectionState, qr: generatedQR }
        )}\n\n`
      );
      if (limitReached) res.end();
    } else {
      if (limitReached) res.status(500).json({ error: 'QR max generation attempts reached' }).end();
      else if (!limitReached && qr && generatedQR) res.status(200).json({ qr: generatedQR });
      else if (!limitReached && qr && !generatedQR)
        res.status(500).json({ error: 'Unable to generate QR' });
    }
  }

  private handleConnectionClose() {
    const { sessionId, res, SSE } = this.options;
    const code = (this.connectionState.lastDisconnect?.error as Boom)?.output?.statusCode;
    const restartRequired = code === DisconnectReason.restartRequired;
    const doNotReconnect = !shouldReconnect(sessionId);

    if (code === DisconnectReason.loggedOut || doNotReconnect) {
      if (res && !res.writableEnded) {
        !SSE && res.status(500).json({ error: 'Unable to create session' });
        res.end();
      }
      return this.destroy(doNotReconnect);
    }

    if (!restartRequired) {
      useLogger().info({ attempts: retries.get(sessionId) ?? 1, sessionId }, 'Reconnecting...');
    }
    setTimeout(() => Session.create(this.options), restartRequired ? 0 : RECONNECT_INTERVAL);
  }
}

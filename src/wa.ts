import type { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  ConnectionState,
  DisconnectReason,
  isJidBroadcast,
  makeCacheableSignalKeyStore,
  proto,
  SocketConfig,
  WASocket,
} from '@whiskeysockets/baileys';
import type { Response } from 'express';
import { promises as fsPromises } from 'fs';
import { useSession } from './session';
import { initStore, Store } from './store';
// import { writeFile } from 'fs/promises';
// import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { toDataURL } from 'qrcode';
import type { WebSocket } from 'ws';
import { useLogger, usePrisma } from './shared';
import { debugEvents, delay } from './utils';

type Session = WASocket & {
  destroy: () => Promise<void>;
  store: Store;
};

const sessions = new Map<string, Session>();
const retries = new Map<string, number>();
const SSEQRGenerations = new Map<string, number>();
const prisma = new PrismaClient();

// initialize logger
// make sure logs/wa.log exists
const logFilePath = `${__dirname}/logs/wa.log`;
fsPromises.mkdir(`${__dirname}/logs`, { recursive: true });
fsPromises.writeFile(logFilePath, '');

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

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'debug',
  },
  loggerTransport
);

const RECONNECT_INTERVAL = Number(process.env.RECONNECT_INTERVAL || 0);
const MAX_RECONNECT_RETRIES = Number(process.env.MAX_RECONNECT_RETRIES || 5);
const SSE_MAX_QR_GENERATION = Number(process.env.SSE_MAX_QR_GENERATION || 5);
const SESSION_CONFIG_ID = 'session-config';

export async function init() {
  initStore({
    prisma, // Prisma client instance
    logger: logger as any, // Pino logger (Optional)
  });

  const sessions = await usePrisma().session.findMany({
    select: { sessionId: true, data: true },
    where: { id: { startsWith: SESSION_CONFIG_ID } },
  });

  for (const { sessionId, data } of sessions) {
    const { readIncomingMessages, ...socketConfig } = JSON.parse(data);
    createSession({ sessionId, readIncomingMessages, socketConfig });
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

type createSessionOptions = {
  sessionId: string;
  res?: Response;
  SSE?: boolean;
  readIncomingMessages?: boolean;
  socketConfig?: SocketConfig;
};

export async function createSession(options: createSessionOptions) {
  const { sessionId, res, SSE = false, readIncomingMessages = false, socketConfig } = options;
  const configID = `${SESSION_CONFIG_ID}-${sessionId}`;
  let connectionState: Partial<ConnectionState> = { connection: 'close' };

  const destroy = async (logout = true) => {
    try {
      await Promise.all([
        logout && socket.logout(),
        usePrisma().chat.deleteMany({ where: { sessionId } }),
        usePrisma().contact.deleteMany({ where: { sessionId } }),
        usePrisma().message.deleteMany({ where: { sessionId } }),
        usePrisma().group.deleteMany({ where: { sessionId } }),
        usePrisma().session.deleteMany({ where: { sessionId } }),
      ]);
    } catch (e) {
      useLogger().error(e, 'An error occured during session destroy');
    } finally {
      sessions.delete(sessionId);
    }
  };

  const handleConnectionClose = () => {
    const code = (connectionState.lastDisconnect?.error as Boom)?.output?.statusCode;
    const restartRequired = code === DisconnectReason.restartRequired;
    const doNotReconnect = !shouldReconnect(sessionId);

    if (code === DisconnectReason.loggedOut || doNotReconnect) {
      if (res) {
        !SSE && !res.headersSent && res.status(500).json({ error: 'Unable to create session' });
        res.end();
      }
      destroy(doNotReconnect);
      return;
    }

    if (!restartRequired) {
      useLogger().info({ attempts: retries.get(sessionId) ?? 1, sessionId }, 'Reconnecting...');
    }
    setTimeout(() => createSession(options), restartRequired ? 0 : RECONNECT_INTERVAL);
  };

  const handleNormalConnectionUpdate = async () => {
    if (connectionState.qr?.length) {
      if (res && !res.headersSent) {
        try {
          const qr = await toDataURL(connectionState.qr);
          res.status(200).json({ qr });
          return;
        } catch (e) {
          useLogger().error(e, 'An error occured during QR generation');
          res.status(500).json({ error: 'Unable to generate QR' });
        }
      }
      destroy();
    }
  };

  const handleSSEConnectionUpdate = async () => {
    let qr: string | undefined = undefined;
    if (connectionState.qr?.length) {
      try {
        qr = await toDataURL(connectionState.qr);
      } catch (e) {
        useLogger().error(e, 'An error occured during QR generation');
      }
    }

    const currentGenerations = SSEQRGenerations.get(sessionId) ?? 0;
    if (!res || res.writableEnded || (qr && currentGenerations >= SSE_MAX_QR_GENERATION)) {
      res && !res.writableEnded && res.end();
      destroy();
      return;
    }

    const data = { ...connectionState, qr };
    if (qr) SSEQRGenerations.set(sessionId, currentGenerations + 1);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const handleConnectionUpdate = SSE ? handleSSEConnectionUpdate : handleNormalConnectionUpdate;

  const { state, saveCreds } = await useSession(sessionId);

  const socket = makeWASocket({
    printQRInTerminal: true,
    browser: Browsers.windows('Chrome'),
    generateHighQualityLinkPreview: true,
    ...socketConfig,
    auth: {
      creds: (state as { creds: any }).creds as any,
      keys: makeCacheableSignalKeyStore((state as { keys: any }).keys as any, useLogger() as any),
    },
    logger: useLogger() as any,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
    getMessage: async (key) => {
      const data = await usePrisma().message.findFirst({
        where: { remoteJid: key.remoteJid!, id: key.id!, sessionId },
      });
      return (data?.message || undefined) as proto.IMessage | undefined;
    },
  });

  const store = new Store(sessionId, socket.ev);
  sessions.set(sessionId, { ...socket, destroy, store });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', (update) => {
    connectionState = update;
    const { connection } = update;

    if (connection === 'open') {
      retries.delete(sessionId);
      SSEQRGenerations.delete(sessionId);
    }
    if (connection === 'close') handleConnectionClose();
    handleConnectionUpdate();
  });

  if (readIncomingMessages) {
    socket.ev.on('messages.upsert', async (m) => {
      const message = m.messages[0];
      if (message.key.fromMe || m.type !== 'notify') return;

      await delay(1000);
      await socket.readMessages([message.key]);
    });
  }

  // Debug events
  debugEvents(socket.ev, [
    'messaging-history.set',
    'chats.upsert',
    'contacts.update',
    'contacts.upsert',
  ]);

  await usePrisma().session.upsert({
    create: {
      id: configID,
      sessionId,
      data: JSON.stringify({ readIncomingMessages, ...socketConfig }),
    },
    update: {},
    where: { sessionId_id: { id: configID, sessionId } },
  });
}

export function getSessionStatus(session: Session) {
  const state = ['CONNECTING', 'CONNECTED', 'DISCONNECTING', 'DISCONNECTED'];
  let status = state[(session.ws as WebSocket).readyState];
  status = session.user ? 'AUTHENTICATED' : status;
  return status;
}

export function listSessions() {
  return Array.from(sessions.entries()).map(([id, session]) => ({
    id,
    status: getSessionStatus(session),
  }));
}

export function getSession(sessionId: string) {
  return sessions.get(sessionId);
}

export async function deleteSession(sessionId: string) {
  sessions.get(sessionId)?.destroy();
}

export function sessionExists(sessionId: string) {
  return sessions.has(sessionId);
}

export async function jidExists(
  session: Session,
  jid: string,
  type: 'group' | 'number' = 'number'
) {
  try {
    if (type === 'number') {
      const [result] = await session.onWhatsApp(jid);
      return !!result?.exists;
    }

    const groupMeta = await session.groupMetadata(jid);
    return !!groupMeta.id;
  } catch (e) {
    return Promise.reject(e);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// export async function dump(fileName: string, data: any) {
//   const path = join(__dirname, '..', 'debug', `${fileName}.json`);
//   await writeFile(path, JSON.stringify(data, null, 2));
// }

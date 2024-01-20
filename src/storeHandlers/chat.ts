import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import type { BaileysEventEmitter } from '@whiskeysockets/baileys';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../Types';
import { transformPrisma } from '../utils';

export default function chatHandler(sessionId: string, event: BaileysEventEmitter) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ chats, isLatest }) => {
    try {
      await prisma.$transaction(async (tx) => {
        if (isLatest) await tx.chat.deleteMany({ where: { sessionId } });

        const existingIds = (
          await tx.chat.findMany({
            select: { id: true },
            where: { id: { in: chats.map((c) => c.id) }, sessionId },
          })
        ).map((i) => i.id);

        const chatsAdded = (
          await tx.chat.createMany({
            // @ts-ignore
            data: chats
              .filter((c) => !existingIds.includes(c.id))
              .map((c) => ({ ...transformPrisma(c), sessionId })),
          })
        ).count;

        logger.info({ chatsAdded }, 'Synced chats');
      });
    } catch (e) {
      logger.error(e, 'An error occured during chats set');
    }
  };

  const upsert: BaileysEventHandler<'chats.upsert'> = async (chats) => {
    try {
      await Promise.any(
        chats
          .map((c) => transformPrisma(c))
          .map((data) =>
            prisma.chat.upsert({
              select: { pkId: true },
              // @ts-ignore
              create: { ...data, sessionId },
              update: data,
              where: { sessionId_id: { id: data.id, sessionId } },
            })
          )
      );
    } catch (e) {
      logger.error(e, 'An error occured during chats upsert');
    }
  };

  const update: BaileysEventHandler<'chats.update'> = async (updates) => {
    for (const updateData of updates) {
      try {
        const data = transformPrisma(updateData);
        const chatExists = await prisma.chat.findUnique({
          where: { sessionId_id: { id: data.id!, sessionId } },
        });

        if (chatExists) {
          await prisma.chat.update({
            select: { pkId: true },
            data: {
              ...data,
              unreadCount:
                typeof data.unreadCount === 'number'
                  ? data.unreadCount > 0
                    ? { increment: data.unreadCount }
                    : { set: data.unreadCount }
                  : undefined,
            },
            where: { sessionId_id: { id: data.id!, sessionId } },
          });
        }
      } catch (e) {
        if (e instanceof PrismaClientKnownRequestError && e.code === 'P2025') {
          return logger.info({ updateData }, 'Got update for non-existent chat');
        }
        logger.error(e, 'An error occurred during chat update');
      }
    }
  };

  const del: BaileysEventHandler<'chats.delete'> = async (ids) => {
    try {
      await prisma.chat.deleteMany({
        where: { id: { in: ids } },
      });
    } catch (e) {
      logger.error(e, 'An error occured during chats delete');
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('chats.upsert', upsert);
    event.on('chats.update', update);
    event.on('chats.delete', del);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('chats.upsert', upsert);
    event.off('chats.update', update);
    event.off('chats.delete', del);
    listening = false;
  };

  return { listen, unlisten };
}

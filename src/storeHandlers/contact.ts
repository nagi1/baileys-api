import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import type { BaileysEventEmitter } from '@whiskeysockets/baileys';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../Types';
import { transformPrisma } from '../utils';

export default function contactHandler(sessionId: string, event: BaileysEventEmitter) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ contacts, isLatest }) => {
    try {
      if (contacts.length === 0) {
        logger.info('No contacts to sync');

        return;
      }

      const upsertPromises = contacts
        .map((c) => transformPrisma(c))
        .map((data) => {
          // check if the name or notify columns are empty to prevent updating the contact
          // and losing the name or notify
          let update = data;

          if (!data.name) {
            delete update.name;
          }

          if (!data.notify) {
            delete update.notify;
          }

          return prisma.contact.upsert({
            select: { pkId: true },
            create: { ...data, sessionId },
            update,
            where: { sessionId_id: { id: data.id, sessionId } },
          });
        });

      await Promise.any(upsertPromises);
      logger.info({ contacts: contacts.length }, 'Synced contacts');
    } catch (e) {
      logger.error(e, 'An error occured during contacts set');
    }
  };

  const upsert: BaileysEventHandler<'contacts.upsert'> = async (contacts) => {
    try {
      await Promise.any(
        contacts
          .map((c) => transformPrisma(c))
          .map(async (data) => {
            // check if the name or notify columns are empty to prevent updating the contact
            // and losing the name or notify
            let update = data;

            if (!data.name) {
              delete update.name;
            }

            if (!data.notify) {
              delete update.notify;
            }

            return prisma.contact.upsert({
              select: { pkId: true },
              create: { ...data, sessionId },
              update,
              where: { sessionId_id: { id: data.id, sessionId } },
            });
          })
      );
    } catch (e) {
      logger.error(e, 'An error occured during contacts upsert');
    }
  };

  const update: BaileysEventHandler<'contacts.update'> = async (updates) => {
    for (const updateData of updates) {
      try {
        const data = transformPrisma(updateData);
        const contactExists = await prisma.contact.findUnique({
          where: { sessionId_id: { id: data.id!, sessionId } },
        });

        if (contactExists) {
          if (!data.name) {
            delete data.name;
          }

          if (!data.notify) {
            delete data.notify;
          }

          await prisma.contact.update({
            select: { pkId: true },
            data: data,
            where: { sessionId_id: { id: data.id!, sessionId } },
          });
        }
      } catch (e) {
        if (e instanceof PrismaClientKnownRequestError && e.code === 'P2025') {
          return logger.info({ updateData }, 'Got update for non existent contact');
        }
        logger.error(e, 'An error occured during contact update');
      }
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('contacts.upsert', upsert);
    event.on('contacts.update', update);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('contacts.upsert', upsert);
    event.off('contacts.update', update);
    listening = false;
  };

  return { listen, unlisten };
}

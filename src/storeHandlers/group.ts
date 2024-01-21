import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import type { BaileysEventEmitter } from '@whiskeysockets/baileys';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler } from '../Types';
import { transformPrisma } from '../utils';

export default function groupHandler(sessionId: string, event: BaileysEventEmitter) {
    let listening = false;

    const upsert: BaileysEventHandler<'groups.upsert'> = async (groups) => {
        const prisma = usePrisma();
        const logger = useLogger();
        try {
            if (groups.length === 0) {
                logger.info('No groups to sync');

                return;
            }

            await Promise.any(
                groups
                    .map((g) => transformPrisma(g))
                    .map((data) =>
                        prisma.group.upsert({
                            select: { pkId: true },
                            create: { ...data, sessionId },
                            update: data,
                            where: { sessionId_id: { id: data.id, sessionId } },
                        })
                    )
            );

            logger.info({ groups: groups.length }, 'Synced groups');
        } catch (e) {
            logger.error(e, 'An error occurred during groups upsert');
        }
    };

    const update: BaileysEventHandler<'groups.update'> = async (updates) => {
        const prisma = usePrisma();
        const logger = useLogger();
        for (const update of updates) {
            try {
                await prisma.group.update({
                    select: { pkId: true },
                    data: transformPrisma(update),
                    where: { sessionId_id: { id: update.id!, sessionId } },
                });
            } catch (e) {
                if (e instanceof PrismaClientKnownRequestError && e.code === 'P2025') {
                    return logger.info({ update }, 'Got update for non-existent group');
                }
                logger.error(e, 'An error occurred during group update');
            }
        }
    };

    const listen = () => {
        if (listening) return;

        event.on('groups.upsert', upsert);
        event.on('groups.update', update);
        listening = true;
    };

    const unlisten = () => {
        if (!listening) return;

        event.off('groups.upsert', upsert);
        event.off('groups.update', update);
        listening = false;
    };

    return { listen, unlisten };
}

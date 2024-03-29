import type { RequestHandler } from 'express';
import { Session } from '../session';
import { useLogger } from '../shared';

export const makePhotoURLHandler =
    (type: 'number' | 'group' = 'number'): RequestHandler =>
    async (req, res) => {
        try {
            const { sessionId, jid } = req.params;
            const session = Session.get(sessionId)!;

            const exists = await session.jidExists(jid, type);
            if (!exists) return res.status(400).json({ error: 'Jid does not exists' });

            const url = await session.socket.profilePictureUrl(jid, 'image');
            res.status(200).json({ url });
        } catch (e) {
            const message = 'An error occurred during photo fetch';
            useLogger().error(e, message);
            res.status(500).json({ error: message });
        }
    };

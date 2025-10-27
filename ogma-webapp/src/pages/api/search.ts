import type { NextApiRequest, NextApiResponse } from 'next';
import { searchUsers } from '@/server/services/user.service';
import { searchTracks } from '@/server/services/track.service';
import { searchPlaylistsByHandleOrTitlePublic } from '@/server/services/playlist.service';

// Если у тебя нет алиаса "@", замени импорты на относительные:
// import { searchUsers } from '../../server/services/user.service';
// import { searchTracks } from '../../server/services/track.service';
// import { searchPlaylistsByHandleOrTitlePublic } from '../../server/services/playlist.service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end('Method Not Allowed');
  }

  const q = String(req.query.q ?? '').trim();

  const [users, tracks, playlists] = await Promise.all([
    searchUsers(q),
    searchTracks(q),
    searchPlaylistsByHandleOrTitlePublic(q),
  ]);

  return res.status(200).json({ users, tracks, playlists });
}
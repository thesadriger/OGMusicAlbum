// src/server/services/playlist.service.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

/**
 * Поиск плейлистов по handle/title.
 * Итерация 1: показываем только публичные (isPrivate=false).
 * Ищем по точному/частичному совпадению handle и по названию title.
 */
export async function searchPlaylistsByHandleOrTitlePublic(q: string) {
  const norm = (q || '').trim();
  if (!norm) return [];

  const handleQuery = norm.replace(/^@/, '');

  return prisma.playlist.findMany({
    where: {
      handle: { not: null },
      AND: [
        {
          OR: [
            { handle: { equals: handleQuery, mode: 'insensitive' } },
            { handle: { contains: handleQuery, mode: 'insensitive' } },
            { title:  { contains: norm,        mode: 'insensitive' } },
          ],
        },
        { isPrivate: false },
      ],
    },
    select: {
      id: true,
      title: true,
      handle: true,
      isPrivate: true,
      ownerId: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 25,
  });
}
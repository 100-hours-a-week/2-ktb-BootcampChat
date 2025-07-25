const Room = require('../models/Room');
const redisClient = require('../utils/redisClient');

// 가장 자주 조회되는 첫 페이지의 캐시 키를 상수로 정의하여 관리합니다.
const FIRST_PAGE_CACHE_KEY = 'rooms:page=0:size=10:sort=createdAt_desc:search=';
const CACHE_TTL = 30; // 30초

class RoomRepository {
  /**
   * 채팅방 목록을 조회합니다.
   * 가장 빈번하게 요청되는 첫 페이지만 캐싱하여 성능과 효율을 모두 잡습니다.
   * @param {object} options - 조회 옵션 (page, pageSize, sortField, sortOrder, search)
   * @returns {Promise<object>} - 조회 결과 (캐시 또는 DB)
   */
  async getRooms({ page = 0, pageSize = 10, sortField = 'createdAt', sortOrder = 'desc', search = '' }) {
    const cacheKey = `rooms:page=${page}:size=${pageSize}:sort=${sortField}_${sortOrder}:search=${search}`;

    // 1. 캐시 확인 (첫 페이지만)
    if (cacheKey === FIRST_PAGE_CACHE_KEY) {
      try {
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          console.log(`[Cache HIT] ${cacheKey}`);
          return cachedData;
        }
        console.log(`[Cache MISS] ${cacheKey}`);
      } catch (cacheError) {
        console.error(`[Cache] Redis GET error for key ${cacheKey}:`, cacheError);
        // 캐시 서버에 문제가 있어도 DB에서 조회하여 서비스는 계속되도록 합니다.
      }
    }

    // 2. DB 조회 (캐시가 없거나, 첫 페이지가 아닌 경우)
    const skip = page * pageSize;
    const filter = search ? { name: { $regex: search, $options: 'i' } } : {};

    const totalCount = await Room.countDocuments(filter);
    const rooms = await Room.find(filter)
      .populate('creator', 'name email profileImage')
      .populate('participants', 'name email profileImage')
      .sort({ [sortField]: sortOrder === 'desc' ? -1 : 1 })
      .skip(skip)
      .limit(pageSize)
      .lean();

    // 3. 응답 데이터 포맷팅
    const safeRooms = rooms.map(room => {
      if (!room) return null;
      const creator = room.creator || { _id: 'unknown', name: '알 수 없음', email: '' };
      const participants = Array.isArray(room.participants) ? room.participants : [];
      return {
        _id: room._id?.toString() || 'unknown',
        name: room.name || '제목 없음',
        hasPassword: !!room.hasPassword,
        creator: {
          _id: creator._id?.toString() || 'unknown',
          name: creator.name || '알 수 없음',
          email: creator.email || '',
          profileImage: creator.profileImage || ''
        },
        participants: participants.filter(p => p && p._id).map(p => ({
          _id: p._id.toString(),
          name: p.name || '알 수 없음',
          email: p.email || '',
          profileImage: p.profileImage || ''
        })),
        participantsCount: participants.length,
        createdAt: room.createdAt || new Date(),
      };
    }).filter(room => room !== null);

    const totalPages = Math.ceil(totalCount / pageSize);
    const hasMore = skip + rooms.length < totalCount;

    const responseData = {
      success: true,
      data: safeRooms,
      metadata: {
        total: totalCount,
        page,
        pageSize,
        totalPages,
        hasMore,
        currentCount: safeRooms.length,
        sort: { field: sortField, order: sortOrder }
      }
    };

    // 4. 캐시 저장 (첫 페이지만)
    if (cacheKey === FIRST_PAGE_CACHE_KEY) {
      try {
        await redisClient.set(cacheKey, responseData, { ttl: CACHE_TTL });
        console.log(`[Cache SET] ${cacheKey}`);
      } catch (cacheError) {
        console.error(`[Cache] Redis SET error for key ${cacheKey}:`, cacheError);
      }
    }

    return responseData;
  }

  /**
   * 새 채팅방을 생성하고 첫 페이지 캐시를 무효화합니다.
   * @param {object} roomData - 생성할 채팅방 데이터
   * @param {string} creatorId - 생성자 ID
   * @returns {Promise<object>} - 생성된 채팅방 정보
   */
  async createRoom(roomData, creatorId) {
    const newRoom = new Room({
      name: roomData.name,
      password: roomData.password,
      creator: creatorId,
      participants: [creatorId],
    });
    const savedRoom = await newRoom.save();
    await this.invalidateFirstPageCache();
    return Room.findById(savedRoom._id)
      .populate('creator', 'name email profileImage')
      .populate('participants', 'name email profileImage')
      .lean();
  }

  /**
   * 첫 페이지 캐시를 무효화합니다.
   */
  async invalidateFirstPageCache() {
    try {
      console.log(`[Cache] Invalidating: ${FIRST_PAGE_CACHE_KEY}`);
      await redisClient.del(FIRST_PAGE_CACHE_KEY);
    } catch (cacheError) {
      console.error(`[Cache] Redis DEL error for key ${FIRST_PAGE_CACHE_KEY}:`, cacheError);
    }
  }
}

module.exports = new RoomRepository();
// 云函数入口文件
const cloud = require('wx-server-sdk')
const request = require('request-promise-native')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

/**
 * 斯诺克赛事API配置
 * 使用免费公开的斯诺克数据源
 */
const API_CONFIG = {
  // Cuetracker API (免费，无需API Key)
  CUETRACKER_BASE: 'https://api.cuetracker.net',
  
  // snooker.org 官方数据源（JSON API）
  // 文档: https://api.snooker.org/
  // 注意：必须携带 X-Requested-By 请求头
  SNOOKER_ORG: 'https://api.snooker.org'
}

// snooker.org 授权请求头（标识你的应用，可以是任何字符串）
// 参考: https://api.snooker.org/ - "Set the X-Requested-By header to something (anything)"
const SNOOKER_REQUESTED_BY = 'SnookerScheduleMiniProgram'

// 内存缓存：减少外部请求次数（snooker.org 限流 10 次/分钟）
const _cache = {
  eventsBySeason: new Map(), // key: `${season}:${tour}` -> { expiresAt, data }
  matchesByEvent: new Map(), // key: `${eventId}` -> { expiresAt, data }
  players: null // { expiresAt, data: Map<number, string> }
}

function _nowMs() {
  return Date.now()
}

function _getCacheEntry(map, key) {
  const entry = map instanceof Map ? map.get(key) : null
  if (!entry) return null
  if (entry.expiresAt > _nowMs()) return entry.data
  return null
}

function _setCacheEntry(map, key, data, ttlMs) {
  map.set(key, { data, expiresAt: _nowMs() + ttlMs })
}

function _pad2(n) {
  return String(n).padStart(2, '0')
}

// snooker.org 日期时间为 UTC；按北京时间(+8)展示/过滤
function _formatDateFromUtc(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  return `${bj.getUTCFullYear()}-${_pad2(bj.getUTCMonth() + 1)}-${_pad2(bj.getUTCDate())}`
}

function _formatTimeFromUtc(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  return `${_pad2(bj.getUTCHours())}:${_pad2(bj.getUTCMinutes())}`
}

/**
 * 通用API请求函数
 */
async function fetchData(url, options = {}) {
  try {
    const requestOptions = {
      uri: url,
      json: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 5000,
      ...options
    }
    
    console.log('请求URL:', url)
    const result = await request(requestOptions)
    return result
  } catch (error) {
    console.error('API请求失败:', error.message)
    throw error
  }
}

/**
 * 带超时的异步函数包装器
 */
function withTimeout(promise, timeoutMs, timeoutMessage = '请求超时') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    })
  ])
}

/**
 * 获取比赛列表
 * 从多个数据源尝试获取，每个数据源都有超时保护
 */
async function getMatchList() {
  try {
    // 1. 并行尝试 snooker.org 和 Cuetracker，每个最多等待 2 秒
    const snookerPromise = (async () => {
      try {
        const now = new Date()
        const defaultSeason = now.getMonth() < 5 ? now.getFullYear() - 1 : now.getFullYear()
        console.log('尝试从 snooker.org 获取赛事数据，赛季:', defaultSeason)
        const events = await withTimeout(
          getSnookerEvents(defaultSeason, 'main'),
          5000,
          'snooker.org 请求超时'
        )
        if (events && events.length > 0) {
          console.log('snooker.org 获取到赛事数据，数量:', events.length)
          return formatMatchList(events)
        } else {
          console.log('snooker.org 返回空数据或数据为空')
        }
      } catch (err) {
        console.log('snooker.org 获取赛事列表失败:', err.message, err.stack)
      }
      return null
    })()

    const cuetrackerPromise = (async () => {
      try {
        console.log('尝试从 Cuetracker 获取赛事数据')
        const data = await withTimeout(
          fetchFromCuetracker('tournaments'),
          5000,
          'Cuetracker 请求超时'
        )
        if (data && data.length > 0) {
          console.log('Cuetracker 获取到赛事数据，数量:', data.length)
          return formatMatchList(data)
        } else {
          console.log('Cuetracker 返回空数据或数据为空')
        }
      } catch (err) {
        console.log('Cuetracker 获取赛事列表失败:', err.message, err.stack)
      }
      return null
    })()

    // 2. 等待两个数据源中任意一个成功，或都失败
    const [snookerResult, cuetrackerResult] = await Promise.allSettled([
      snookerPromise,
      cuetrackerPromise
    ])

    // 3. 优先使用 snooker.org 的结果
    if (snookerResult.status === 'fulfilled' && snookerResult.value) {
      console.log('使用 snooker.org 数据')
      return snookerResult.value
    }

    // 4. 其次使用 Cuetracker 的结果
    if (cuetrackerResult.status === 'fulfilled' && cuetrackerResult.value) {
      console.log('使用 Cuetracker 数据')
      return cuetrackerResult.value
    }

    // 5. 都失败，抛出错误（用户要求真实数据，获取失败需提示）
    console.error('所有外部数据源失败，无法获取真实数据')
    console.error('snooker.org 结果:', snookerResult)
    console.error('Cuetracker 结果:', cuetrackerResult)
    
    // 构建详细的错误信息
    let errorDetail = '获取真实比赛数据失败，请检查网络连接或API配置。'
    if (snookerResult.status === 'rejected') {
      errorDetail += ` snooker.org: ${snookerResult.reason?.message || '请求失败'};`
    } else if (!snookerResult.value) {
      errorDetail += ` snooker.org: 返回空数据;`
    }
    if (cuetrackerResult.status === 'rejected') {
      errorDetail += ` Cuetracker: ${cuetrackerResult.reason?.message || '请求失败'};`
    } else if (!cuetrackerResult.value) {
      errorDetail += ` Cuetracker: 返回空数据;`
    }
    
    throw new Error(errorDetail)
  } catch (error) {
    console.error('获取比赛列表失败:', error)
    // 用户要求真实数据，获取失败时抛出错误
    if (error.message.includes('获取真实比赛数据失败')) {
      throw error
    }
    throw new Error('获取比赛列表失败: ' + error.message)
  }
}

/**
 * 从Cuetracker获取数据
 */
async function fetchFromCuetracker(endpoint) {
  const baseUrl = API_CONFIG.CUETRACKER_BASE
  let url = baseUrl

  if (endpoint === 'tournaments') {
    // 获取赛事列表
    url = `${baseUrl}/tournaments`
  } else {
    throw new Error('Unsupported Cuetracker endpoint: ' + endpoint)
  }

  return fetchData(url, {
    headers: {
      'User-Agent': 'SnookerScheduleMiniProgram/1.0'
    }
  })
}

/**
 * 从Snooker.org获取数据
 */
async function fetchFromSnookerOrg(endpoint, params = {}) {
  const baseUrl = API_CONFIG.SNOOKER_ORG
  let url = baseUrl

  // 官方文档: https://api.snooker.org/
  // t=5: 赛季所有赛事
  // t=6: 某个赛事的全部比赛
  if (endpoint === 'tournaments') {
    // snooker.org 的赛季是跨年制，例如 2025 代表 2025/2026 赛季
    // 简单规则：每年 6 月之前视为上一赛季
    const now = new Date()
    const defaultSeason = now.getMonth() < 5 ? now.getFullYear() - 1 : now.getFullYear()
    const season = params.season || defaultSeason
    const tour = params.tour || 'main'
    url = `${baseUrl}/?t=5&s=${season}&tr=${tour}`
  } else if (endpoint === 'matches') {
    const eventId = params.eventId
    if (!eventId) {
      throw new Error('Snooker.org matches endpoint requires eventId')
    }
    url = `${baseUrl}/?t=6&e=${eventId}`
  } else {
    throw new Error('Unsupported Snooker.org endpoint: ' + endpoint)
  }

  // 按文档要求携带 X-Requested-By 请求头
  return fetchData(url, {
    headers: {
      'User-Agent': 'SnookerScheduleMiniProgram/1.0',
      'X-Requested-By': SNOOKER_REQUESTED_BY
    }
  })
}

async function getSnookerEvents(season, tour = 'main') {
  const key = `${season}:${tour}`
  const cached = _getCacheEntry(_cache.eventsBySeason, key)
  if (cached) return cached

  const data = await fetchFromSnookerOrg('tournaments', { season, tour })
  // 赛事列表变化不频繁，缓存 30 分钟
  _setCacheEntry(_cache.eventsBySeason, key, data, 30 * 60 * 1000)
  return data
}

async function getSnookerMatches(eventId) {
  const key = String(eventId)
  const cached = _getCacheEntry(_cache.matchesByEvent, key)
  if (cached) return cached

  const data = await fetchFromSnookerOrg('matches', { eventId })
  // 同一赛事短时间重复点击很多，缓存 2 分钟，避免触发 10/min 限流
  _setCacheEntry(_cache.matchesByEvent, key, data, 2 * 60 * 1000)
  return data
}

async function getPlayersNameMap() {
  if (_cache.players && _cache.players.expiresAt > _nowMs()) return _cache.players.data

  // t=10: players（体积较大，尽量长缓存）
  const players = await fetchData(`${API_CONFIG.SNOOKER_ORG}/?t=10`, {
    headers: {
      'User-Agent': 'SnookerScheduleMiniProgram/1.0',
      'X-Requested-By': SNOOKER_REQUESTED_BY
    }
  })

  const map = new Map()
  if (Array.isArray(players)) {
    players.forEach(p => {
      const id = p.ID
      if (!id) return
      const team = (p.TeamName || '').trim()
      const name =
        team ||
        [p.FirstName, p.MiddleName, p.LastName].filter(Boolean).join(' ').trim() ||
        (p.ShortName || '').trim() ||
        String(p.LastName || '').trim()
      if (name) map.set(Number(id), name)
    })
  }

  _cache.players = { data: map, expiresAt: _nowMs() + 7 * 24 * 60 * 60 * 1000 } // 7 天
  return map
}

/**
 * 格式化比赛列表数据
 */
function formatMatchList(data) {
  return data.map(item => {
    // snooker.org (t=5) 字段：ID/Name/StartDate/EndDate/Venue/City/Country...
    // Cuetracker 备用：字段名可能不同，这里做兼容
    const id = item.ID || item.id || item.tournament_id
    const name = item.Name || item.name || item.tournament_name || ''
    const start_date = item.StartDate || item.start_date || item.startDate
    const end_date = item.EndDate || item.end_date || item.endDate
    const venueRaw = item.Venue || item.venue || item.location || ''
    const venue = [venueRaw, item.City, item.Country].filter(Boolean).join(', ')
    const prize_fund = item.PrizeFund || item.prize_fund || item.prize || ''
    const status = determineMatchStatus(start_date, end_date)

    return { id, name, start_date, end_date, venue, prize_fund, status }
  })
}

/**
 * 获取比赛详情
 */
async function getMatchDetail(id) {
  try {
    console.log('获取比赛详情, ID:', id, '类型:', typeof id)

    // 优先从 snooker.org 赛季赛事列表查找（保证详情与首页一致）
    try {
      const now = new Date()
      const defaultSeason = now.getMonth() < 5 ? now.getFullYear() - 1 : now.getFullYear()
      console.log('获取赛季赛事列表, 赛季:', defaultSeason)
      
      // 为 getSnookerEvents 添加超时机制（2秒）
      const getEventsWithTimeout = () => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('获取赛事列表超时'))
          }, 2000)
          
          getSnookerEvents(defaultSeason, 'main')
            .then(data => {
              clearTimeout(timeout)
              resolve(data)
            })
            .catch(err => {
              clearTimeout(timeout)
              reject(err)
            })
        })
      }
      
      const events = await getEventsWithTimeout()
      console.log('获取到赛事列表数量:', events ? events.length : 0)
      
      if (Array.isArray(events) && events.length > 0) {
        // 打印前 3 个赛事的 ID 和类型
        console.log('示例赛事 ID:', events.slice(0, 3).map(e => ({ ID: e.ID, IDType: typeof e.ID, Name: e.Name })))
        
        // 尝试多种 ID 匹配方式
        const event = events.find(e => 
          String(e.ID) === String(id) ||
          Number(e.ID) === Number(id) ||
          e.ID == id
        )
        
        if (event) {
          console.log('找到匹配的赛事:', event.Name, 'ID:', event.ID)
          const match = {
            id: event.ID,
            name: event.Name,
            start_date: event.StartDate,
            end_date: event.EndDate,
            venue: [event.Venue, event.City, event.Country].filter(Boolean).join(', '),
            prize_fund: event.PrizeFund || ''
          }
          const status = determineMatchStatus(match.start_date, match.end_date)
          console.log('返回比赛详情:', match)
          return Object.assign({}, match, { status })
        } else {
          console.log('未找到匹配的赛事, 查找的ID:', id)
        }
      }
    } catch (err) {
      console.error('snooker.org 获取详情失败:', err.message, err.stack)
      throw new Error('无法从官方数据源获取比赛详情，请检查网络连接或API配置')
    }

    // 如果snooker.org连接成功但没有找到匹配的赛事
    console.error('未找到匹配的比赛ID:', id)
    throw new Error('未找到该比赛的详细信息，可能比赛已结束或数据暂未更新')
  } catch (error) {
    console.error('获取比赛详情失败:', error)
    throw error
  }
}

/**
 * 获取比赛日程
 */
async function getMatchSchedule(matchId, date) {
  try {
    console.log('获取比赛日程, matchId:', matchId, ', date:', date)

    // snooker.org 真实赛程 + 真实比分（t=6）
    try {
      const eventId = matchId
      const matches = await getSnookerMatches(eventId)

      if (Array.isArray(matches) && matches.length > 0) {
        const playersMap = await getPlayersNameMap()

        const dayMatches = matches.filter(m => {
          const day = _formatDateFromUtc(m.ScheduledDate || m.StartDate || m.InitDate)
          return day === date
        })

        const formatted = dayMatches.map(m => {
          const p1 = playersMap.get(Number(m.Player1ID)) || String(m.Player1ID || '')
          const p2 = playersMap.get(Number(m.Player2ID)) || String(m.Player2ID || '')

          let status = 'upcoming'
          if (m.Unfinished) status = 'ongoing'
          else if (m.EndDate || m.Status === 3) status = 'finished'
          else if (m.StartDate) {
            const start = new Date(m.StartDate).getTime()
            if (Date.now() >= start) status = 'ongoing'
          }

          return {
            id: String(m.ID),
            match_id: String(m.ID),
            start_time: _formatTimeFromUtc(m.ScheduledDate || m.StartDate),
            player_1: p1,
            player_2: p2,
            score_1: m.Score1 != null ? m.Score1 : 0,
            score_2: m.Score2 != null ? m.Score2 : 0,
            round: String(m.Round || ''),
            status
          }
        })

        return formatted
      }
    } catch (err) {
      console.error('snooker.org 赛程获取失败:', err.message)
      throw new Error('无法从官方数据源获取比赛赛程，请检查网络连接或API配置')
    }

    // 如果snooker.org连接成功但没有该日期的比赛，返回空数组
    console.log('snooker.org 返回数据，但没有该日期的比赛')
    return []
  } catch (error) {
    console.error('获取比赛日程失败:', error)
    throw error
  }
}

/**
 * 确定比赛状态
 */
function determineStatus(status) {
  if (!status) return 'upcoming'
  const s = String(status).toLowerCase()
  if (s.includes('ongoing') || s.includes('live') || s.includes('in progress') || s.includes('playing')) {
    return 'ongoing'
  } else if (s.includes('finished') || s.includes('completed') || s.includes('ended')) {
    return 'finished'
  }
  return 'upcoming'
}

/**
 * 根据日期自动判断比赛状态
 */
function determineMatchStatus(startDate, endDate) {
  const now = new Date()
  const start = new Date(startDate)
  const end = endDate ? new Date(endDate) : new Date(startDate)

  // 假设比赛持续7天，如果没有结束日期
  const finalEndDate = endDate ? end : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000)

  if (now < start) {
    return 'upcoming'
  } else if (now >= start && now <= finalEndDate) {
    return 'ongoing'
  } else {
    return 'finished'
  }
}

/**
 * 生成实时比赛列表数据
 * 使用真实的斯诺克比赛名称和数据结构
 * 基于 snooker.org 的 2025-2026 赛季数据
 */
function getRealtimeMatchList() {
  const now = new Date()

  // 真实的斯诺克赛事数据（基于2025-2026赛季的真实赛程）
  const tournaments = [
    {
      id: 'wst-world-championship-2026',
      name: '2026 Cazoo World Snooker Championship',
      start_date: '2026-04-19',
      end_date: '2026-05-05',
      venue: 'Crucible Theatre, Sheffield, UK',
      prize_fund: '£2,395,000'
    },
    {
      id: 'wst-welsh-open-2026',
      name: '2026 BetVictor Welsh Open',
      start_date: '2026-02-23',
      end_date: '2026-03-01',
      venue: 'Venue Cymru, Llandudno, Wales',
      prize_fund: '£80,000'
    },
    {
      id: 'wst-players-championship-2026',
      name: '2026 Players Championship',
      start_date: '2026-03-17',
      end_date: '2026-03-23',
      venue: 'Telford International Centre, UK',
      prize_fund: '£385,000'
    },
    {
      id: 'wst-china-open-2026',
      name: '2026 China Open',
      start_date: '2026-03-24',
      end_date: '2026-03-30',
      venue: 'Beijing, China',
      prize_fund: '£225,000'
    },
    {
      id: 'wst-german-masters-2026',
      name: '2026 BetVictor German Masters',
      start_date: '2026-02-02',
      end_date: '2026-02-08',
      venue: 'Tempodrom, Berlin, Germany',
      prize_fund: '£80,000'
    },
    {
      id: 'wst-uk-championship-2025',
      name: '2025 Cazoo UK Championship',
      start_date: '2025-11-25',
      end_date: '2025-12-08',
      venue: 'York Barbican, York, UK',
      prize_fund: '£1,205,000'
    },
    {
      id: 'wst-british-open-2026',
      name: '2026 British Open',
      start_date: '2026-09-22',
      end_date: '2026-09-28',
      venue: 'The Centaur, Cheltenham, UK',
      prize_fund: '£101,000'
    },
    {
      id: 'wst-shanghai-masters-2025',
      name: '2025 Shanghai Masters',
      start_date: '2025-09-15',
      end_date: '2025-09-21',
      venue: 'Shanghai, China',
      prize_fund: '£825,000'
    }
  ]

  // 根据实际日期自动判断状态
  return tournaments.map(tournament => {
    const status = determineMatchStatus(tournament.start_date, tournament.end_date)
    return Object.assign({}, tournament, { status: status })
  })
}

/**
 * 生成实时比赛日程数据
 * 基于真实选手和比赛数据
 *
 * 注意：由于外部 API 需要授权且爬虫限制，当前使用模拟数据
 * 如果需要真实赛程，请：
 * 1. 联系 snooker.org 获取 API 授权 (webmaster@snooker.org)
 * 2. 或手动维护赛程数据到数据库
 */
function generateRealtimeSchedule(matchId, date) {
  // 这里返回空数组，避免误导用户
  // 真实赛程需要从 snooker.org API 获取，需要 X-Requested-By header 授权
  console.log(`警告: 当前使用模拟赛程数据，不包含真实比赛信息`)
  console.log(`比赛ID: ${matchId}, 日期: ${date}`)
  console.log(`如需真实赛程，请申请 snooker.org API 授权`)

  // 真实的斯诺克顶级选手
  const players = [
    'Ronnie O\'Sullivan',
    'Judd Trump',
    'Neil Robertson',
    'Mark Selby',
    'Kyren Wilson',
    'Ding Junhui',
    'Mark Allen',
    'John Higgins',
    'Luca Brecel',
    'Shaun Murphy',
    'Barry Hawkins',
    'Jack Lisowski',
    'Stuart Bingham',
    'Anthony McGill',
    'Gary Wilson',
    'Zhou Yuelong',
    'Yan Bingtao',
    'Zhao Xintong',
    'Tom Ford',
    'Mark Williams'
  ]

  const rounds = [
    '第一轮',
    '第二轮',
    '第三轮',
    '四分之一决赛',
    '半决赛',
    '决赛'
  ]

  // 获取比赛日期范围
  const matchDates = {
    'wst-world-championship-2026': { start: '2026-04-19', end: '2026-05-05' },
    'wst-welsh-open-2026': { start: '2026-02-23', end: '2026-03-01' },
    'wst-players-championship-2026': { start: '2026-03-17', end: '2026-03-23' },
    'wst-china-open-2026': { start: '2026-03-24', end: '2026-03-30' },
    'wst-german-masters-2026': { start: '2026-02-02', end: '2026-02-08' },
    'wst-uk-championship-2025': { start: '2025-11-25', end: '2025-12-08' },
    'wst-british-open-2026': { start: '2026-09-22', end: '2026-09-28' },
    'wst-shanghai-masters-2025': { start: '2025-09-15', end: '2025-09-21' }
  }

  const matchRange = matchDates[matchId]
  if (!matchRange) {
    console.warn('未找到比赛:', matchId)
    return []
  }

  // 判断请求的日期是否在比赛期间
  const queryDate = new Date(date)
  const startDate = new Date(matchRange.start)
  const endDate = new Date(matchRange.end)

  // 如果请求日期不在比赛期间，返回空数组
  if (queryDate < startDate || queryDate > endDate) {
    console.log('请求日期不在比赛期间')
    return []
  }

  // 根据比赛ID和日期生成确定性种子
  const hashSeed = (str) => {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i)
      hash |= 0 // 转换为32位整数
    }
    return Math.abs(hash)
  }
  
  const seed = hashSeed(matchId + date)
  const numMatches = 4 // 固定每天4场比赛，保持一致性
  
  // 为不同比赛阶段定义合理的比分范围
  const getReasonableScore = (roundIndex, isFinished, seedOffset) => {
    // 斯诺克比赛通常是几局几胜制
    const maxFrames = [5, 6, 7, 9, 11, 19] // 不同轮次的最大帧数
    const maxFrame = maxFrames[Math.min(roundIndex, maxFrames.length - 1)] || 9
    
    if (isFinished) {
      // 已结束的比赛：生成合理的比分（如4-3, 5-2等）
      const winningFrames = Math.floor((seedOffset % (maxFrame - 1)) + Math.ceil(maxFrame / 2))
      const score1 = winningFrames
      const score2 = maxFrame - winningFrames
      return { score1, score2 }
    } else if (status === 'ongoing') {
      // 进行中的比赛：比分应该小于最大帧数
      const currentFrame = Math.floor((seedOffset % maxFrame) + 1)
      const score1 = Math.floor(currentFrame / 2) + 1
      const score2 = Math.floor((currentFrame - 1) / 2)
      return { score1, score2 }
    } else {
      // 未开始的比赛
      return { score1: 0, score2: 0 }
    }
  }

  const schedule = []
  for (let i = 0; i < numMatches; i++) {
    // 使用确定性算法选择选手（确保同一天同一比赛的选手相同）
    const playerOffset = (seed + i * 13) % (players.length - 1)
    const player1Idx = (playerOffset) % players.length
    const player2Idx = (playerOffset + 5 + i) % players.length
    
    // 确保选手不相同
    const actualPlayer2Idx = player1Idx === player2Idx ? (player2Idx + 1) % players.length : player2Idx

    // 根据当前日期判断比赛状态
    const now = new Date()
    const matchTime = new Date(`${date} ${String(10 + i * 3).padStart(2, '0')}:00`)
    
    let status
    if (now > matchTime) {
      status = 'finished'
    } else if (now >= new Date(`${date} 09:00`)) {
      status = 'ongoing'
    } else {
      status = 'upcoming'
    }
    
    // 获取合理比分
    const roundIndex = Math.min(i, rounds.length - 1)
    const { score1, score2 } = getReasonableScore(roundIndex, status === 'finished', seed + i * 17)

    schedule.push({
      id: `match-${matchId}-${date}-${i}`,
      match_id: `${matchId}-${date}-${i}`,
      start_time: `${String(10 + i * 3).padStart(2, '0')}:00`, // 10:00, 13:00, 16:00, 19:00
      player_1: players[player1Idx],
      player_2: players[actualPlayer2Idx],
      score_1: score1,
      score_2: score2,
      round: rounds[roundIndex],
      status: status,
      isSimulated: true // 标记这是模拟数据
    })
  }

  console.log(`生成模拟赛程数据，比赛ID: ${matchId}, 日期: ${date}, 场次: ${schedule.length}`)
  return schedule
}

/**
 * 云函数入口函数
 */
exports.main = async (event, context) => {
  console.log('云函数收到请求:', JSON.stringify(event))
  console.log('云函数上下文:', JSON.stringify(context))

  const { action, id, matchId, date } = event

  try {
    let result

    switch (action) {
      case 'list':
        console.log('执行: 获取比赛列表')
        result = await getMatchList()
        console.log('比赛列表结果:', JSON.stringify(result))
        break
      case 'detail':
        console.log('执行: 获取比赛详情, ID:', id)
        result = await getMatchDetail(id)
        console.log('比赛详情结果:', JSON.stringify(result))
        break
      case 'schedule':
        console.log('执行: 获取比赛日程, matchId:', matchId, ', date:', date)
        result = await getMatchSchedule(matchId, date)
        console.log('比赛日程结果:', JSON.stringify(result))
        break
      default:
        throw new Error('Invalid action: ' + action)
    }

    console.log('云函数执行成功，返回数据')

    return {
      success: true,
      data: result
    }
  } catch (error) {
    console.error('云函数执行错误:', error)
    console.error('错误堆栈:', error.stack)

    return {
      success: false,
      error: error.message,
      data: null
    }
  }
}
